import { randomUUID } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ChannelError, type AuthorityContext } from '@abele/channel-protocol'
import type { DebuggerStartResult, DebuggerTarget } from '@abele/node-protocol'
import type { NodeCore } from '../index.js'
import { DapDebuggerBackend } from './dap-backend.js'
import type { DapSession } from './driver.js'
import type { JsLaunch } from './js-profile.js'

/** What starts a program under a debugger. The native JS profile in production; a scripted one
 * in tests. It refuses while no audited adapter is installed. */
export interface LaunchProfile {
  profiles(): { id: string; version: string; inspection: string }[]
  launch(
    config: JsLaunch,
    target: DebuggerTarget,
    sources: ReadonlyMap<string, string>
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
  conversation_id: string
  program: string
  argv: string[]
  sources: string[]
}

const RETAINED_OPERATIONS = 128

/** Starts a program of a chat's folder for its owner and puts every session of it under the shared
 * coordinator, which is also what records a run while a session has record points. The program
 * runs with the node's own Node, an empty environment and no shell; it waits on its first line. */
export class DebuggerLaunches {
  private readonly runs = new Set<LaunchedRun>()
  private readonly operations = new Map<string, Promise<DebuggerStartResult>>()
  constructor(
    private readonly core: NodeCore,
    private readonly profile: LaunchProfile
  ) {}

  profiles() {
    return this.core.debugger.enabled ? this.profile.profiles() : []
  }

  /** A retried operation answers with the program it already started, never a second one. */
  start(owner: AuthorityContext, p: StartParams): Promise<DebuggerStartResult> {
    const key = JSON.stringify([owner.installation_id, p.operation_id])
    const known = this.operations.get(key)
    if (known) return known
    const work = this.launch(p)
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

  private async launch(p: StartParams): Promise<DebuggerStartResult> {
    if (!this.profile.profiles().length) throw new ChannelError('debugger_profile_unavailable')
    const targets = this.core.resources.targets
    const root = targets.pathForSession(p.conversation_id)
    if (!root) throw new ChannelError('workspace_required')
    // Running a program in a folder is executing there: the same trust and grant an agent needs.
    targets.checkSession(p.conversation_id)
    const bound = targets.bound(p.conversation_id)
    const current = targets.currentTarget(p.conversation_id)
    if (!current) throw new ChannelError('workspace_required')
    const project_id =
      bound?.project_id ??
      this.core.resources.workspaces.get(this.core.session(p.conversation_id).workspace_id!)
        .project_id
    const program = this.inside(root, p.program)
    const sources = new Map<string, string>([['s1', program]])
    const asked = p.sources.map((path) => this.inside(root, path))
    // A source that is not what runs takes no breakpoints: it is left out, not the whole session.
    const unproven = await unbuilt(program, asked)
    for (const full of asked)
      if (!unproven.has(full) && ![...sources.values()].includes(full))
        sources.set(`s${sources.size + 1}`, full)
    const target: DebuggerTarget = {
      node_id: this.core.node_id,
      project_id,
      workspace_id: current.target.kind === 'workspace' ? current.target.workspace_id : null,
      worktree_id:
        current.target.kind === 'worktree'
          ? current.target.worktree_id
          : current.target.workspace_id,
      conversation_id: p.conversation_id,
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
    this.runs.add(run)
    const unregister: (() => void)[] = []
    const off = run.onSession((session) => {
      unregister.push(
        this.core.debuggerControl.registerBackend(
          session.id,
          new DapDebuggerBackend(session, run.terminate && (() => run.terminate!()))
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
      this.runs.delete(run)
      void run.close().catch((error) => console.debug('[debugger] Run cleanup failed', error))
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

  async close() {
    const outcomes = await Promise.allSettled([...this.runs].map((run) => run.close()))
    this.runs.clear()
    const failure = outcomes.find((o) => o.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
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
