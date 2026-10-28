import type { Readable, Writable } from 'node:stream'
import type { DebugProtocol } from '@vscode/debugprotocol'
import { debuggerLog } from './log.js'

export const DAP_LIMITS = Object.freeze({
  frameBytes: 1024 * 1024,
  headerBytes: 8192,
  pending: 64,
  reverse: 16,
  requestTimeoutMs: 10000,
  reverseTimeoutMs: 10000,
  frameTimeoutMs: 10000,
  writeBytes: 1024 * 1024,
})
export type DapOptions = {
  maxFrameBytes?: number
  maxPending?: number
  maxReverse?: number
  maxWriteBytes?: number
  requestTimeoutMs?: number
  reverseTimeoutMs?: number
  frameTimeoutMs?: number
  reverse?: (request: DebugProtocol.Request, signal: AbortSignal) => Promise<object>
}
type RequestOptions = { signal?: AbortSignal; timeoutMs?: number; beforeDispatch?: () => void }
type SlotWaiter = { dispatch: () => void; reject: (error: Error) => void }
type Pending = {
  command: string
  resolve: (body: any) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  removeAbort: () => void
}
const record = (value: unknown): value is Record<string, any> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const sequence = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/** Internal node-owned connection. No shell, public DAP endpoint, traffic logging,
 * or adapter-side client library. A failure settles every connection-owned wait. */
export class DapTransport {
  supportsCancellation = false
  private seq = 0
  private failure: Error | undefined
  private header = Buffer.alloc(0)
  private body: Buffer | undefined
  private filled = 0
  private frameTimer: ReturnType<typeof setTimeout> | undefined
  private readonly pending = new Map<number, Pending>()
  private readonly slotWaiters = new Set<SlotWaiter>()
  private readonly retired = new Map<number, string>()
  private retiredThrough = 0
  private readonly reverses = new Map<
    number,
    { controller: AbortController; timer: ReturnType<typeof setTimeout> }
  >()
  private readonly completedReverse = new Set<number>()
  private readonly events = new Set<(event: DebugProtocol.Event) => void>()
  private readonly closes = new Set<(error: Error) => void>()
  private readonly limits: Required<Omit<DapOptions, 'reverse'>>
  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly options: DapOptions = {}
  ) {
    this.limits = {
      maxFrameBytes: options.maxFrameBytes ?? DAP_LIMITS.frameBytes,
      maxPending: options.maxPending ?? DAP_LIMITS.pending,
      maxReverse: options.maxReverse ?? DAP_LIMITS.reverse,
      maxWriteBytes: options.maxWriteBytes ?? DAP_LIMITS.writeBytes,
      requestTimeoutMs: options.requestTimeoutMs ?? DAP_LIMITS.requestTimeoutMs,
      reverseTimeoutMs: options.reverseTimeoutMs ?? DAP_LIMITS.reverseTimeoutMs,
      frameTimeoutMs: options.frameTimeoutMs ?? DAP_LIMITS.frameTimeoutMs,
    }
    for (const value of Object.values(this.limits))
      if (!Number.isSafeInteger(value) || value < 1) throw new Error('dap_invalid_limit')
    input.on('data', this.data)
    input.on('end', this.eof)
    input.on('close', this.eof)
    input.on('error', this.streamError)
    output.on('error', this.streamError)
    output.on('close', this.eof)
  }
  setReverseHandler(handler: NonNullable<DapOptions['reverse']>) {
    if (this.options.reverse || this.reverses.size || this.closed)
      throw new Error('dap_reverse_handler_already_set')
    this.options.reverse = handler
  }
  get pendingCount() {
    return this.pending.size
  }
  get pendingLimit() {
    return this.limits.maxPending
  }
  get closed() {
    return !!this.failure
  }
  onEvent(listener: (event: DebugProtocol.Event) => void) {
    this.events.add(listener)
    return () => {
      this.events.delete(listener)
    }
  }
  onClose(listener: (error: Error) => void) {
    if (this.failure) listener(this.failure)
    else this.closes.add(listener)
    return () => {
      this.closes.delete(listener)
    }
  }
  /** Bounded FIFO admission for driver batches, not an unbounded request queue.
   * The deadline includes slot waiting. Admission is rechecked just before send. */
  requestWhenAvailable<T = Record<string, any>>(
    command: string,
    args: object = {},
    options: RequestOptions = {}
  ): Promise<T> {
    if (this.failure) return Promise.reject(this.failure)
    if (options.signal?.aborted) return Promise.reject(new Error('dap_cancelled'))
    if (!this.slotWaiters.size && this.pending.size < this.limits.maxPending)
      return this.request<T>(command, args, options)
    if (this.slotWaiters.size >= this.limits.maxPending)
      return Promise.reject(new Error('dap_queue_limit'))
    const timeout = options.timeoutMs ?? this.limits.requestTimeoutMs
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000)
      return Promise.reject(new Error('dap_invalid_timeout'))
    const deadline = Date.now() + timeout
    return new Promise<T>((resolve, reject) => {
      const cleanup = () => {
        this.slotWaiters.delete(waiter)
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', abort)
      }
      const waiter: SlotWaiter = {
        dispatch: () => {
          cleanup()
          const remaining = deadline - Date.now()
          if (remaining <= 0) reject(new Error('dap_slot_timeout'))
          else
            this.request<T>(command, args, { ...options, timeoutMs: remaining }).then(
              resolve,
              reject
            )
        },
        reject: (error) => {
          cleanup()
          reject(error)
        },
      }
      const abort = () => waiter.reject(new Error('dap_cancelled'))
      const timer = setTimeout(() => waiter.reject(new Error('dap_slot_timeout')), timeout)
      this.slotWaiters.add(waiter)
      options.signal?.addEventListener('abort', abort, { once: true })
      if (options.signal?.aborted) abort()
      this.drainSlots()
    })
  }
  private drainSlots() {
    while (!this.failure && this.pending.size < this.limits.maxPending && this.slotWaiters.size)
      this.slotWaiters.values().next().value!.dispatch()
  }
  request<T = Record<string, any>>(
    command: string,
    args: object = {},
    options: RequestOptions = {}
  ): Promise<T> {
    if (this.failure) return Promise.reject(this.failure)
    if (options.signal?.aborted) return Promise.reject(new Error('dap_cancelled'))
    if (this.pending.size >= this.limits.maxPending)
      return Promise.reject(new Error('dap_pending_limit'))
    const timeout = options.timeoutMs ?? this.limits.requestTimeoutMs
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000)
      return Promise.reject(new Error('dap_invalid_timeout'))
    try {
      options.beforeDispatch?.()
    } catch (error) {
      return Promise.reject(asError(error))
    }
    const seq = this.nextSeq()
    return new Promise<T>((resolve, reject) => {
      const finish = (error: Error) => {
        const pending = this.take(seq)
        pending?.reject(error)
      }
      const abort = () => {
        finish(new Error('dap_cancelled'))
        if (this.supportsCancellation && command !== 'cancel' && !this.closed)
          void this.request('cancel', { requestId: seq }).catch(() => {})
      }
      const timer = setTimeout(() => {
        debuggerLog('DAP request timed out', () => ({ command, timeout_ms: timeout }))
        finish(new Error('dap_timeout'))
      }, timeout)
      options.signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(seq, {
        command,
        resolve,
        reject,
        timer,
        removeAbort: () => options.signal?.removeEventListener('abort', abort),
      })
      try {
        this.write({ seq, type: 'request', command, arguments: args })
      } catch (error) {
        this.close(asError(error))
      }
    })
  }
  private take(seq: number) {
    const pending = this.pending.get(seq)
    if (!pending) return
    this.pending.delete(seq)
    clearTimeout(pending.timer)
    pending.removeAbort()
    this.retired.set(seq, pending.command)
    if (this.retired.size > 128) {
      const oldest = this.retired.keys().next().value!
      this.retiredThrough = Math.max(this.retiredThrough, oldest)
      this.retired.delete(oldest)
    }
    this.drainSlots()
    return pending
  }
  private nextSeq() {
    if (this.seq >= Number.MAX_SAFE_INTEGER) throw new Error('dap_sequence_exhausted')
    return ++this.seq
  }
  /** Release queued work before the owner's disconnect request. Late replies
   * remain correlated tombstones, so they cannot revive cancelled operations. */
  cancelPending() {
    const error = new Error('dap_cancelled')
    for (const waiter of this.slotWaiters) waiter.reject(error)
    for (const seq of this.pending.keys()) this.take(seq)?.reject(error)
  }
  private write(message: object) {
    if (this.failure) throw this.failure
    const body = Buffer.from(JSON.stringify(message))
    if (body.length > this.limits.maxFrameBytes) throw new Error('dap_frame_limit')
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`)
    if (this.output.writableLength + header.length + body.length > this.limits.maxWriteBytes)
      throw new Error('dap_backpressure')
    this.output.write(Buffer.concat([header, body]))
  }
  private readonly streamError = (error: Error) => this.close(error)
  private readonly eof = () => this.close(new Error('dap_eof'))
  private readonly data = (chunk: Buffer | string) => {
    if (this.failure) return
    try {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      let offset = 0
      while (offset < bytes.length && !this.failure) {
        if (!this.frameTimer)
          this.frameTimer = setTimeout(
            () => this.close(new Error('dap_frame_timeout')),
            this.limits.frameTimeoutMs
          )
        if (!this.body) {
          // Header is tiny and bounded. Do not retain a potentially enormous input
          // chunk or allocate the body until the Content-Length is validated.
          this.header = Buffer.concat([this.header, bytes.subarray(offset, ++offset)])
          if (this.header.length > DAP_LIMITS.headerBytes) throw new Error('dap_header_limit')
          if (!this.header.subarray(-4).equals(Buffer.from('\r\n\r\n'))) continue
          const lines = this.header.subarray(0, -4).toString('latin1').split('\r\n')
          const lengths = lines.filter((line) => /^Content-Length:/i.test(line))
          if (lengths.length !== 1 || !/^Content-Length: [1-9][0-9]*$/i.test(lengths[0]!))
            throw new Error('dap_header')
          if (lines.some((line) => !/^[A-Za-z-]+: [\x20-\x7e]+$/.test(line)))
            throw new Error('dap_header')
          const length = Number(lengths[0]!.split(': ')[1])
          if (!Number.isSafeInteger(length) || length > this.limits.maxFrameBytes)
            throw new Error('dap_frame_limit')
          this.body = Buffer.allocUnsafe(length)
          this.header = Buffer.alloc(0)
          this.filled = 0
        }
        const count = Math.min(bytes.length - offset, this.body.length - this.filled)
        bytes.copy(this.body, this.filled, offset, offset + count)
        offset += count
        this.filled += count
        if (this.filled !== this.body.length) continue
        let message: unknown
        try {
          message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.body))
        } catch {
          throw new Error('dap_json')
        }
        this.body = undefined
        this.filled = 0
        clearTimeout(this.frameTimer)
        this.frameTimer = undefined
        this.dispatch(message)
      }
    } catch (error) {
      this.close(asError(error))
    }
  }
  private dispatch(message: unknown) {
    if (!record(message) || !sequence(message.seq)) throw new Error('dap_message')
    if (message.type === 'event') {
      if (
        typeof message.event !== 'string' ||
        !message.event ||
        (message.body !== undefined && !record(message.body))
      )
        throw new Error('dap_message')
      for (const listener of this.events) listener(message as DebugProtocol.Event)
    } else if (message.type === 'response') {
      if (
        !sequence(message.request_seq) ||
        typeof message.command !== 'string' ||
        typeof message.success !== 'boolean' ||
        (message.body !== undefined && !record(message.body))
      )
        throw new Error('dap_message')
      const command =
        this.pending.get(message.request_seq)?.command ?? this.retired.get(message.request_seq)
      // Timeouts/cancellation do not retract a request from the wire. Keep late
      // replies inert after bounded tombstone eviction. Live requests still
      // require exact command correlation below.
      if (command === undefined && message.request_seq <= this.retiredThrough) return
      if (command !== message.command) throw new Error('dap_correlation')
      const pending = this.take(message.request_seq)
      if (!pending) return // bounded tombstones allow late timeout/cancellation replies
      if (message.success) pending.resolve(message.body ?? {})
      else
        pending.reject(
          new Error('dap_rejected:' + String(message.message ?? 'adapter_failure').slice(0, 256))
        )
    } else if (message.type === 'request') {
      if (
        typeof message.command !== 'string' ||
        !message.command ||
        (message.arguments !== undefined && !record(message.arguments))
      )
        throw new Error('dap_message')
      this.reverse(message as DebugProtocol.Request)
    } else throw new Error('dap_message')
  }
  private rememberReverse(seq: number) {
    this.completedReverse.add(seq)
    if (this.completedReverse.size > 128)
      this.completedReverse.delete(this.completedReverse.values().next().value!)
  }
  private reverse(request: DebugProtocol.Request) {
    // Active requests cannot be evicted by a flood of completed requests.
    if (this.reverses.has(request.seq) || this.completedReverse.has(request.seq))
      throw new Error('dap_duplicate_reverse')
    const reply = (success: boolean, body: object = {}) =>
      this.write({
        seq: this.nextSeq(),
        type: 'response',
        request_seq: request.seq,
        command: request.command,
        success,
        ...(success ? { body } : { message: 'reverse_request_denied' }),
      })
    if (!this.options.reverse || this.reverses.size >= this.limits.maxReverse) {
      this.rememberReverse(request.seq)
      reply(false)
      return
    }
    const controller = new AbortController()
    const complete = (success: boolean, body?: object) => {
      const active = this.reverses.get(request.seq)
      if (!active) return
      this.reverses.delete(request.seq)
      this.rememberReverse(request.seq)
      clearTimeout(active.timer)
      controller.abort()
      if (!this.failure) {
        try {
          reply(success, body)
        } catch (error) {
          this.close(asError(error))
        }
      }
    }
    const timer = setTimeout(() => complete(false), this.limits.reverseTimeoutMs)
    this.reverses.set(request.seq, { controller, timer })
    Promise.resolve()
      .then(() => {
        if (controller.signal.aborted) throw new Error('dap_cancelled')
        return this.options.reverse!(request, controller.signal)
      })
      .then(
        (body) => complete(true, body),
        () => complete(false)
      )
  }
  close(error = new Error('dap_closed')) {
    if (this.failure) return
    debuggerLog('Transport closing', () => ({
      reason: error.message,
      pending: [...this.pending.values()].map((p) => p.command),
      reverse_pending: this.reverses.size,
      partial_frame_bytes: this.filled,
    }))
    this.failure = error
    clearTimeout(this.frameTimer)
    this.frameTimer = undefined
    this.header = Buffer.alloc(0)
    this.body = undefined
    for (const seq of this.pending.keys()) this.take(seq)?.reject(error)
    for (const waiter of this.slotWaiters) waiter.reject(error)
    for (const reverse of this.reverses.values()) {
      clearTimeout(reverse.timer)
      reverse.controller.abort()
    }
    this.reverses.clear()
    this.retired.clear()
    this.completedReverse.clear()
    this.input.off('data', this.data)
    this.input.off('end', this.eof)
    // Retain error handlers until destroyed streams finish emitting their errors.
    this.input.destroy()
    this.output.destroy()
    for (const listener of this.closes) {
      try {
        listener(error)
      } catch {
        /* cleanup cannot depend on storage */
      }
    }
    this.events.clear()
    this.closes.clear()
  }
}
function asError(error: unknown) {
  return error instanceof Error ? error : new Error('dap_failure')
}
