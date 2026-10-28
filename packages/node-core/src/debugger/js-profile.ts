import { createConnection } from 'node:net'
import { ChannelError } from '@abele/channel-protocol'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import type { DebuggerTarget } from '@abele/node-protocol'
import { DebuggerService } from './index.js'
import { DapTransport } from './dap.js'
import { DapSession, JsSessionTree } from './driver.js'
import { OwnedDebugProcess, processStartIdentity } from './process.js'
import { installedJsAdapter, jsAdapterInstalled, requireJsPin } from './js-install.js'
import { debuggerLog } from './log.js'
import { holdJsStartup } from './js-startup.js'

export type JsLaunch = {
  cwd: string
  executable: string
  program: string
  argv: string[]
  env: Record<string, string>
  stop_on_entry?: boolean
  runtime_argv?: ('--test' | '--enable-source-maps' | '--test-concurrency=1')[]
}
export type JsAttach = { address: '127.0.0.1'; port: number; target_pid: number }
function exact(config: object, allowed: string[]) {
  if (
    !config ||
    typeof config !== 'object' ||
    Array.isArray(config) ||
    Object.keys(config).some((key) => !allowed.includes(key))
  )
    throw new Error('invalid_debugger_configuration')
}
async function confined(root: string, path: string) {
  if (typeof path !== 'string' || !isAbsolute(path))
    throw new Error('invalid_debugger_configuration')
  const physical = await realpath(path),
    rel = relative(root, physical)
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
    throw new Error('debugger_path_escape')
  return physical
}
export async function validateJsLaunch(config: JsLaunch): Promise<JsLaunch> {
  exact(config, ['cwd', 'executable', 'program', 'argv', 'env', 'runtime_argv', 'stop_on_entry'])
  if (
    (config.stop_on_entry !== undefined && typeof config.stop_on_entry !== 'boolean') ||
    typeof config.cwd !== 'string' ||
    typeof config.executable !== 'string' ||
    !isAbsolute(config.cwd) ||
    !isAbsolute(config.executable) ||
    !Array.isArray(config.argv) ||
    config.argv.length > 256 ||
    config.argv.some(
      (s) => typeof s !== 'string' || s.includes('\0') || Buffer.byteLength(s) > 8192
    ) ||
    !config.env ||
    typeof config.env !== 'object' ||
    Array.isArray(config.env) ||
    Object.keys(config.env).length > 256 ||
    Object.entries(config.env).some(
      ([key, value]) =>
        !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ||
        typeof value !== 'string' ||
        value.includes('\0') ||
        Buffer.byteLength(value) > 8192
    ) ||
    config.env.NODE_OPTIONS !== undefined ||
    (config.runtime_argv &&
      (!Array.isArray(config.runtime_argv) ||
        config.runtime_argv.length > 3 ||
        config.runtime_argv.some(
          (v) => !['--test', '--enable-source-maps', '--test-concurrency=1'].includes(v)
        )))
  )
    throw new Error('invalid_debugger_configuration')
  const cwd = await realpath(config.cwd),
    executable = await realpath(config.executable)
  // B2's audited native host runtime only; no silently installed interpreters,
  // package managers, arbitrary shell preparation, or VS Code tasks.
  if (executable !== (await realpath(process.execPath)))
    throw new Error('unsupported_debugger_runtime')
  return {
    ...config,
    cwd,
    executable,
    program: await confined(cwd, config.program),
    argv: [...config.argv],
    env: { ...config.env },
  }
}
export function validateJsAttach(config: JsAttach): JsAttach {
  exact(config, ['address', 'port', 'target_pid'])
  if (
    config.address !== '127.0.0.1' ||
    !Number.isInteger(config.port) ||
    config.port < 1 ||
    config.port > 65535 ||
    !Number.isSafeInteger(config.target_pid) ||
    config.target_pid < 1
  )
    throw new Error('invalid_debugger_configuration')
  return { ...config }
}
type ProfileOptions = {
  stateDirectory: string
  enabled?: boolean
  workspaceRoot?: string
  sources?: ReadonlyMap<string, string>
}

/** Native node-host profile, off by default AND hard-blocked by the source audit
 * pin. Reached only through the owner's start and attach (DebuggerLaunches), never tools. */
export class JsDebugProfile {
  private readonly runs = new Set<NativeJsRun>()
  constructor(
    private readonly service: DebuggerService,
    private readonly options: ProfileOptions
  ) {}
  profiles() {
    if (!this.service.enabled || !this.options.enabled) return []
    try {
      const pin = requireJsPin()
      if (!jsAdapterInstalled(this.options.stateDirectory)) return []
      return [{ id: 'js-ts-native', version: pin.version, inspection: 'explicit-only' }]
    } catch {
      return []
    }
  }
  private requireEnabled() {
    if (!this.service.enabled || !this.options.enabled) throw new Error('js_debug_disabled')
    this.service.assertEffectsAvailable()
    requireJsPin()
    if (!['darwin', 'linux'].includes(process.platform))
      throw new Error('unsupported_debugger_host')
  }
  private async sources(root?: string, program?: string, chosen?: ReadonlyMap<string, string>) {
    const sources = new Map(
      chosen ?? this.options.sources ?? (program ? [['program', program]] : [])
    )
    if (sources.size > 256) throw new Error('source_limit')
    if (sources.size && !root) throw new Error('debugger_workspace_required')
    const physical = root ? await realpath(root) : undefined
    for (const [id, path] of sources) {
      if (!id || id.length > 128) throw new Error('invalid_source_id')
      sources.set(id, await confined(physical!, path))
    }
    return sources
  }
  async launch(
    raw: JsLaunch,
    target: DebuggerTarget,
    chosen?: ReadonlyMap<string, string>
  ): Promise<NativeJsRun> {
    this.requireEnabled()
    const config = await validateJsLaunch(raw)
    const sources = await this.sources(config.cwd, config.program, chosen)
    this.service.assertEffectsAvailable()
    const owner = await OwnedDebugProcess.spawn(
      config.executable,
      ['--inspect-brk=127.0.0.1:0', ...(config.runtime_argv ?? []), config.program, ...config.argv],
      { cwd: config.cwd, env: config.env }
    )
    let programSession: DapSession | undefined
    owner.on('close', (diagnostics) => {
      debuggerLog('Program exited', () => ({ target: target.target_id, ...diagnostics }))
      try {
        if (Number.isSafeInteger(diagnostics.exit_code))
          programSession?.recordExit(diagnostics.exit_code)
      } catch (error) {
        debuggerLog('Program exit could not be recorded', () => ({
          target: target.target_id,
          reason: error instanceof Error ? error.message : 'unknown',
        }))
      }
    })
    try {
      const match = await owner.waitForText(/ws:\/\/127\.0\.0\.1:(\d+)\/[^\s]+/)
      const releaseStartup = await holdJsStartup(match[0])
      try {
        // Launch is node-owned spawning followed by attach, not adapter-spawned
        // process ownership inferred from a DAP process event or success response.
        const run = await this.open(
          {
            type: 'pwa-node',
            address: '127.0.0.1',
            port: Number(match[1]),
            cwd: config.cwd,
            sourceMaps: true,
            restart: false,
            continueOnAttach: false,
            // The pinned adapter otherwise injects its child bootloader through
            // Runtime.evaluate while --inspect-brk is entering the main script.
            // That races V8's startup pause (and can crash Node with SIGTRAP).
            // Native launch covers this program, not automatic child instrumentation.
            autoAttachChildProcesses: false,
          },
          { ...target, process_ownership: 'owned', process_evidence: owner.evidence },
          sources,
          owner
        )
        try {
          const session = await run.program()
          programSession = session
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => finish(new Error('debugger_startup_handoff_timeout')),
              10000
            )
            let offEvent = () => {},
              offClose = () => {}
            const finish = (error?: Error) => {
              clearTimeout(timer)
              offEvent()
              offClose()
              if (error) reject(error)
              else resolve()
            }
            offEvent = session.dap.onEvent((event) => {
              if (event.event === 'stopped') finish()
            })
            offClose = session.dap.onClose(() => finish(new Error('debugger_startup_handoff_lost')))
            if (session.snapshot.threads.some((t) => t.status === 'stopped')) finish()
          })
          session.markEntryPause()
          if (config.stop_on_entry === false) {
            releaseStartup()
            if (!session.snapshot.selected_thread_id) await session.threads()
            await session.continue(session.snapshot.selected_thread_id!)
          }
          return run
        } catch (error) {
          await run.close().catch(() => {})
          throw error
        }
      } finally {
        releaseStartup()
      }
    } catch (error) {
      await owner.terminate().catch(() => {})
      const message = error instanceof Error ? error.message : String(error)
      throw new ChannelError(error instanceof ChannelError ? error.code : message, message, {
        ...(error instanceof ChannelError ? error.details : {}),
        stderr: owner.diagnostics.stderr,
      })
    }
  }
  async attach(
    raw: JsAttach,
    target: DebuggerTarget,
    chosen?: ReadonlyMap<string, string>,
    root?: string
  ): Promise<NativeJsRun> {
    this.requireEnabled()
    const config = validateJsAttach(raw)
    // Explicit loopback endpoint selection + OS liveness. The endpoint-to-PID match is the
    // caller's (DebuggerLaunches reads the listening sockets from the OS); build identity is not.
    await processStartIdentity(config.target_pid)
    const sources = await this.sources(root ?? this.options.workspaceRoot, undefined, chosen)
    return this.open(
      {
        type: 'pwa-node',
        address: config.address,
        cwd: root ?? this.options.workspaceRoot,
        port: config.port,
        sourceMaps: true,
        restart: false,
        continueOnAttach: false,
      },
      {
        ...target,
        process_ownership: 'external',
        process_evidence: undefined,
        // Matched only where the caller proved the file unchanged since the process started.
        build_identity: target.build_identity === 'matched' ? 'matched' : 'unknown',
      },
      sources
    )
  }
  private async open(
    configuration: Record<string, unknown>,
    target: DebuggerTarget,
    sources: ReadonlyMap<string, string>,
    owner?: OwnedDebugProcess
  ): Promise<NativeJsRun> {
    const installed = await installedJsAdapter(this.options.stateDirectory)
    this.service.assertEffectsAvailable()
    const adapter = await OwnedDebugProcess.spawn(
      process.execPath,
      [installed.entry, '0', '127.0.0.1'],
      { env: {} }
    )
    let phase = 'starting'
    let sessionId: string | undefined
    debuggerLog('Adapter spawned', () => ({ pid: adapter.pid, phase }))
    adapter.on('close', (diagnostics) => {
      debuggerLog('Adapter exited', () => ({ session: sessionId, phase, ...diagnostics }))
    })
    let tree: JsSessionTree | undefined
    let rootDap: DapTransport | undefined
    try {
      const match = await adapter.waitForText(/listening at 127\.0\.0\.1:(\d+)/)
      phase = 'connecting'
      const port = Number(match[1])
      const connect = (signal?: AbortSignal) => connection(port, signal)
      // Reverse coverage is exact and one-level. It does not authorize terminals,
      // workers/forks, package-manager commands or arbitrary adapter defaults.
      this.service.assertEffectsAvailable()
      rootDap = await connect()
      const state = this.service.create({
        ...target,
        adapter_profile: 'js-ts-native',
        adapter_version: installed.version,
      })
      const root = new DapSession(this.service, state, rootDap, sources)
      sessionId = root.id
      phase = 'configuring'
      if (owner) root.setOwner(owner)
      tree = new JsSessionTree(this.service, root, connect, {
        mode: 'attach',
        configuration,
        maxChildren: 8,
      })
      rootDap.setReverseHandler((request, signal) => tree!.reverse(request, signal))
      await root.start('attach', configuration)
      phase = 'active'
      const run = new NativeJsRun(tree, adapter, owner, () => this.runs.delete(run))
      this.runs.add(run)
      return run
    } catch (error) {
      phase = 'startup-failed'
      debuggerLog('Adapter startup failed', () => ({
        session: sessionId,
        reason: error instanceof Error ? error.message : String(error),
        ...adapter.diagnostics,
      }))
      tree?.close()
      rootDap?.close()
      await adapter.terminate()
      throw error
    }
  }
  async close() {
    const outcomes = await Promise.allSettled([...this.runs].map((run) => run.close()))
    const failure = outcomes.find((outcome) => outcome.status === 'rejected')
    if (failure?.status === 'rejected') throw failure.reason
  }
}

function connection(port: number, signal?: AbortSignal): Promise<DapTransport> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const abort = () => finish(new Error('debugger_cancelled'))
    const timer = setTimeout(() => finish(new Error('debugger_connect_timeout')), 5000)
    const finish = (error?: Error) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
      socket.off('error', finish)
      socket.off('connect', connected)
      if (error) {
        socket.destroy()
        reject(error)
      } else resolve(new DapTransport(socket, socket))
    }
    const connected = () => finish()
    socket.once('connect', connected)
    socket.once('error', finish)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}
export class NativeJsRun {
  private detached = false
  private completion: Promise<void> | undefined
  constructor(
    readonly tree: JsSessionTree,
    private readonly adapter: OwnedDebugProcess,
    private readonly owner: OwnedDebugProcess | undefined,
    private readonly remove: () => void
  ) {}
  get root() {
    return this.tree.root
  }
  /** Every session of the run: the root at once, then each child as the adapter starts it. */
  onSession(listener: (session: DapSession) => void) {
    listener(this.tree.root)
    for (const child of this.tree.children.values()) listener(child)
    return this.tree.onChild(listener)
  }
  /** js-debug attaches to the program in a child of the root it was asked for: the first one. */
  program(timeout = 10000): Promise<DapSession> {
    const first = this.tree.children.values().next().value
    if (first) return first.ready().then(() => first)
    if (this.root.dap.closed) return Promise.reject(new Error('debugger_program_ended'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('debugger_program_not_attached')), timeout)
      const finish = (error?: Error, session?: DapSession) => {
        clearTimeout(timer)
        off()
        closed()
        if (session) session.ready().then(() => resolve(session), reject)
        else reject(error)
      }
      const off = this.tree.onChild((session) => finish(undefined, session))
      const closed = this.root.dap.onClose(() => finish(new Error('debugger_program_ended')))
    })
  }
  async detach() {
    this.detached = true // Never fall back to killing after an uncertain detach.
    try {
      await Promise.all(
        [...this.tree.children.values()].filter((s) => !s.dap.closed).map((s) => s.detach())
      )
      if (!this.tree.root.dap.closed) await this.tree.root.detach()
      if (this.owner && !this.owner.alive) throw new Error('detached_process_not_alive')
    } finally {
      await this.close()
    }
  }
  async terminate() {
    if (!this.owner) throw new Error('process_not_owned')
    try {
      // js-debug answers the root's disconnect only once its children are gone.
      await Promise.allSettled(
        [...this.tree.children.values()].filter((s) => !s.dap.closed).map((s) => s.detach())
      )
      if (!this.tree.root.dap.closed) await this.tree.root.terminate()
    } finally {
      await this.close()
    }
  }
  close(): Promise<void> {
    // Assign completion before invoking cleanup: synchronous close callbacks or
    // concurrent shutdown callers must observe the same eventual outcome.
    return (this.completion ??= Promise.resolve().then(() => this.cleanup()))
  }
  private async cleanup() {
    debuggerLog('Run cleanup', () => ({
      session: this.root.id,
      detached: this.detached,
      lifecycle: this.root.snapshot.lifecycle,
      ...this.adapter.diagnostics,
    }))
    try {
      try {
        this.tree.close()
      } finally {
        // Uncertain detach still relinquishes event-loop ownership, never kills.
        if (this.detached) this.owner?.release()
        else await this.owner?.terminate()
      }
    } finally {
      try {
        await this.adapter.terminate()
      } finally {
        this.remove()
      }
    }
  }
}
