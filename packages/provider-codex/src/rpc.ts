import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { systemProcessProbe } from '@abele/provider-claude'
import { CodexProcessInventory, CODEX_PROCESS_MARKER, newProcessMarker } from './processes.js'
import type { ProcessProbe, ProcessIdentity } from '@abele/provider-contract'
import type { CodexExecutable } from './discovery.js'
import { prepareWorkspaceTemp } from './temp.js'

const METHODS = new Set([
  'initialize',
  'config/read',
  'configRequirements/read',
  'experimentalFeature/list',
  'permissionProfile/list',
  'account/read',
  'model/list',
  'thread/start',
  'thread/resume',
  'thread/read',
  'turn/start',
  'turn/interrupt',
])
export class ServerRequestRejected extends Error {
  constructor(
    readonly code: number,
    reason: string
  ) {
    super(reason)
  }
}
export interface RpcMessage {
  id?: string | number
  method?: string
  params?: any
  result?: any
  error?: { code: number }
}
export class JsonlDecoder {
  private decoder = new TextDecoder('utf-8', { fatal: true })
  private pending = ''
  private bytes = 0
  constructor(
    private frameLimit = 512 * 1024,
    private totalLimit = 16 * 1024 * 1024
  ) {}
  push(bytes: Uint8Array): RpcMessage[] {
    this.bytes += bytes.length
    if (this.bytes > this.totalLimit) throw new Error('codex_output_limit')
    this.pending += this.decoder.decode(bytes, { stream: true })
    const records: RpcMessage[] = []
    let at: number
    while ((at = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, at)
      this.pending = this.pending.slice(at + 1)
      if (!line.trim() || Buffer.byteLength(line) > this.frameLimit)
        throw new Error('codex_frame_limit')
      const msg = JSON.parse(line)
      if (!msg || typeof msg !== 'object' || Array.isArray(msg))
        throw new Error('codex_invalid_frame')
      if (
        'id' in msg &&
        !(
          (typeof msg.id === 'string' && /^[A-Za-z0-9_:-]{1,256}$/.test(msg.id)) ||
          (Number.isSafeInteger(msg.id) && msg.id >= 0)
        )
      )
        throw new Error('codex_invalid_rpc_id')
      if (
        'method' in msg
          ? typeof msg.method !== 'string' ||
            msg.method.length < 1 ||
            msg.method.length > 256 ||
            'result' in msg ||
            'error' in msg
          : !('id' in msg) || 'result' in msg === 'error' in msg
      )
        throw new Error('codex_invalid_frame')
      if (
        'error' in msg &&
        (!msg.error || typeof msg.error !== 'object' || !Number.isSafeInteger(msg.error.code))
      )
        throw new Error('codex_invalid_error')
      records.push(msg)
    }
    if (Buffer.byteLength(this.pending) > this.frameLimit) throw new Error('codex_frame_limit')
    return records
  }
  end() {
    this.pending += this.decoder.decode()
    if (this.pending) throw new Error('codex_truncated_frame')
  }
}
export interface RpcOptions {
  executable: CodexExecutable
  cwd: string
  home: string
  configArgs?: string[]
  processes(evidence: ProcessIdentity[]): void
  notification?(msg: RpcMessage): void
  serverRequest?(msg: RpcMessage, signal: AbortSignal): Promise<unknown>
  probe?: ProcessProbe
  marker?: string
  timeoutMs?: number
}
export class RpcPeer {
  readonly child: ChildProcessWithoutNullStreams
  readonly signal: AbortSignal
  readonly lost: Promise<string>
  private abort = new AbortController()
  private probe: ProcessProbe
  private evidence: ProcessIdentity[] = []
  private inventory: CodexProcessInventory
  private sampler?: ReturnType<typeof setInterval>
  private pending = new Map<
    number,
    { resolve(value: any): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >()
  private seen = new Set<string>()
  private activeRequests = new Map<string, AbortController>()
  private next = 0
  private queued = 0
  private reason?: string
  private resolveLost!: (reason: string) => void
  private exited: Promise<void>
  private cleanup?: Promise<void>
  private constructor(private options: RpcOptions) {
    this.probe = options.probe ?? systemProcessProbe
    const marker = options.marker ?? newProcessMarker()
    this.inventory = new CodexProcessInventory(marker, options.processes, this.probe)
    this.signal = this.abort.signal
    this.lost = new Promise((r) => {
      this.resolveLost = r
    })
    const e = options.executable
    e.recheck()
    const args = [
      '--strict-config',
      ...(options.configArgs ?? []),
      '-c',
      `${'shell_environment_policy.set.' + CODEX_PROCESS_MARKER}=${JSON.stringify(marker)}`,
      '-C',
      options.cwd,
      'app-server',
      '--listen',
      'stdio://',
    ]
    this.child = spawn(
      e.interpreter ?? e.executable,
      e.interpreter ? [e.executable, ...args] : args,
      {
        detached: true,
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          HOME: options.home,
          CODEX_HOME: options.home,
          [CODEX_PROCESS_MARKER]: marker,
        },
      }
    )
    this.exited = new Promise((r) => {
      this.child.once('close', () => r())
      this.child.once('error', () => r())
    })
    const decoder = new JsonlDecoder()
    let stderrBytes = 0
    this.child.stderr.on('data', (b) => {
      if ((stderrBytes += b.length) > 1024 * 1024) this.fail('codex_diagnostic_limit')
    })
    this.child.stdout.on('data', (b) => {
      try {
        for (const msg of decoder.push(b)) this.receive(msg)
      } catch {
        this.fail('codex_invalid_or_unbounded_stream')
      }
    })
    this.child.once('error', () => this.fail('codex_spawn_failed'))
    this.child.once('close', () => {
      try {
        decoder.end()
      } catch {
        this.fail('codex_truncated_stream')
      }
      this.fail('codex_transport_closed')
    })
    this.child.stdin.on('error', () => this.fail('codex_write_failed'))
  }
  static async start(options: RpcOptions) {
    prepareWorkspaceTemp(options.cwd)
    const peer = new RpcPeer(options)
    try {
      for (let i = 0; i < 20 && !peer.evidence.length && !peer.reason; i++) {
        if (peer.child.pid) {
          const identity = peer.probe.identity(peer.child.pid)
          if (identity && identity.group === peer.child.pid) peer.evidence = [identity]
        }
        if (!peer.evidence.length) await new Promise((r) => setTimeout(r, 10))
      }
      if (!peer.evidence.length) throw new Error('codex_process_identity_unconfirmed')
      peer.inventory.add(peer.evidence)
      peer.sampler = setInterval(() => {
        try {
          peer.inventory.sample(peer.evidence[0]!)
        } catch {
          peer.fail('codex_process_inventory_unavailable')
        }
      }, 500)
      if (peer.reason) throw new Error(peer.reason)
      return peer
    } catch (error) {
      await peer.close()
      throw error
    }
  }
  private fail(reason: string) {
    if (this.reason) return
    this.reason = reason
    if (this.sampler) clearInterval(this.sampler)
    this.abort.abort()
    for (const slot of this.pending.values()) {
      clearTimeout(slot.timer)
      slot.reject(new Error(reason))
    }
    this.pending.clear()
    this.resolveLost(reason)
    queueMicrotask(() => {
      void this.close().catch(() => {})
    })
  }
  private receive(msg: RpcMessage) {
    if (this.reason) return
    if (msg.method) {
      if (msg.id !== undefined) {
        const key = `${typeof msg.id}:${msg.id}`
        if (this.seen.has(key) || this.seen.size >= 4096 || this.activeRequests.size >= 32)
          throw new Error('codex_duplicate_or_excess_requests')
        this.seen.add(key)
        const requestAbort = new AbortController()
        this.activeRequests.set(key, requestAbort)
        void (async () => {
          try {
            if (!this.options.serverRequest)
              await this.write({ id: msg.id, error: { code: -32601 } })
            else {
              const result = await this.options.serverRequest(
                msg,
                AbortSignal.any([this.signal, requestAbort.signal])
              )
              if (!this.signal.aborted && this.activeRequests.has(key))
                await this.write({ id: msg.id, result })
            }
          } catch (error) {
            if (
              error instanceof ServerRequestRejected &&
              !this.signal.aborted &&
              this.activeRequests.has(key)
            ) {
              try {
                await this.write({ id: msg.id, error: { code: error.code } })
              } catch {
                this.fail('codex_write_failed')
              }
            } else if (!(error instanceof ServerRequestRejected))
              this.fail('codex_server_request_failed')
          } finally {
            this.activeRequests.delete(key)
          }
        })()
      } else {
        if (msg.method === 'serverRequest/resolved') {
          const id = msg.params?.requestId
          const key = `${typeof id}:${id}`
          this.activeRequests.get(key)?.abort()
          this.activeRequests.delete(key)
        }
        this.options.notification?.(msg)
      }
    } else {
      if (typeof msg.id !== 'number') throw new Error('codex_unexpected_response')
      const slot = this.pending.get(msg.id)
      if (!slot) throw new Error('codex_unexpected_response')
      this.pending.delete(msg.id)
      clearTimeout(slot.timer)
      if (msg.error) slot.reject(new Error(`codex_rpc_error:${msg.error.code}`))
      else slot.resolve(msg.result)
    }
  }
  private write(msg: RpcMessage) {
    if (this.reason) return Promise.reject(new Error(this.reason))
    const line = JSON.stringify(msg) + '\n',
      size = Buffer.byteLength(line)
    if (size > 512 * 1024 || this.queued + size > 1024 * 1024) {
      this.fail('codex_write_limit')
      return Promise.reject(new Error('codex_write_limit'))
    }
    this.queued += size
    return new Promise<void>((resolve, reject) =>
      this.child.stdin.write(line, (error) => {
        this.queued -= size
        if (error) {
          this.fail('codex_write_failed')
          reject(new Error('codex_write_failed'))
        } else resolve()
      })
    )
  }
  request(method: string, params?: unknown): Promise<any> {
    if (!METHODS.has(method) || this.reason || this.pending.size >= 32)
      return Promise.reject(new Error('codex_request_forbidden'))
    const id = ++this.next
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail('codex_rpc_timeout'),
        this.options.timeoutMs ?? 10000
      )
      this.pending.set(id, { resolve, reject, timer })
      void this.write({ id, method, params }).catch(() => {})
    })
  }
  initialized() {
    return this.write({ method: 'initialized' })
  }
  close() {
    if (this.cleanup) return this.cleanup
    this.fail('codex_stopped')
    this.cleanup = (async () => {
      if (!this.evidence.length && this.child.pid) {
        const identity = this.probe.identity(this.child.pid)
        if (identity) this.evidence = [identity]
      }
      if (!this.evidence.length && this.child.pid && this.probe.identity(this.child.pid))
        throw new Error('process_cleanup_unconfirmed')
      if (this.evidence.length) {
        this.inventory.add(this.evidence)
        this.inventory.sample(this.evidence[0]!)
      }
      await this.inventory.cleanup()
      await Promise.race([
        this.exited,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('process_cleanup_unconfirmed')), 1000).unref()
        ),
      ])
    })().catch((error) => {
      this.cleanup = undefined
      throw error
    })
    return this.cleanup
  }
}
