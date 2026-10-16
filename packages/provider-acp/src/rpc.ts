// JSON-RPC 2.0 over newline-delimited stdio, the transport of the Agent Client Protocol.
// The node is the client: it sends requests to the agent and answers the agent's own requests.
import type { Readable, Writable } from 'node:stream'

export interface RpcError {
  code: number
  message: string
  data?: unknown
}
export class AcpRequestError extends Error {
  constructor(
    readonly method: string,
    readonly error: RpcError
  ) {
    super(`acp_request_failed: ${method}: ${error.code} ${String(error.message).slice(0, 256)}`)
  }
}
type Handler = (params: any) => Promise<unknown> | unknown
/** Thrown by a request handler to answer with a JSON-RPC error. */
export class RpcFault extends Error {
  constructor(
    readonly code: number,
    message: string
  ) {
    super(message)
  }
}
export const METHOD_NOT_FOUND = -32601

export class AcpConnection {
  private nextId = 1
  private pending = new Map<
    number,
    { method: string; resolve(v: any): void; reject(e: Error): void }
  >()
  private handlers = new Map<string, Handler>()
  private notifications = new Map<string, (params: any) => void>()
  private decoder = new TextDecoder('utf-8')
  private buffered = ''
  private closedWith?: Error
  constructor(
    input: Readable,
    private output: Writable,
    private frameLimit = 8 * 1024 * 1024
  ) {
    input.on('data', (chunk: Buffer) => this.push(chunk))
    input.on('end', () => this.close(new Error('acp_stream_closed')))
    input.on('error', () => this.close(new Error('acp_stream_closed')))
    output.on('error', () => this.close(new Error('acp_stream_closed')))
  }
  /** Answers one method the agent calls on the client. */
  handle(method: string, handler: Handler) {
    this.handlers.set(method, handler)
  }
  on(method: string, listener: (params: any) => void) {
    this.notifications.set(method, listener)
  }
  request<T = any>(method: string, params: unknown): Promise<T> {
    if (this.closedWith) return Promise.reject(this.closedWith)
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { method, resolve, reject })
      this.write({ jsonrpc: '2.0', id, method, params })
    })
  }
  notify(method: string, params: unknown) {
    if (!this.closedWith) this.write({ jsonrpc: '2.0', method, params })
  }
  get closed() {
    return !!this.closedWith
  }
  close(reason = new Error('acp_connection_closed')) {
    if (this.closedWith) return
    this.closedWith = reason
    for (const call of this.pending.values()) call.reject(reason)
    this.pending.clear()
  }
  private write(message: unknown) {
    try {
      this.output.write(JSON.stringify(message) + '\n')
    } catch {
      this.close(new Error('acp_stream_closed'))
    }
  }
  private push(chunk: Buffer) {
    this.buffered += this.decoder.decode(chunk, { stream: true })
    if (this.buffered.length > this.frameLimit && !this.buffered.includes('\n'))
      return this.close(new Error('acp_frame_limit'))
    let at: number
    while ((at = this.buffered.indexOf('\n')) >= 0) {
      const line = this.buffered.slice(0, at).trim()
      this.buffered = this.buffered.slice(at + 1)
      if (!line) continue
      let message: any
      try {
        message = JSON.parse(line)
      } catch {
        // Agents print banners and logs; only JSON objects are frames.
        continue
      }
      if (message && typeof message === 'object' && !Array.isArray(message)) this.dispatch(message)
    }
  }
  private dispatch(message: any) {
    const hasId = typeof message.id === 'number' || typeof message.id === 'string'
    if (typeof message.method === 'string') {
      if (!hasId) {
        try {
          this.notifications.get(message.method)?.(message.params)
        } catch {}
        return
      }
      const handler = this.handlers.get(message.method)
      if (!handler)
        return this.write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: METHOD_NOT_FOUND, message: 'Method not supported by this client' },
        })
      void (async () => {
        try {
          const result = await handler(message.params)
          this.write({ jsonrpc: '2.0', id: message.id, result: result ?? null })
        } catch (error) {
          this.write({
            jsonrpc: '2.0',
            id: message.id,
            error: {
              code: error instanceof RpcFault ? error.code : -32603,
              message: error instanceof Error ? error.message.slice(0, 256) : 'internal_error',
            },
          })
        }
      })()
      return
    }
    if (!hasId) return
    const call = this.pending.get(Number(message.id))
    if (!call) return
    this.pending.delete(Number(message.id))
    if (message.error && typeof message.error === 'object')
      call.reject(
        new AcpRequestError(call.method, {
          code: Number(message.error.code),
          message: String(message.error.message ?? ''),
          ...(message.error.data !== undefined ? { data: message.error.data } : {}),
        })
      )
    else call.resolve(message.result)
  }
}
