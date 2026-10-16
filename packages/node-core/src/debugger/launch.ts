import { randomUUID } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ChannelError, type AuthorityContext } from '@abele/channel-protocol'
import type {
  DebuggerProgram,
  DebuggerStartResult,
  DebuggerTarget,
  ExecutionTarget,
} from '@abele/node-protocol'
import type { NodeCore } from '../index.js'
import { DapDebuggerBackend } from './dap-backend.js'
import type { DapSession } from './driver.js'
import type { JsAttach, JsLaunch } from './js-profile.js'
import { inspectorPrograms, processStartedAt } from './programs.js'

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
  argv: string[]
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
  constructor(
    private readonly core: NodeCore,
    private readonly profile: LaunchProfile
  ) {
    core.db.exec(
      'CREATE TABLE IF NOT EXISTS debug_launches(debug_session_id TEXT PRIMARY KEY, body TEXT NOT NULL)'
    )
  }

  profiles() {
    return this.core.debugger.enabled ? this.profile.profiles() : []
  }

  /** A retried operation answers with the program it already started, never a second one. */
  start(owner: AuthorityContext, p: StartParams): Promise<DebuggerStartResult> {
    return this.once(owner, p.operation_id, () => this.remember('start', p))
  }

  /** Attaches to a running program: the same retry rule, a session under the same coordinator. */
  attach(owner: AuthorityContext, p: AttachParams): Promise<DebuggerStartResult> {
    return this.once(owner, p.operation_id, () => this.remember('attach', p))
  }

  private async remember(kind: 'start' | 'attach', params: StartParams | AttachParams) {
    const result =
      kind === 'start'
        ? await this.launch(params as StartParams)
        : await this.attachTo(params as AttachParams)
    const target = this.core.debugger.snapshot(result.debug_session_id).snapshot.target
    const folder: ExecutionTarget = target.workspace_id
      ? { kind: 'workspace', workspace_id: target.workspace_id }
      : { kind: 'worktree', worktree_id: target.worktree_id }
    this.core.db
      .prepare('INSERT OR REPLACE INTO debug_launches VALUES(?,?)')
      .run(result.debug_session_id, JSON.stringify({ kind, params: { ...params, folder } }))
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
        const requests = state.breakpoints.map(
          ({ status, resolved_line, resolved_column, message, ...request }) => request
        )
        this.core.debugger.patchBreakpoints(
          result.debug_session_id,
          next.breakpoint_revision,
          requests,
          []
        )
        await this.sessions.get(result.debug_session_id)?.syncBreakpoints()
      }
      return result
    })
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
    const { root, place } = await this.ownerFolder(p)
    const program = this.inside(root, p.program)
    const sources = new Map<string, string>([['s1', program]])
    const asked = p.sources.map((path) => this.inside(root, path))
    // A source that is not what runs takes no breakpoints: it is left out, not the whole session.
    const unproven = await unbuilt(program, asked)
    for (const full of asked)
      if (!unproven.has(full) && ![...sources.values()].includes(full))
        sources.set(`s${sources.size + 1}`, full)
    const target: DebuggerTarget = {
      ...place,
      target_id: randomUUID(),
      adapter_profile: 'js-ts-native',
      adapter_version: 'unknown',
      launch_configuration_id: p.program.slice(-128),
      process_ownership: 'owned',
      // Node runs a JavaScript file as it is on disk, so a line of it is the line that runs. Any
      // other source matches only through a source map of the build that is not older than it.
      build_identity: (await unbuilt(program, [program])).size ? 'unknown' : 'matched',
    }
    const run = await this.profile.launch(
      { cwd: root, executable: process.execPath, program, argv: p.argv, env: {} },
      target,
      sources
    )
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

  private async attachTo(p: AttachParams): Promise<DebuggerStartResult> {
    if (!this.profile.attach || !this.profile.profiles().length)
      throw new ChannelError('debugger_profile_unavailable')
    const { root, place } = await this.ownerFolder(p)
    // Only what is listening on loopback right now, as the OS says, under this very process: a
    // port named by the caller alone is never trusted to be the program it says.
    const program = (await inspectorPrograms()).find((x) => x.pid === p.pid && x.port === p.port)
    if (!program) throw new ChannelError('debugger_program_not_found')
    const inside = within(root, program.script) || within(root, program.cwd)
    // A program of another folder is the owner's to name: the chat's own trust does not reach it.
    if (!inside && !p.outside_folder) throw new ChannelError('debugger_attach_outside_folder')
    const sources = new Map<string, string>()
    if (program.script && within(root, program.script) && program.script !== root)
      sources.set('s1', program.script)
    const asked = p.sources.map((path) => this.inside(root, path))
    const unproven = await unbuilt(program.script ?? join(root, 'program.js'), asked)
    for (const full of asked)
      if (!unproven.has(full) && ![...sources.values()].includes(full))
        sources.set(`s${sources.size + 1}`, full)
    const target: DebuggerTarget = {
      ...place,
      target_id: randomUUID(),
      adapter_profile: 'js-ts-native',
      adapter_version: 'unknown',
      launch_configuration_id: `${basename(program.script ?? 'node')} · pid ${program.pid}`.slice(
        -128
      ),
      process_ownership: 'external',
      build_identity: (await loadedAsIs(program.pid, sources.get('s1'))) ? 'matched' : 'unknown',
    }
    const run = await this.profile.attach(
      { address: '127.0.0.1', port: program.port, target_pid: program.pid },
      target,
      sources,
      root
    )
    console.debug('[debugger] Attached', program.pid, program.port)
    return this.adopt(run, root, sources, false)
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
      this.sessions.set(session.id, session)
      this.sessionRuns.set(session.id, run)
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
        .threads()
        .catch((error) => console.debug('[debugger] Thread list not read', error))
        .finally(() => {
          asking = false
          // Changed again while it was asked: the answer was fenced off, so ask once more.
          if (session.snapshot.thread_inventory_revision !== revision) check()
        })
    }
    return this.core.debugger.subscribe(session.id, check)
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
    if (failure?.status === 'rejected') throw failure.reason
  }
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
 * only when a source map under the program's own folder lists it and carries its text or was
 * written after it last changed. */
async function unbuilt(program: string, sources: string[]) {
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
      } else if (entry.isFile() && entry.name.endsWith('.map')) await readMap(path)
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
        const source = resolve(base, name)
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
  await visit(dirname(program), 0)
  return pending
}
