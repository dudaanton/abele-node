import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

const MAX_FRAME = 2 * 1024 * 1024
type Pending = { resolve: (x: any) => void; reject: (e: Error) => void; cleanup: () => void }
/** Minimal LSP transport: byte framing, bidirectional requests, cancellation and bounded lifetime. */
export class LspConnection {
  readonly child: ChildProcessWithoutNullStreams
  private buffer = Buffer.alloc(0)
  private next = 0
  private pending = new Map<number, Pending>()
  private dead = false
  private stopping = false
  private closed: Promise<void>
  onNotification?: (method: string, params: any) => void
  onRequest?: (method: string, params: any) => unknown
  onExit?: () => void
  constructor(command: string, args: string[], cwd: string, memoryMB = 384) {
    this.child = spawn(command, args, {
      cwd,
      env: { ...process.env, NODE_OPTIONS: `--max-old-space-size=${memoryMB}` },
      stdio: 'pipe',
      detached: process.platform !== 'win32',
    })
    this.child.stderr.on('data', () => {})
    this.child.stdout.on('data', (d) => {
      try {
        this.buffer = Buffer.concat([this.buffer, d])
        for (;;) {
          const end = this.buffer.indexOf('\r\n\r\n')
          if (end < 0) {
            if (this.buffer.length > 8192) throw new Error('lsp_header_limit')
            break
          }
          const match = /^Content-Length:\s*(\d+)\s*$/im.exec(
            this.buffer.subarray(0, end).toString()
          )
          const size = match ? Number(match[1]) : NaN
          if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FRAME)
            throw new Error('lsp_frame_limit')
          if (this.buffer.length < end + 4 + size) break
          const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + size).toString())
          this.buffer = this.buffer.subarray(end + 4 + size)
          this.receive(message)
        }
      } catch (e) {
        this.fail(e as Error)
        this.kill('SIGKILL')
      }
    })
    this.child.stdin.on('error', (e) => this.fail(e))
    this.child.on('error', (e) => this.fail(e))
    this.closed = new Promise((resolve) =>
      this.child.once('close', () => {
        this.kill('SIGKILL')
        this.fail(new Error('lsp_exited'))
        if (!this.stopping) this.onExit?.()
        resolve()
      })
    )
  }
  private receive(m: any) {
    if (m.method && m.id !== undefined) {
      Promise.resolve()
        .then(() => this.onRequest?.(m.method, m.params) ?? null)
        .then(
          (result) => this.send({ jsonrpc: '2.0', id: m.id, result }),
          () =>
            this.send({
              jsonrpc: '2.0',
              id: m.id,
              error: { code: -32603, message: 'request_failed' },
            })
        )
        .catch(() => {})
    } else if (m.method) this.onNotification?.(m.method, m.params)
    else {
      const p = this.pending.get(m.id)
      if (!p) return
      this.pending.delete(m.id)
      p.cleanup()
      m.error ? p.reject(new Error(String(m.error.message ?? 'lsp_error'))) : p.resolve(m.result)
    }
  }
  private send(message: unknown) {
    if (this.dead) throw new Error('lsp_exited')
    const body = JSON.stringify(message)
    if (Buffer.byteLength(body) > MAX_FRAME) throw new Error('lsp_frame_limit')
    if (this.child.stdin.writableLength > MAX_FRAME) throw new Error('lsp_backpressure')
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }
  notify(method: string, params: unknown) {
    this.send({ jsonrpc: '2.0', method, params })
  }
  request(method: string, params: unknown, signal?: AbortSignal): Promise<any> {
    if (signal?.aborted) return Promise.reject(new Error('cancelled'))
    if (this.pending.size >= 64) return Promise.reject(new Error('lsp_busy'))
    return new Promise((resolve, reject) => {
      const id = ++this.next
      const cancel = (reason: string) => {
        if (!this.pending.delete(id)) return
        cleanup()
        try {
          this.notify('$/cancelRequest', { id })
        } catch {
          /* already exited */
        }
        reject(new Error(reason))
      }
      const abort = () => cancel('cancelled')
      const timer = setTimeout(() => cancel('lsp_timeout'), 15000)
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
      }
      this.pending.set(id, { resolve, reject, cleanup })
      signal?.addEventListener('abort', abort, { once: true })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (e) {
        this.pending.delete(id)
        cleanup()
        reject(e)
      }
    })
  }
  private fail(e: Error) {
    this.dead = true
    for (const p of this.pending.values()) {
      p.cleanup()
      p.reject(e)
    }
    this.pending.clear()
  }
  kill(signal: NodeJS.Signals = 'SIGKILL') {
    try {
      if (process.platform !== 'win32' && this.child.pid) process.kill(-this.child.pid, signal)
      else this.child.kill(signal)
    } catch {
      /* already reaped */
    }
  }
  async stop() {
    this.stopping = true
    if (!this.dead) {
      try {
        this.notify('exit', null)
      } catch {
        /* exited */
      }
    }
    this.kill('SIGTERM')
    const timer = setTimeout(() => this.kill('SIGKILL'), 250)
    await this.closed
    clearTimeout(timer)
  }
}
