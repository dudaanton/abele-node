import { EventEmitter } from 'node:events'
import { existsSync, watch } from 'node:fs'
import { fork, type ChildProcess } from 'node:child_process'
import { Socket } from 'node:net'

export interface WatchHandle extends EventEmitter {
  readonly ready: boolean
  close(): void
}
export type WatchFactory = (
  path: string,
  recursive: boolean,
  listener: (event: string, name: string | Buffer | null) => void
) => WatchHandle
type Entry = {
  id: number
  key: string
  ready: boolean
  failed: boolean
  leases: Set<WatchHandle>
  idle?: NodeJS.Timeout
  startup?: NodeJS.Timeout
}
type Options = {
  platform?: NodeJS.Platform
  idleMs?: number
  native?: WatchFactory
  /** Internal test seam: the factory is loaded only in the owning process. */
  factory?: URL
  state?: unknown
  startupTimeoutMs?: number
  diagnostic?: (event: Record<string, unknown>) => void
}

/** macOS FSEvents opens AND closes may synchronously wait on fseventsd. The
 * request loop owns logical leases only; one child process owns every native handle.
 * Linux retains its existing direct fs.watch lifecycle. */
export class WatchService {
  private owner?: ChildProcess
  private failOwner?: (reason: string) => void
  private readonly children = new Set<ChildProcess>()
  private shutdown?: Promise<void>
  private stopped = false
  private sequence = 0
  private readonly entries = new Map<string, Entry>()
  constructor(private readonly options: Options = {}) {}

  readonly watch: WatchFactory = (path, recursive, listener) => {
    if (this.stopped) throw new Error('watch_service_stopped')
    if ((this.options.platform ?? process.platform) !== 'darwin') {
      return (
        this.options.native?.(path, recursive, listener) ??
        Object.assign(
          recursive ? watch(path, { recursive: true }, listener) : watch(path, listener),
          { ready: true }
        )
      )
    }
    const key = JSON.stringify([path, recursive])
    let entry = this.entries.get(key)
    if (!entry || entry.failed) {
      if (entry) this.owner?.send!({ kind: 'close', id: entry.id })
      entry = { id: ++this.sequence, key, ready: false, failed: false, leases: new Set() }
      this.entries.set(key, entry)
      try {
        this.connection().send!({ kind: 'open', id: entry.id, path, recursive })
        const failed = this.failOwner!
        entry.startup = setTimeout(
          () => failed(`watch_owner_deadline path=${path} recursive=${recursive}`),
          this.options.startupTimeoutMs ?? 4000
        )
        entry.startup.unref()
      } catch (error) {
        this.entries.delete(key)
        throw error
      }
    }
    clearTimeout(entry.idle)
    entry.idle = undefined
    const owned = entry
    let closed = false
    const handle = Object.assign(new EventEmitter(), {
      ready: false,
      close: () => {
        if (closed) return
        closed = true
        owned.leases.delete(handle)
        handle.removeAllListeners()
        if (owned.leases.size || this.stopped) return
        owned.idle = setTimeout(() => {
          if (owned.leases.size || this.entries.get(key) !== owned) return
          this.entries.delete(key)
          clearTimeout(owned.startup)
          this.owner?.send!({ kind: 'close', id: owned.id })
        }, this.options.idleMs ?? 30000)
        owned.idle.unref()
      },
    })
    // Keep readiness live across the process handshake.
    Object.defineProperty(handle, 'ready', { get: () => owned.ready && !owned.failed && !closed })
    handle.on('change', listener)
    handle.on('error', () => {})
    owned.leases.add(handle)
    return handle
  }

  private connection() {
    if (this.owner) return this.owner
    const sibling = new URL('./watch-process.js', import.meta.url)
    const env = { ...process.env }
    delete env.NODE_OPTIONS
    const script = existsSync(sibling)
      ? sibling
      : new URL('../dist/watch-process.js', import.meta.url)
    const child = (this.owner = fork(script, [], {
      execArgv: [],
      env,
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    }))
    this.children.add(child)
    let stderr = ''
    let stage = 'spawn'
    const diagnostic = (event: Record<string, unknown>) =>
      this.options.diagnostic?.({ pid: child.pid, ...event })
    const failed = (reason: string) => {
      if (this.owner !== child) return
      this.owner = undefined
      const error = new Error(
        `${reason}; stage=${stage}; script=${script.href}; stderr=${stderr.trim()}`
      )
      diagnostic({ kind: 'error', error: error.message })
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      for (const entry of this.entries.values()) {
        clearTimeout(entry.startup)
        entry.failed = true
        entry.ready = false
        for (const handle of entry.leases) handle.emit('error', error)
      }
    }
    this.failOwner = failed
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-16384)
      diagnostic({ kind: 'stderr', text: chunk.toString() })
    })
    if (child.stderr instanceof Socket) child.stderr.unref()
    child.on('message', (message: any) => {
      if (this.owner !== child || this.stopped) return
      diagnostic(message)
      if (message.kind === 'started' || message.kind === 'opening') stage = JSON.stringify(message)
      if (message.kind === 'error' && message.id === undefined) {
        failed(`watch_owner_initialization: ${message.error}`)
        return
      }
      const entry = [...this.entries.values()].find((e) => e.id === message.id)
      if (!entry) return
      if (message.kind === 'ready' || message.kind === 'error') clearTimeout(entry.startup)
      if (message.kind === 'ready') entry.ready = true
      if (message.kind === 'error') {
        entry.failed = true
        entry.ready = false
      }
      for (const handle of entry.leases) {
        if (message.kind === 'change') handle.emit('change', message.event, message.name)
        else if (message.kind === 'ready') handle.emit('ready')
        else if (message.kind === 'error') handle.emit('error', new Error(message.error))
      }
    })
    child.on('error', (error) => failed(`watch_owner_spawn: ${error.message}`))
    // close follows stderr drain, unlike exit. Preserve the actual crash output.
    child.on('close', (code, signal) => {
      this.children.delete(child)
      diagnostic({ kind: 'exit', code, signal })
      failed(`watch_owner_exit code=${code} signal=${signal}`)
    })
    const parentExit = () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    process.once('exit', parentExit)
    child.once('close', () => process.off('exit', parentExit))
    child.unref()
    child.channel?.unref()
    diagnostic({ kind: 'spawn', script: script.href })
    // Install every listener before sending the first command.
    child.send!({ kind: 'init', factory: this.options.factory?.href, state: this.options.state })
    return child
  }

  stop(): Promise<void> {
    return (this.shutdown ??= this.close())
  }
  private async close() {
    this.stopped = true
    for (const entry of this.entries.values()) {
      clearTimeout(entry.idle)
      clearTimeout(entry.startup)
      entry.ready = false
      entry.failed = true
      for (const handle of entry.leases) handle.removeAllListeners()
    }
    this.entries.clear()
    this.owner = undefined
    await Promise.all(
      [...this.children].map(
        (child) =>
          new Promise<void>((resolve) => {
            // An awaited promise alone does not keep Node alive. Shutdown must
            // reap even an otherwise-unreferenced owner before it can complete.
            child.ref()
            child.once('close', () => resolve())
            // A direct, unreaped child cannot have its PID reused. SIGKILL avoids
            // waiting for a stuck FSEvents close in the child's native teardown.
            if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
          })
      )
    )
  }
}
