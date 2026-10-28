import { createHash, randomUUID } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ChannelError, type AuthorityContext } from '@abele/channel-protocol'
import type {
  DebuggerProgram,
  DebuggerAddSourcesResult,
  DebuggerStartResult,
  DebuggerTarget,
  DebuggerSnapshot,
  ExecutionTarget,
} from '@abele/node-protocol'
import type { NodeCore } from '../index.js'
import { DapDebuggerBackend } from './dap-backend.js'
import type { DapSession } from './driver.js'
import type { JsAttach, JsLaunch } from './js-profile.js'
import { inspectorPrograms, processStartedAt } from './programs.js'
import { discoverLaunchTargets, resolveNpmScript } from './launch-targets.js'
import {
  emptySourceEvidence,
  inlineSourceDigests,
  loadedSourceDigests,
  type LoadedSourceEvidence,
} from './loaded-sources.js'
import { processStartIdentity } from './process.js'

/** What starts a program under a debugger. The native JS profile in production; a scripted one
 * in tests. It refuses while no audited adapter is installed. */
export interface LaunchProfile {
  profiles(): { id: string; version: string; inspection: string }[]
  launch(
    config: JsLaunch,
    target: DebuggerTarget,
    sources: ReadonlyMap<string, string>
  ): Promise<LaunchedRun>
  /** Attaches to a program already running with its inspector on loopback; never owns it. */
  attach?(
    config: JsAttach,
    target: DebuggerTarget,
    sources: ReadonlyMap<string, string>,
    root: string
  ): Promise<LaunchedRun>
}
export interface LaunchedRun {
  readonly root: DapSession
  /** Every session of the run: the root at once, then each child as the adapter starts it. */
  onSession(listener: (session: DapSession) => void): () => void
  /** The session the program's own code runs in, when the adapter starts it under the root. */
  program?(): Promise<DapSession>
  /** Ends the program and every session of it: what stopping any of its sessions means. */
  terminate?(): Promise<void>
  close(): Promise<void>
}

type StartParams = {
  operation_id: string
  conversation_id?: string
  folder?: ExecutionTarget
  program: string
  npm_script?: string
  argv: string[]
  stop_on_entry?: boolean
  sources: string[]
}

type AttachParams = {
  operation_id: string
  conversation_id?: string
  folder?: ExecutionTarget
  pid: number
  port: number
  sources: string[]
  outside_folder: boolean
}

const RETAINED_OPERATIONS = 128
type SourceContext = {
  root: string
  program: string
  pid?: number
  port?: number
  processIdentity?: string
  sources: Map<string, string>
  digests: Map<string, string>
  candidates?: Map<string, string>
  inlineRuntime?: boolean
  recipe?: string
  tail?: Promise<unknown>
  pending: number
}

/** Whether `path` is `root` or under it. */
function within(root: string, path: string | null) {
  if (!path) return false
  const rel = relative(root, path)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel))
}

/** Starts a program of a chat's folder for its owner and puts every session of it under the shared
 * coordinator, which is also what records a run while a session has record points. The program
 * runs with the node's own Node, an empty environment and no shell; it waits on its first line. */
export class DebuggerLaunches {
  private readonly runs = new Set<LaunchedRun>()
  private readonly sessions = new Map<string, DapSession>()
  private readonly sessionRuns = new Map<string, LaunchedRun>()
  private readonly closing = new WeakMap<LaunchedRun, Promise<void>>()
  private readonly operations = new Map<string, Promise<DebuggerStartResult>>()
  private readonly attachments = new Map<string, Promise<DebuggerStartResult>>()
  private readonly sourceContexts = new WeakMap<LaunchedRun, SourceContext>()
  constructor(
    private readonly core: NodeCore,
    private readonly profile: LaunchProfile
  ) {
    core.db.exec(
      'CREATE TABLE IF NOT EXISTS debug_launches(debug_session_id TEXT PRIMARY KEY, body TEXT NOT NULL)'
    )
    core.db.exec(
      'CREATE TABLE IF NOT EXISTS debug_source_paths(debug_session_id TEXT PRIMARY KEY, body TEXT NOT NULL)'
    )
  }

  sources(session: string): { sources: DebuggerStartResult['sources'] } {
    const row = this.core.db
      .prepare('SELECT body FROM debug_source_paths WHERE debug_session_id=?')
      .get(session)
    if (row) return { sources: JSON.parse(String(row.body)) }
    const recipe = this.core.db
      .prepare('SELECT body FROM debug_launches WHERE debug_session_id=?')
      .get(session)
    return { sources: recipe ? (JSON.parse(String(recipe.body)).admitted ?? []) : [] }
  }

  reconcileSessions(snapshots: DebuggerSnapshot[]): DebuggerSnapshot[] {
    return snapshots.map((snapshot) => {
      if (
        snapshot.target.process_ownership !== 'external' ||
        !['detached', 'connection-lost'].includes(snapshot.lifecycle)
      )
        return snapshot
      const row = this.core.db
        .prepare('SELECT body FROM debug_launches WHERE debug_session_id=?')
        .get(snapshot.debug_session_id)
      const recipe = row && JSON.parse(String(row.body))
      const pid = recipe?.kind === 'attach' ? recipe.params?.pid : undefined
      if (!Number.isSafeInteger(pid) || pid < 1) return snapshot
      let exited = this.core.debugger.exitInfo(snapshot.debug_session_id).exit_code !== null
      if (!exited) {
        try {
          process.kill(pid, 0)
        } catch (error) {
          exited = (error as NodeJS.ErrnoException).code === 'ESRCH'
        }
      }
      return exited
        ? this.core.debugger.confirmProcessExit(snapshot.debug_session_id, snapshot.incarnation)
        : snapshot
    })
  }

  private rememberSources(session: string, root: string, sources: ReadonlyMap<string, string>) {
    this.core.db
      .prepare('INSERT OR REPLACE INTO debug_source_paths VALUES(?,?)')
      .run(
        session,
        JSON.stringify(
          [...sources].map(([source_id, path]) => ({ source_id, path: relative(root, path) }))
        )
      )
  }

  profiles() {
    return this.core.debugger.enabled ? this.profile.profiles() : []
  }
  async owningSessions(project: string, pids: number[]): Promise<string[]> {
    const matches: string[] = []
    for (const [id, session] of this.sessions) {
      const run = this.sessionRuns.get(id)
      const context = run && this.sourceContexts.get(run)
      const state = session.snapshot
      if (
        !context?.pid ||
        !context.processIdentity ||
        context.recipe !== id ||
        state.target.project_id !== project ||
        !['active', 'configuring'].includes(state.lifecycle) ||
        !pids.includes(context.pid)
      )
        continue
      const current = await processStartIdentity(context.pid).catch(() => undefined)
      const now = session.snapshot
      if (
        current === context.processIdentity &&
        this.sessions.get(id) === session &&
        now.incarnation === state.incarnation &&
        ['active', 'configuring'].includes(now.lifecycle)
      )
        matches.push(id)
    }
    return matches.sort()
  }

  /** A retried operation answers with the program it already started, never a second one. */
  start(owner: AuthorityContext, p: StartParams): Promise<DebuggerStartResult> {
    return this.once(owner, p.operation_id, () => this.remember('start', p))
  }

  /** Attaches to a running program: the same retry rule, a session under the same coordinator. */
  attach(owner: AuthorityContext, p: AttachParams): Promise<DebuggerStartResult> {
    return this.once(owner, p.operation_id, () => this.remember('attach', p))
  }

  async addSources(p: {
    operation_id: string
    debug_session_id: string
    sources: string[]
    require_loaded?: boolean
  }): Promise<DebuggerAddSourcesResult> {
    const run = this.sessionRuns.get(p.debug_session_id)
    const context = run && this.sourceContexts.get(run)
    if (!context || !context.recipe) throw new ChannelError('debugger_configuration_unavailable')
    if (context.pending >= 128) throw new ChannelError('debugger_busy')
    context.pending++
    const work = (context.tail ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const row = this.core.db
          .prepare('SELECT body FROM debug_launches WHERE debug_session_id=?')
          .get(context.recipe!)
        if (!row) throw new ChannelError('debugger_configuration_unavailable')
        const recipe = JSON.parse(String(row.body))
        const { root } = await this.ownerFolder(recipe.params)
        if ((await realpath(root)) !== context.root)
          throw new ChannelError('debugger_owner_mismatch')
        const state = this.core.debugger.snapshot(p.debug_session_id).snapshot
        if (
          this.sessions.get(p.debug_session_id)?.dap.closed ||
          !['active', 'configuring'].includes(state.lifecycle)
        )
          throw new ChannelError('debugger_session_inactive')
        const next = new Map(context.sources)
        const candidates = new Map(context.candidates)
        const digests = new Map(context.digests)
        const knownProgram =
          context.digests.has(context.program) && !context.candidates?.has(context.program)
        // Modules may have loaded since attach. Refresh only under the same OS
        // process identity; a reused inspector port must never prove this run.
        let runtime =
          context.port &&
          context.pid &&
          context.processIdentity &&
          (await processStartIdentity(context.pid).catch(() => undefined)) ===
            context.processIdentity
            ? await loadedSourceDigests(
                context.port,
                root,
                this.sessions.get(p.debug_session_id)?.closedSignal
              )
            : emptySourceEvidence()
        if (
          context.pid &&
          context.processIdentity &&
          (await processStartIdentity(context.pid).catch(() => undefined)) !==
            context.processIdentity
        )
          runtime = emptySourceEvidence()
        for (const [path, digest] of runtime) digests.set(path, digest)
        const result = await admitSources(
          context.root,
          next,
          p.sources,
          context.pid,
          context.program,
          digests,
          context.inlineRuntime ? { runtime, candidates } : undefined
        )
        if (p.require_loaded) {
          const accepted: typeof result.sources = []
          for (const source of result.sources) {
            const path = next.get(source.source_id)!
            const evidence = await this.sessions.get(p.debug_session_id)!.runtimeSource(path)
            if (evidence === 'loaded') accepted.push(source)
            else {
              result.refused.push({ path: source.path, code: `debugger_source_${evidence}` })
              if (!context.sources.has(source.source_id)) next.delete(source.source_id)
            }
          }
          result.sources = accepted
        }
        // Filesystem checks yield: recheck permission and lifetime before publishing any additions.
        await this.ownerFolder(recipe.params)
        const current = this.core.debugger.snapshot(p.debug_session_id).snapshot
        if (
          current.incarnation !== state.incarnation ||
          !['active', 'configuring'].includes(current.lifecycle)
        )
          throw new ChannelError('debugger_session_inactive')
        recipe.params.sources = [...next.values()].map((path) => relative(root, path))
        recipe.admitted = [...next].map(([source_id, path]) => ({
          source_id,
          path: relative(root, path),
        }))
        this.core.db
          .prepare('UPDATE debug_launches SET body=? WHERE debug_session_id=?')
          .run(JSON.stringify(recipe), context.recipe!)
        for (const [id, path] of next) context.sources.set(id, path)
        for (const source of result.sources) {
          const path = next.get(source.source_id)!
          const digest = digests.get(path)
          if (digest) context.digests.set(path, digest)
          if (runtime.mapped.has(path)) context.candidates?.delete(path)
          else if (candidates.has(path)) context.candidates?.set(path, candidates.get(path)!)
        }
        const programProven = result.sources.some(
          (s) =>
            runtime.has(next.get(s.source_id)!) ||
            (knownProgram && next.get(s.source_id) === context.program)
        )
        for (const [id, owner] of this.sessionRuns) {
          if (owner !== run) continue
          this.sessions.get(id)?.admitSources(next)
          this.rememberSources(id, root, next)
          if (programProven) {
            const snapshot = this.core.debugger.snapshot(id).snapshot
            if (snapshot.target.build_identity !== 'matched')
              this.core.debugger.observe(id, snapshot.incarnation, {
                kind: 'build_identity',
                build_identity: 'matched',
              })
          }
        }
        return { incarnation: state.incarnation, ...result }
      })
    context.tail = work
    try {
      return await work
    } finally {
      context.pending--
    }
  }

  private async remember(kind: 'start' | 'attach', params: StartParams | AttachParams) {
    const result =
      kind === 'start'
        ? await this.launch(params as StartParams)
        : await this.attachTo(params as AttachParams)
    // A second attach must not replace the original run's restart recipe.
    if (
      kind === 'attach' &&
      this.core.db
        .prepare('SELECT 1 FROM debug_launches WHERE debug_session_id=?')
        .get(result.debug_session_id)
    )
      return result
    const target = this.core.debugger.snapshot(result.debug_session_id).snapshot.target
    const folder: ExecutionTarget = target.workspace_id
      ? { kind: 'workspace', workspace_id: target.workspace_id }
      : { kind: 'worktree', worktree_id: target.worktree_id }
    const run = this.sessionRuns.get(result.debug_session_id)
    const context = run && this.sourceContexts.get(run)
    this.core.db.prepare('INSERT OR REPLACE INTO debug_launches VALUES(?,?)').run(
      result.debug_session_id,
      JSON.stringify({
        kind,
        params: { ...params, folder },
        admitted: result.sources,
        program_path: context?.program,
      })
    )
    if (context) context.recipe = result.debug_session_id
    return result
  }

  /** A fresh adapter incarnation, using the retained recipe rather than a dead backend. */
  restart(owner: AuthorityContext, p: { operation_id: string; debug_session_id: string }) {
    return this.once(owner, p.operation_id, async () => {
      const state = this.core.debugger.snapshot(p.debug_session_id).snapshot
      if (!['terminated', 'detached', 'failed', 'connection-lost'].includes(state.lifecycle))
        throw new ChannelError('debugger_session_active')
      const row = this.core.db
        .prepare('SELECT body FROM debug_launches WHERE debug_session_id=?')
        .get(p.debug_session_id)
      if (!row) throw new ChannelError('debugger_configuration_unavailable')
      const recipe = JSON.parse(String(row.body))
      const previous = this.sessionRuns.get(p.debug_session_id)
      if (previous) await this.closeRun(previous)
      const result = await this.remember(recipe.kind, recipe.params)
      if (state.breakpoints.length) {
        const next = this.core.debugger.snapshot(result.debug_session_id).snapshot
        const requests = state.breakpoints.flatMap(
          ({ status, resolved_line, resolved_column, message, ...request }) => {
            const path = recipe.admitted?.find(
              (s: { source_id: string }) => s.source_id === request.source_id
            )?.path
            const source_id =
              path === undefined
                ? request.source_id
                : result.sources.find((s) => s.path === path)?.source_id
            return source_id ? [{ ...request, source_id }] : []
          }
        )
        this.core.debugger.patchBreakpoints(
          result.debug_session_id,
          next.breakpoint_revision,
          requests,
          []
        )
        this.restoreRecordPoints(p.debug_session_id, result.debug_session_id, requests)
        await this.sessions.get(result.debug_session_id)?.syncBreakpoints()
      }
      return result
    })
  }
  private restoreRecordPoints(from: string, to: string, breakpoints: { breakpoint_id: string }[]) {
    const ids = new Set(breakpoints.map((point) => point.breakpoint_id))
    const points = this.core.trace.points.list(from).filter((point) => ids.has(point.breakpoint_id))
    if (points.length) this.core.trace.points.set(to, points, [])
  }

  private once(
    owner: AuthorityContext,
    operation: string,
    run: () => Promise<DebuggerStartResult>
  ): Promise<DebuggerStartResult> {
    const key = JSON.stringify([owner.installation_id, operation])
    const known = this.operations.get(key)
    if (known) return known
    const work = run()
    this.operations.set(key, work)
    work.catch(() => this.operations.delete(key))
    while (this.operations.size > RETAINED_OPERATIONS)
      this.operations.delete(this.operations.keys().next().value!)
    return work
  }

  private inside(root: string, path: string) {
    const full = resolve(root, path)
    const rel = relative(root, full)
    if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
      throw new ChannelError('debugger_path_escape')
    return full
  }

  /** The chat's folder and where it sits, once the chat may execute there. */
  private chatFolder(conversation_id: string) {
    const targets = this.core.resources.targets
    const root = targets.pathForSession(conversation_id)
    if (!root) throw new ChannelError('workspace_required')
    // Running a program in a folder is executing there: the same trust and grant an agent needs.
    targets.checkSession(conversation_id)
    const bound = targets.bound(conversation_id)
    const current = targets.currentTarget(conversation_id)
    if (!current) throw new ChannelError('workspace_required')
    const project_id =
      bound?.project_id ??
      this.core.resources.workspaces.get(this.core.session(conversation_id).workspace_id!)
        .project_id
    const place = {
      node_id: this.core.node_id,
      project_id,
      workspace_id: current.target.kind === 'workspace' ? current.target.workspace_id : null,
      worktree_id:
        current.target.kind === 'worktree'
          ? current.target.worktree_id
          : current.target.workspace_id,
      conversation_id,
    }
    return { root, place }
  }

  private async ownerFolder(p: { conversation_id?: string; folder?: ExecutionTarget }) {
    if (!p.folder) {
      if (!p.conversation_id) throw new ChannelError('workspace_required')
      return this.chatFolder(p.conversation_id)
    }
    const binding = await this.core.resources.targets.resolve(p.folder)
    this.core.resources.targets.check(binding)
    const place = {
      node_id: this.core.node_id,
      project_id: binding.project_id,
      workspace_id: p.folder.kind === 'workspace' ? p.folder.workspace_id : null,
      worktree_id: p.folder.kind === 'worktree' ? p.folder.worktree_id : p.folder.workspace_id,
      conversation_id: p.conversation_id ?? null,
    }
    if (p.conversation_id) {
      const chat = this.chatFolder(p.conversation_id)
      if (chat.root !== binding.path || chat.place.worktree_id !== place.worktree_id)
        throw new ChannelError('debugger_owner_mismatch')
    }
    return { root: binding.path, place }
  }

  private async launch(p: StartParams): Promise<DebuggerStartResult> {
    if (!this.profile.profiles().length) throw new ChannelError('debugger_profile_unavailable')
    const folder = await this.ownerFolder(p)
    const root = await realpath(folder.root),
      place = folder.place
    const resolved =
      p.npm_script === undefined
        ? { program: p.program, argv: p.argv }
        : await resolveNpmScript(root, p.program, p.npm_script, p.argv)
    const askedProgram = this.inside(root, resolved.program)
    const program = await realpath(askedProgram).catch((error: NodeJS.ErrnoException) => {
      throw new ChannelError(
        error.code === 'ENOENT' || error.code === 'ENOTDIR'
          ? 'debugger_program_not_found'
          : 'debugger_program_unavailable'
      )
    })
    if (!within(root, program)) throw new ChannelError('debugger_path_escape')
    const info = await stat(program).catch(() => {
      throw new ChannelError('debugger_program_unavailable')
    })
    if (!info.isFile()) throw new ChannelError('debugger_program_not_found')
    const sources = new Map<string, string>([['s1', program]])
    for (const path of p.sources) this.inside(root, path)
    await admitSources(root, sources, p.sources)
    const target: DebuggerTarget = {
      ...place,
      target_id: randomUUID(),
      adapter_profile: 'js-ts-native',
      adapter_version: 'unknown',
      launch_configuration_id: p.program.slice(-128),
      process_ownership: 'owned',
      // Node runs a JavaScript file as it is on disk, so a line of it is the line that runs. Any
      // other source matches only through a source map of the build that is not older than it.
      build_identity: (await unbuilt(root, [program])).size ? 'unknown' : 'matched',
    }
    const digests = await sourceDigests(sources)
    const run = await this.profile.launch(
      {
        cwd: root,
        executable: process.execPath,
        program,
        argv: resolved.argv,
        env: {},
        ...(p.stop_on_entry === undefined ? {} : { stop_on_entry: p.stop_on_entry }),
      },
      target,
      sources
    )
    const evidence = run.root.snapshot.target.process_evidence
    this.sourceContexts.set(run, {
      root,
      program,
      sources,
      digests,
      pending: 0,
      ...(evidence ? { pid: evidence.pid, processIdentity: evidence.start_identity } : {}),
    })
    return this.adopt(run, root, sources, true)
  }

  /** The Node.js programs waiting for a debugger on this machine, as seen from a chat: which of
   * them run from its folder, and which registered project folder each of the others is in. */
  async programs(
    owner: string | { conversation_id?: string; folder?: ExecutionTarget }
  ): Promise<{ programs: DebuggerProgram[] }> {
    const { root } = await this.ownerFolder(
      typeof owner === 'string' ? { conversation_id: owner } : owner
    )
    const projects = this.core.db
      .prepare('SELECT project_id, root_path FROM projects WHERE registered=1')
      .all()
      .map((r) => ({ project_id: String(r.project_id), path: String(r.root_path) }))
      // The deepest folder first: a project inside another one is the closer answer.
      .sort((a, b) => b.path.length - a.path.length)
    const found = await inspectorPrograms()
    return {
      programs: found.slice(0, 256).map((x) => ({
        ...x,
        command: x.command.slice(0, 256),
        project: projects.find((f) => within(f.path, x.script) || within(f.path, x.cwd)) ?? null,
        in_chat_folder: !!root && (within(root, x.script) || within(root, x.cwd)),
      })),
    }
  }

  async launchTargets(p: { conversation_id?: string; folder?: ExecutionTarget }) {
    const { root } = await this.ownerFolder(p)
    const result = await discoverLaunchTargets(root)
    await this.ownerFolder(p)
    return result
  }

  private async attachTo(p: AttachParams): Promise<DebuggerStartResult> {
    if (!this.profile.attach || !this.profile.profiles().length)
      throw new ChannelError('debugger_profile_unavailable')
    const folder = await this.ownerFolder(p)
    const root = await realpath(folder.root),
      place = folder.place
    const program = (await inspectorPrograms()).find((x) => x.pid === p.pid && x.port === p.port)
    if (!program) throw new ChannelError('debugger_program_not_found')
    const key = `${root}\0${p.pid}\0${p.port}\0${program.script}`
    const existing = this.attachments.get(key)
    if (existing) {
      const result = await existing
      if (this.attachments.get(key) !== existing) return this.attachTo(p)
      const state = this.core.debugger.snapshot(result.debug_session_id).snapshot
      if (!['detached', 'terminated', 'failed', 'connection-lost'].includes(state.lifecycle)) {
        const run = this.sessionRuns.get(result.debug_session_id)
        const context = run && this.sourceContexts.get(run)
        return context
          ? {
              ...result,
              sources: [...context.sources].map(([source_id, path]) => ({
                source_id,
                path: relative(root, path),
              })),
            }
          : result
      }
    }
    const pending = this.attachProgram(p, root, place)
    this.attachments.set(key, pending)
    try {
      const result = await pending
      this.sessionRuns.get(result.debug_session_id)?.root.dap.onClose(() => {
        if (this.attachments.get(key) === pending) this.attachments.delete(key)
      })
      return result
    } catch (error) {
      if (this.attachments.get(key) === pending) this.attachments.delete(key)
      throw error
    }
  }

  private async attachProgram(
    p: AttachParams,
    root: string,
    place: Awaited<ReturnType<DebuggerLaunches['ownerFolder']>>['place']
  ): Promise<DebuggerStartResult> {
    // Only what is listening on loopback right now, as the OS says, under this very process: a
    // port named by the caller alone is never trusted to be the program it says.
    const identityBefore = await processStartIdentity(p.pid).catch(() => undefined)
    const program = (await inspectorPrograms()).find((x) => x.pid === p.pid && x.port === p.port)
    if (!program) throw new ChannelError('debugger_program_not_found')
    const inside = within(root, program.script) || within(root, program.cwd)
    // A program of another folder is the owner's to name: the chat's own trust does not reach it.
    if (!inside && !p.outside_folder) throw new ChannelError('debugger_attach_outside_folder')
    const sources = new Map<string, string>()
    const loaded = await loadedSourceDigests(program.port, root)
    const candidates = new Map<string, string>()
    const script = program.script ? await realpath(program.script).catch(() => null) : null
    const programPath = script ?? join(root, 'program.js')
    // Restore intent only from an ended attachment to this exact script and owner scope.
    // PID/port are transient; source ids belong to each adapter and must be remapped by path.
    const retained = script
      ? (this.core.db
          .prepare(
            `
      SELECT l.body AS recipe, d.body AS snapshot FROM debug_launches l
      JOIN debug_sessions d USING(debug_session_id)
      WHERE json_extract(l.body,'$.kind')='attach'
        AND json_extract(l.body,'$.program_path')=?
        AND json_extract(d.body,'$.target.project_id')=?
        AND json_extract(d.body,'$.target.worktree_id')=?
        AND json_extract(d.body,'$.target.conversation_id') IS ?
        AND json_extract(d.body,'$.lifecycle') IN ('detached','terminated','failed','connection-lost')
      ORDER BY d.rowid DESC LIMIT 1
    `
          )
          .get(script, place.project_id, place.worktree_id, place.conversation_id) as
          { recipe: string; snapshot: string } | undefined)
      : undefined
    const previous = (retained && JSON.parse(retained.recipe)) as
      { admitted: DebuggerStartResult['sources'] } | undefined
    for (const path of p.sources) this.inside(root, path)
    await admitSources(
      root,
      sources,
      [
        ...(script && within(root, script) ? [relative(root, script)] : []),
        ...p.sources,
        ...(previous?.admitted ?? []).map((s: { path: string }) => s.path),
      ],
      program.pid,
      script ?? undefined,
      new Map(loaded),
      loaded.mapped.size ? { runtime: loaded, candidates } : undefined
    )
    const target: DebuggerTarget = {
      ...place,
      target_id: randomUUID(),
      adapter_profile: 'js-ts-native',
      adapter_version: 'unknown',
      launch_configuration_id: `${basename(program.script ?? 'node')} · pid ${program.pid}`.slice(
        -128
      ),
      process_ownership: 'external',
      build_identity:
        [...sources.values()].some((path) => loaded.has(path)) ||
        (await loadedAsIs(program.pid, sources.get('s1')))
          ? 'matched'
          : 'unknown',
    }
    const digests = new Map([...(await sourceDigests(sources)), ...loaded])
    const run = await this.profile.attach!(
      { address: '127.0.0.1', port: program.port, target_pid: program.pid },
      target,
      sources,
      root
    )
    console.debug('[debugger] Attached', program.pid, program.port)
    const identityAfter = await processStartIdentity(program.pid).catch(() => undefined)
    this.sourceContexts.set(run, {
      root,
      program: programPath,
      pid: program.pid,
      port: program.port,
      processIdentity:
        identityBefore && identityBefore === identityAfter ? identityBefore : undefined,
      sources,
      digests,
      candidates,
      inlineRuntime: loaded.mapped.size > 0,
      pending: 0,
    })
    const result = await this.adopt(run, root, sources, false)
    try {
      if (retained) {
        const old = JSON.parse(retained.snapshot) as DebuggerSnapshot
        const requests = old.breakpoints.flatMap(
          ({ status, resolved_line, resolved_column, message, ...request }) => {
            const path = previous!.admitted.find((s) => s.source_id === request.source_id)?.path
            const source_id = result.sources.find((s) => s.path === path)?.source_id
            return source_id ? [{ ...request, source_id }] : []
          }
        )
        if (requests.length) {
          const next = this.core.debugger.snapshot(result.debug_session_id).snapshot
          this.core.debugger.patchBreakpoints(
            result.debug_session_id,
            next.breakpoint_revision,
            requests,
            []
          )
          this.restoreRecordPoints(old.debug_session_id, result.debug_session_id, requests)
          await this.sessions.get(result.debug_session_id)?.syncBreakpoints()
        }
      }
      return result
    } catch (error) {
      await this.closeRun(run).catch(() => {})
      throw error
    }
  }

  /** Puts every session of a run under the coordinator until its root connection ends. A run the
   * node does not own is never stopped from here: ending its session detaches. */
  private async adopt(
    run: LaunchedRun,
    root: string,
    sources: ReadonlyMap<string, string>,
    owned: boolean
  ): Promise<DebuggerStartResult> {
    this.runs.add(run)
    const unregister: (() => void)[] = []
    const off = run.onSession((session) => {
      const context = this.sourceContexts.get(run)
      if (context) session.admitSources(context.sources)
      this.rememberSources(session.id, root, context?.sources ?? sources)
      session.validateSource = async (path) => {
        const digest = context?.digests.get(path)
        if (!digest || digest !== (await sourceDigest(path).catch(() => undefined)))
          throw new ChannelError('debugger_source_changed')
      }
      session.provisionalSource = (path) => context?.candidates?.has(path) ?? false
      session.verifyBreakpointSource = async (path) => {
        if (!context?.candidates?.has(path)) return
        const expected = context.candidates.get(path)!
        if (expected !== (await sourceDigest(path)))
          throw new ChannelError('debugger_source_changed')
        if (
          !context.port ||
          !context.pid ||
          !context.processIdentity ||
          (await processStartIdentity(context.pid).catch(() => undefined)) !==
            context.processIdentity
        )
          throw new ChannelError('debugger_source_unverified')
        const runtime = await loadedSourceDigests(context.port, root, session.closedSignal)
        if (
          (await processStartIdentity(context.pid).catch(() => undefined)) !==
          context.processIdentity
        )
          throw new ChannelError('debugger_source_unverified')
        const actual = runtime.get(path)
        if (!actual)
          throw new ChannelError(
            runtime.scripts.has(path) ? 'debugger_source_no_map' : 'debugger_source_pending'
          )
        if (actual !== expected) throw new ChannelError('debugger_source_changed')
        context.digests.set(path, actual)
        context.candidates.delete(path)
      }
      this.sessions.set(session.id, session)
      this.sessionRuns.set(session.id, run)
      session.resolveFrameSources = async (paths) => {
        const context = this.sourceContexts.get(run)
        if (!context?.recipe) return new Map()
        const candidates = paths.filter((path) => within(root, path) && isAbsolute(path))
        if (!candidates.length) return new Map()
        const result = await this.addSources({
          operation_id: randomUUID(),
          debug_session_id: session.id,
          sources: candidates.map((path) => relative(root, path)),
        })
        const admitted = new Map(
          result.sources.map((source) => [resolve(root, source.path), source])
        )
        const canonical = await Promise.all(
          candidates.map((path) => realpath(path).catch(() => undefined))
        )
        return new Map(
          candidates.flatMap((path, i) => {
            const source = canonical[i] && admitted.get(canonical[i]!)
            return source ? [[path, source] as const] : []
          })
        )
      }
      unregister.push(() => this.sessions.delete(session.id))
      unregister.push(
        this.core.debuggerControl.registerBackend(
          session.id,
          new DapDebuggerBackend(
            session,
            owned && run.terminate ? () => run.terminate!() : undefined
          )
        ),
        this.keepThreads(session)
      )
    })
    let ended = false
    const end = () => {
      if (ended) return
      ended = true
      off()
      for (const u of unregister.splice(0)) u()
      void this.closeRun(run).catch((error) =>
        console.debug('[debugger] Run cleanup failed', error)
      )
    }
    // The run ends with its root connection: the program exited, was stopped or the adapter went.
    run.root.dap.onClose(end)
    if (run.root.dap.closed) end()
    let session = run.root
    try {
      if (run.program) session = await run.program()
    } catch (error) {
      end()
      throw error
    }
    const paths = new Map([...sources].map(([id, full]) => [id, relative(root, full)]))
    return {
      debug_session_id: session.id,
      sources: [...paths].map(([source_id, path]) => ({ source_id, path })),
    }
  }

  /** js-debug says only which thread stopped, never whether the others did, so a session reads as
   * paused only once it has the full list: asked again whenever a thread starts, stops or goes. */
  private keepThreads(session: DapSession) {
    let asking = false
    const check = () => {
      const s = session.snapshot
      if (asking || session.dap.closed || s.thread_inventory === 'complete' || !s.threads.length)
        return
      if (['terminated', 'detached', 'failed', 'connection-lost'].includes(s.lifecycle)) return
      asking = true
      const revision = s.thread_inventory_revision
      session
        .refreshThreads()
        .catch((error) => console.debug('[debugger] Thread list not read', error))
        .finally(() => {
          asking = false
          // Changed again while it was asked: the answer was fenced off, so ask once more.
          if (!session.dap.closed && session.snapshot.thread_inventory_revision !== revision)
            check()
        })
    }
    const unsubscribe = this.core.debugger.subscribe(session.id, check)
    // Native startup may already have handed its first pause to the adapter
    // before this run is adopted. Do not wait for a later event to read it.
    check()
    return unsubscribe
  }

  private closeRun(run: LaunchedRun): Promise<void> {
    const known = this.closing.get(run)
    if (known) return known
    // Publish before invoking close: closing the root can synchronously reenter end().
    const work = Promise.resolve()
      .then(() => run.close())
      .then(() => {
        this.runs.delete(run)
        for (const [id, owner] of this.sessionRuns) if (owner === run) this.sessionRuns.delete(id)
      })
    this.closing.set(run, work)
    return work
  }

  async close() {
    const outcomes = await Promise.allSettled([...this.runs].map((run) => this.closeRun(run)))
    const failure = outcomes.find((o) => o.status === 'rejected')
    this.attachments.clear()
    if (failure?.status === 'rejected') throw failure.reason
  }
}

/** One admission policy for startup, attach and files opened later. Paths returned to the
 * owner are canonical folder-relative paths; symlink aliases share a source id. */
async function sourceDigest(path: string) {
  const info = await stat(path)
  if (info.size > MAP_SCAN.bytes) return undefined
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

async function sourceDigests(sources: ReadonlyMap<string, string>) {
  const digests = new Map<string, string>()
  for (const path of sources.values()) {
    const digest = await sourceDigest(path)
    if (digest) digests.set(path, digest)
  }
  return digests
}

async function admitSources(
  root: string,
  admitted: Map<string, string>,
  asked: string[],
  pid?: number,
  program?: string,
  digests?: Map<string, string>,
  provisional?: { runtime: LoadedSourceEvidence; candidates: Map<string, string> }
): Promise<Pick<DebuggerAddSourcesResult, 'sources' | 'refused'>> {
  const sources: DebuggerAddSourcesResult['sources'] = []
  const refused: DebuggerAddSourcesResult['refused'] = []
  const started = pid === undefined ? undefined : await processStartedAt(pid)
  for (const path of asked) {
    const refuse = (code: string) => refused.push({ path, code })
    const lexical = resolve(root, path)
    if (/^([\\/]|[A-Za-z]:)/.test(path) || !within(root, lexical) || lexical === root) {
      refuse('debugger_source_outside_folder')
      continue
    }
    const full = await realpath(lexical).catch(() => undefined)
    if (!full) {
      refuse('debugger_source_unavailable')
      continue
    }
    if (!within(root, full) || full === root) {
      refuse('debugger_source_outside_folder')
      continue
    }
    const info = await stat(full).catch(() => undefined)
    if (!info?.isFile()) {
      refuse('debugger_source_unavailable')
      continue
    }
    const local = relative(root, full).split(sep).join('/')
    if (/\.d\.[cm]?ts$/.test(local)) {
      refuse('debugger_source_declaration')
      continue
    }
    if (/(^|\/)(__tests__|tests?|spec)(\/|$)|\.(test|spec)\.[^.]+$/.test(local)) {
      refuse('debugger_source_test')
      continue
    }
    if (
      full !== program &&
      /(^|\/)(dist|build|generated)(\/|$)|\.(generated|gen)\.[^.]+$/.test(local)
    ) {
      refuse('debugger_source_generated')
      continue
    }
    const digest = await sourceDigest(full)
    if (
      provisional?.candidates.has(full) &&
      provisional.runtime.scripts.has(full) &&
      !provisional.runtime.mapped.has(full)
    ) {
      refuse('debugger_source_no_map')
      continue
    }
    const known = digests?.get(full)
    if (known && known !== digest) {
      refuse('debugger_source_changed')
      continue
    }
    const mapped = !/\.[cm]?js$/.test(full) && !(await unbuilt(root, [full])).size
    const candidate =
      !known &&
      !mapped &&
      !!digest &&
      !!provisional &&
      !provisional.runtime.scripts.has(full) &&
      /\.[cm]?tsx?$/.test(full)
    if (!known && !mapped && !candidate && !/\.[cm]?js$/.test(full)) {
      refuse('debugger_source_no_map')
      continue
    }
    if (
      !known &&
      pid !== undefined &&
      !mapped &&
      !candidate &&
      (!started || Math.floor(info.mtimeMs / 1000) * 1000 >= started)
    ) {
      refuse('debugger_source_changed')
      continue
    }
    let source_id = [...admitted].find(([, existing]) => existing === full)?.[0]
    if (!source_id) {
      if (admitted.size >= 256) {
        refuse('debugger_source_limit')
        continue
      }
      let index = admitted.size + 1
      while (admitted.has(`s${index}`)) index++
      source_id = `s${index}`
      admitted.set(source_id, full)
    }
    sources.push({ source_id, path: relative(root, full) })
    if (candidate) provisional!.candidates.set(full, digest!)
    if (digest) digests?.set(full, digest)
  }
  return { sources, refused }
}

/** Whether the program's own file is what it runs: JavaScript not changed since the process
 * started. A file edited after that is not the code in memory, and its lines would lie. */
async function loadedAsIs(pid: number, script: string | undefined) {
  if (!script || !/\.[cm]?js$/.test(script)) return false
  const [started, info] = await Promise.all([
    processStartedAt(pid),
    stat(script).catch(() => undefined),
  ])
  // The start is known to the second only: a file changed within that second does not count.
  return !!started && !!info && Math.floor(info.mtimeMs / 1000) * 1000 < started
}

const MAP_SCAN = { entries: 4096, depth: 8, bytes: 8 * 1024 * 1024 }

/** The sources that are not proven to be what runs. JavaScript is, as it is on disk; anything else
 * only when a source map under the registered folder lists it and carries its text or was
 * written after it last changed. */
async function unbuilt(root: string, sources: string[]) {
  const pending = new Set(sources.filter((path) => !/\.[cm]?js$/.test(path)))
  if (!pending.size) return pending
  let budget = MAP_SCAN.entries
  const visit = async (dir: string, depth: number): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!pending.size || --budget < 0) return
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < MAP_SCAN.depth && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
          await visit(path, depth + 1)
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.map')) await readMap(path)
        else if (/\.[cm]?js$/.test(entry.name)) {
          try {
            if ((await stat(path)).size > MAP_SCAN.bytes) continue
            const digests = await inlineSourceDigests(root, path, await readFile(path, 'utf8'))
            for (const [source, digest] of digests)
              if (pending.has(source) && digest === (await sourceDigest(source)))
                pending.delete(source)
          } catch {
            // An unreadable transform proves nothing.
          }
        }
      }
    }
  }
  const readMap = async (path: string) => {
    try {
      const info = await stat(path)
      if (info.size > MAP_SCAN.bytes) return
      const map = JSON.parse(await readFile(path, 'utf8'))
      if (!Array.isArray(map.sources)) return
      const base = resolve(dirname(path), typeof map.sourceRoot === 'string' ? map.sourceRoot : '')
      for (const [i, name] of map.sources.entries()) {
        if (typeof name !== 'string') continue
        const source = await realpath(resolve(base, name)).catch(() => undefined)
        if (!source) continue
        if (!pending.has(source)) continue
        const text = Array.isArray(map.sourcesContent) ? map.sourcesContent[i] : undefined
        const fresh =
          typeof text === 'string'
            ? text === (await readFile(source, 'utf8'))
            : info.mtimeMs >= (await stat(source)).mtimeMs
        if (fresh) pending.delete(source)
      }
    } catch {
      // An unreadable map proves nothing.
    }
  }
  await visit(root, 0)
  return pending
}
