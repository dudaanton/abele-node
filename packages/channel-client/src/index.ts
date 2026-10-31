import {
  FrameCodec,
  LOCAL_PROOF_PROFILE,
  localTokenHash,
  localSelector,
  localTranscript,
  verifyLocalBootstrap,
  randomNonce,
  verifyProof,
  LIMITS,
  ChannelError,
  assertLocalEndpoint,
  type ChannelConnector,
  type AuthenticatedChannel,
  type NodeConnection,
  type RecordTransport,
  type RecordFrame,
} from '@abele/channel-protocol'

/** Shared bounded receive queue for transport adapters. No runtime-specific imports. */
export class RecordQueue implements AsyncIterable<Uint8Array> {
  private queue: Uint8Array[] = []
  private bytes = 0
  private waiters: Array<(value: IteratorResult<Uint8Array>) => void> = []
  private ended = false
  push(value: Uint8Array) {
    if (this.ended) return
    if (
      value.byteLength > LIMITS.record_bytes ||
      this.bytes + value.byteLength > LIMITS.unacked_bytes
    )
      throw new ChannelError('slow_consumer')
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else {
      this.queue.push(value)
      this.bytes += value.byteLength
    }
  }
  end() {
    this.ended = true
    this.queue = []
    this.bytes = 0
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true })
  }
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
    return {
      next: () => {
        const value = this.queue.shift()
        if (value) {
          this.bytes -= value.byteLength
          return Promise.resolve({ value, done: false })
        }
        if (this.ended) return Promise.resolve({ value: undefined, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}
export class BrowserRecordTransport implements RecordTransport {
  readonly queue = new RecordQueue()
  constructor(private ws: WebSocket) {
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (event) => {
      try {
        if (!(event.data instanceof ArrayBuffer)) throw new ChannelError('binary_required')
        this.queue.push(new Uint8Array(event.data))
      } catch {
        void this.close('invalid_record')
      }
    }
    ws.onclose = (event) => {
      const known =
        /^(heartbeat_timeout|idle_timeout|auth_timeout|slow_consumer|client_disconnect|disconnected|unauthorized|node_shutdown)$/
      RequestChannel.debug('[Abele node] socket closed', {
        code: event.code,
        clean: event.wasClean,
        reason: known.test(event.reason) ? event.reason : 'peer_close',
      })
      this.queue.end()
    }
    ws.onerror = () => {
      RequestChannel.debug('[Abele node] socket error')
      this.queue.end()
    }
  }
  async send(bytes: Uint8Array) {
    if (this.ws.readyState !== 1) throw new ChannelError('disconnected')
    if (this.ws.bufferedAmount + bytes.length > LIMITS.unacked_bytes) {
      await this.close('slow_consumer')
      throw new ChannelError('slow_consumer')
    }
    this.ws.send(bytes)
  }
  receive() {
    return this.queue
  }
  async close(reason: string) {
    RequestChannel.debug('[Abele node] transport close', { reason })
    this.queue.end()
    this.ws.close(1000, reason.slice(0, 100))
  }
}
export class LocalChannelConnector implements ChannelConnector {
  constructor(
    private open: (url: string) => Promise<RecordTransport> = async (url) => {
      const ws = new WebSocket(url),
        transport = new BrowserRecordTransport(ws)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          void transport.close('connection_timeout')
          reject(new ChannelError('connection_timeout'))
        }, LIMITS.auth_ms)
        ws.onopen = () => {
          clearTimeout(timer)
          resolve()
        }
        ws.addEventListener(
          'error',
          () => {
            clearTimeout(timer)
            reject(new ChannelError('connection_failed'))
          },
          { once: true }
        )
        ws.addEventListener(
          'close',
          () => {
            clearTimeout(timer)
            reject(new ChannelError('connection_closed'))
          },
          { once: true }
        )
      })
      return transport
    }
  ) {}
  async connect(target: NodeConnection): Promise<AuthenticatedChannel> {
    assertLocalEndpoint(target)
    if (target.profile !== 'local-token-v1') throw new ChannelError('endpoint_refused')
    const deadline = performance.now() + LIMITS.auth_ms
    let transport: RecordTransport | undefined
    let abandoned = false
    const checkDeadline = () => {
      if (abandoned || performance.now() >= deadline) throw new ChannelError('connection_timeout')
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        (async () => {
          transport = await this.open(target.url)
          if (abandoned) {
            await transport.close('connection_timeout')
            throw new ChannelError('connection_timeout')
          }
          const iterator = transport.receive()[Symbol.asyncIterator]()
          const next = async (): Promise<RecordFrame> => {
            const row = await iterator.next()
            if (row.done) throw new ChannelError('connection_closed')
            return FrameCodec.decode(row.value)
          }
          const tokenHash = await localTokenHash(target.token)
          const selector = await localSelector(tokenHash)
          const nonce = randomNonce()
          checkDeadline()
          await transport.send(
            FrameCodec.encode({
              kind: 'local.begin',
              profile: LOCAL_PROOF_PROFILE,
              selector,
              client_nonce: nonce,
            })
          )
          const challenge = await next()
          checkDeadline()
          if (challenge.kind !== 'local.challenge') throw new ChannelError('local_upgrade_required')
          if (
            challenge.client_nonce !== nonce ||
            challenge.selector !== selector ||
            (target.expected_node_id && challenge.node_id !== target.expected_node_id) ||
            !(await verifyLocalBootstrap(tokenHash, challenge)) ||
            !(await verifyProof(
              challenge.node_key,
              await localTranscript(challenge),
              challenge.signature
            ))
          )
            throw new ChannelError('node_identity_mismatch')
          // Crypto may finish after the deadline/close. Never send a credential then.
          checkDeadline()
          await transport.send(
            FrameCodec.encode({ kind: 'auth', profile: 'local-token-v1', token: target.token })
          )
          const auth = await next()
          checkDeadline()
          if (auth.kind !== 'authenticated' || auth.installation_id !== challenge.installation_id)
            throw new ChannelError('unauthorized')
          await transport.send(
            FrameCodec.encode({ kind: 'hello', version: { major: 0, minor: 0 } })
          )
          const welcome = await next()
          if (welcome.kind !== 'welcome') throw new ChannelError('negotiation_failed')
          checkDeadline()
          if (
            welcome.node_id !== challenge.node_id ||
            welcome.installation_id !== challenge.installation_id ||
            (target.expected_node_id && welcome.node_id !== target.expected_node_id)
          )
            throw new ChannelError('node_identity_mismatch')
          return { transport, authority: { installation_id: auth.installation_id }, welcome }
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            abandoned = true
            reject(new ChannelError('connection_timeout'))
          }, LIMITS.auth_ms)
        }),
      ])
    } catch (error) {
      abandoned = true
      await transport?.close('connect_failed')
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

export class RequestChannel {
  /** Host policy, evaluated at the deadline, not cached at connection admission. */
  static backgroundActive: () => boolean = () => false
  /** Hosts opt into diagnostics without contaminating command-line response output. */
  static debug: (...args: unknown[]) => void = () => {}
  private probeTimer?: ReturnType<typeof setTimeout>
  private probeDue = 0
  private pending = new Map<
    string,
    {
      resolve: (r: unknown) => void
      reject: (e: unknown) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  private reader?: Promise<void>
  private heartbeat?: ReturnType<typeof setInterval>
  private stopped = false
  private lastRecord = Date.now()
  onEvent: (event: RecordFrame) => Promise<void> = async () => {}
  onClose: () => void = () => {}
  constructor(readonly channel: AuthenticatedChannel) {}
  start() {
    this.reader = (async () => {
      try {
        for await (const bytes of this.channel.transport.receive()) {
          const frame = FrameCodec.decode(bytes)
          this.lastRecord = Date.now()
          if (this.probeTimer !== undefined) {
            RequestChannel.debug('[Abele node] heartbeat probe answered', { kind: frame.kind })
            clearTimeout(this.probeTimer)
            this.probeTimer = undefined
          }
          if (frame.kind === 'response') {
            const pending = this.pending.get(frame.request_id)
            if (pending) {
              clearTimeout(pending.timer)
              this.pending.delete(frame.request_id)
              if (frame.error)
                pending.reject(
                  new ChannelError(frame.error.code, frame.error.message, frame.error.details)
                )
              else pending.resolve(frame.result)
            }
          } else if (frame.kind === 'event') await this.onEvent(frame)
          else if (frame.kind === 'ping')
            await this.channel.transport.send(FrameCodec.encode({ kind: 'pong' }))
          else if (frame.kind !== 'pong') throw new ChannelError('unexpected_record')
        }
      } catch (error) {
        RequestChannel.debug('[Abele node] channel reader ended', {
          reason: error instanceof ChannelError ? error.code : 'reader_failed',
        })
      } finally {
        if (!this.stopped) {
          this.fail('transport_ended')
          await this.channel.transport.close('disconnected')
        }
      }
    })().catch(() => {})
    this.heartbeat = setInterval(() => {
      if (this.stopped) return
      const idleMs = Date.now() - this.lastRecord
      if (idleMs > LIMITS.dead_ms) {
        if (RequestChannel.backgroundActive()) this.probe('heartbeat_idle')
        else void this.close('heartbeat_timeout')
      } else {
        void this.channel.transport
          .send(FrameCodec.encode({ kind: 'ping' }))
          .catch(() => this.close('heartbeat_send_failed'))
      }
    }, LIMITS.heartbeat_ms)
  }
  private probe(reason: string): void {
    if (this.stopped || this.probeTimer !== undefined) return
    RequestChannel.debug('[Abele node] heartbeat probe', {
      reason,
      idleMs: Date.now() - this.lastRecord,
    })
    this.probeDue = Date.now() + 5000
    this.probeTimer = setTimeout(() => {
      this.probeTimer = undefined
      if (this.stopped) return
      const lateMs = Date.now() - this.probeDue
      if (RequestChannel.backgroundActive() && lateMs >= 1000) {
        RequestChannel.debug('[Abele node] delayed heartbeat probe deadline', { lateMs })
        this.probe('timer_delayed')
      } else void this.close('heartbeat_probe_timeout')
    }, 5000)
    void this.channel.transport
      .send(FrameCodec.encode({ kind: 'ping' }))
      .catch(() => this.close('heartbeat_probe_send_failed'))
  }
  request(method: string, params: unknown, operation_id?: string): Promise<unknown> {
    if (this.stopped) return Promise.reject(new ChannelError('disconnected'))
    const request_id = crypto.randomUUID()
    return new Promise((resolve, reject) => {
      const longPoll = /^debugger\.v1\.(wait|sleep)$/.test(method)
        ? Number((params as { timeout_ms?: number } | null)?.timeout_ms ?? 60000)
        : 0
      const ms =
        longPoll > 0 && Number.isFinite(longPoll)
          ? Math.max(5000, Math.min(60000, longPoll) + 5000)
          : /^(project|workspace|review)\./.test(method)
            ? 30000
            : 5000
      let due = Date.now() + ms
      const expire = () => {
        const pending = this.pending.get(request_id)
        if (!pending || this.stopped) return
        const lateMs = Date.now() - due
        if (RequestChannel.backgroundActive() && lateMs >= 1000) {
          RequestChannel.debug('[Abele node] delayed request deadline: receive grace', {
            method,
            lateMs,
          })
          due = Date.now() + 1500
          pending.timer = setTimeout(expire, 1500)
          return
        }
        this.pending.delete(request_id)
        reject(new ChannelError('outcome_unknown'))
        RequestChannel.debug('[Abele node] request timeout', { method })
        // A deadline says nothing about transport health or other requests.
        // Keep late replies harmless and mutations uncertain; heartbeats own liveness.
      }
      const timer = setTimeout(expire, ms)
      this.pending.set(request_id, { resolve, reject, timer })
      void this.channel.transport
        .send(
          FrameCodec.encode({
            kind: 'request',
            request_id,
            ...(operation_id ? { operation_id } : {}),
            method,
            params,
          })
        )
        .catch((error) => {
          clearTimeout(this.pending.get(request_id)?.timer)
          this.pending.delete(request_id)
          reject(error)
        })
    })
  }
  private fail(reason: string) {
    if (this.stopped) return
    RequestChannel.debug('[Abele node] channel close', {
      reason,
      idleMs: Date.now() - this.lastRecord,
      backgroundAudio: RequestChannel.backgroundActive(),
    })
    this.stopped = true
    clearTimeout(this.probeTimer)
    this.probeTimer = undefined
    if (this.heartbeat) clearInterval(this.heartbeat)
    for (const p of this.pending.values()) {
      clearTimeout(p.timer)
      p.reject(new ChannelError('outcome_unknown'))
    }
    this.pending.clear()
    this.onClose()
  }
  async close(reason = 'client_disconnect') {
    if (!this.stopped) {
      this.fail(reason)
      await this.channel.transport.close(reason)
    }
    await this.reader
  }
}
/** Optional lifecycle helper: caller cancels with AbortSignal; foreground reconnect is connect(). */
export async function reconnect(work: () => Promise<void>, signal: AbortSignal): Promise<void> {
  let attempt = 0
  while (!signal.aborted) {
    try {
      await work()
      return
    } catch {
      const ms = Math.min(30000, 250 * 2 ** Math.min(attempt++, 8)) * (0.5 + Math.random() * 0.5)
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer)
          signal.removeEventListener('abort', finish)
          resolve()
        }
        const timer = setTimeout(finish, ms)
        signal.addEventListener('abort', finish, { once: true })
      })
    }
  }
}
