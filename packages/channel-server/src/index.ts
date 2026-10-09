import { randomUUID } from 'node:crypto'
import {
  FrameCodec,
  LIMITS,
  ChannelError,
  type RecordTransport,
  type AuthorityContext,
  type RecordFrame,
} from '@abele/channel-protocol'
import { MethodSchemas, PairingMethodSchemas } from '@abele/node-protocol'
import { NodeCore } from '@abele/node-core'
type Scheduled = {
  bytes: Uint8Array
  priority: number
  authorize?: () => void
  resolve: () => void
  reject: (error: unknown) => void
}
/** Already-writing bytes cannot be preempted; queued control records outrank artifacts. */
export class RecordScheduler {
  private queue: Scheduled[] = []
  private bytes = 0
  private draining = false
  private stopped = false
  constructor(private transport: RecordTransport) {}
  send(frame: unknown, priority = 0, authorize?: () => void): Promise<void> {
    const bytes = FrameCodec.encode(frame)
    if (this.stopped) return Promise.reject(new ChannelError('disconnected'))
    if (this.bytes + bytes.length > LIMITS.unacked_bytes)
      return Promise.reject(new ChannelError('slow_consumer'))
    this.bytes += bytes.length
    const result = new Promise<void>((resolve, reject) =>
      this.queue.push({ bytes, priority, authorize, resolve, reject })
    )
    void this.drain()
    return result
  }
  private async drain() {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length && !this.stopped) {
        this.queue.sort((a, b) => a.priority - b.priority)
        const item = this.queue.shift()!
        try {
          // Retain the resource scope with the queued record, not with a replay page.
          // This synchronous check runs immediately before transport.send, with no await gap.
          item.authorize?.()
          await this.transport.send(item.bytes)
          item.resolve()
        } catch (error) {
          item.reject(error)
          this.close()
          break
        } finally {
          this.bytes -= item.bytes.length
        }
      }
    } finally {
      this.draining = false
    }
  }
  close() {
    this.stopped = true
    for (const item of this.queue.splice(0)) {
      this.bytes -= item.bytes.length
      item.reject(new ChannelError('disconnected'))
    }
  }
}
interface Subscription {
  cursor: number
  ack: number
  bytes: number
  sent: Array<{ seq: number; bytes: number }>
}
/** Journal reads are the source of truth. Socket notifications never carry canonical events. */
export async function serveChannel(
  transport: RecordTransport,
  core: NodeCore,
  authenticatedActor?: AuthorityContext
): Promise<void> {
  let actor: AuthorityContext | undefined = authenticatedActor,
    ready = false,
    closed = false,
    last = Date.now(),
    pumping = false
  const subscriptions = new Map<string, Subscription>()
  const scheduler = new RecordScheduler({
    receive: () => transport.receive(),
    close: (reason) => transport.close(reason),
    send: async (bytes) => {
      // Authority may change while a previous record is in flight. Fence the
      // actual publication boundary, including already queued responses/events.
      if (actor) core.authority.check(actor, 'publish')
      await transport.send(bytes)
    },
  })
  const send = (frame: unknown, priority = 0, authorize?: () => void) =>
    scheduler.send(frame, priority, authorize)
  const close = async (reason: string) => {
    if (closed) return
    closed = true
    scheduler.close()
    await transport.close(reason)
  }
  const authDeadline = setTimeout(() => void close('authentication_timeout'), LIMITS.auth_ms)
  const heartbeat = setInterval(() => {
    if (Date.now() - last > LIMITS.dead_ms) void close('dead_connection')
    else if (ready) void send({ kind: 'ping' }).catch(() => close('send_failed'))
  }, LIMITS.heartbeat_ms)
  const pump = setInterval(() => {
    if (!ready || !actor || closed || pumping) return
    pumping = true
    void (async () => {
      core.authority.check(actor!, 'publish')
      for (const [stream, subscription] of subscriptions) {
        core.authority.check(actor!, 'publish', stream)
        for (const event of core.read(stream, subscription.cursor)) {
          const bytes = FrameCodec.encode(event)
          const unacked = [...subscriptions.values()].reduce((sum, s) => sum + s.bytes, 0)
          if (unacked + bytes.byteLength > LIMITS.unacked_bytes)
            throw new ChannelError('slow_consumer')
          subscription.bytes += bytes.byteLength
          subscription.sent.push({ seq: event.seq, bytes: bytes.byteLength })
          subscription.cursor = event.seq
          await scheduler.send(event, 1, () => core.authority.check(actor!, 'publish', stream))
          if (closed) return
        }
      }
    })()
      .catch(() => close('publication_failed'))
      .finally(() => {
        pumping = false
      })
  }, 10)
  try {
    for await (const bytes of transport.receive()) {
      if (closed) break
      last = Date.now()
      if (!actor && bytes.byteLength > LIMITS.auth_bytes) throw new ChannelError('auth_too_large')
      const frame = FrameCodec.decode(bytes)
      if (!actor) {
        if (frame.kind !== 'auth') throw new ChannelError('authentication_required')
        actor = core.authority.authenticate(frame.token)
        await send({ kind: 'authenticated', installation_id: actor.installation_id })
        continue
      }
      core.authority.check(actor, 'admit')
      if (!ready) {
        if (frame.kind !== 'hello') throw new ChannelError('hello_required')
        ready = true
        clearTimeout(authDeadline)
        await send({
          kind: 'welcome',
          version: frame.version,
          node_id: core.node_id,
          installation_id: actor.installation_id,
          instance_id: randomUUID(),
          methods: [
            ...Object.keys(MethodSchemas),
            ...(actor.profile === 'local-token-v1' ? Object.keys(PairingMethodSchemas) : []),
          ],
          limits: LIMITS,
          capabilities: core.capabilities(),
        })
        continue
      }
      if (frame.kind === 'ping') {
        await send({ kind: 'pong' })
        continue
      }
      if (frame.kind === 'pong') continue
      if (frame.kind !== 'request') throw new ChannelError('unexpected_record')
      let response: RecordFrame
      try {
        let result: unknown
        if (['stream.subscribe', 'stream.ack', 'stream.unsubscribe'].includes(frame.method)) {
          const schema =
            MethodSchemas[frame.method as 'stream.subscribe' | 'stream.ack' | 'stream.unsubscribe']
          const parsed = schema.safeParse(frame.params)
          if (!parsed.success) throw new ChannelError('invalid_params')
          const p = parsed.data
          core.authority.check(actor, 'subscribe', p.stream_id)
          if ('after_seq' in p) {
            if (!subscriptions.has(p.stream_id) && subscriptions.size >= 256)
              throw new ChannelError('subscription_limit')
            const after = Number(p.after_seq)
            if (after > core.head(p.stream_id)) throw new ChannelError('resync_required')
            subscriptions.set(p.stream_id, { cursor: after, ack: after, bytes: 0, sent: [] })
            result = { head_seq: core.head(p.stream_id) }
          } else if ('seq' in p) {
            const seq = Number(p.seq)
            const s = subscriptions.get(p.stream_id)
            if (!s || seq > s.cursor || seq < s.ack) throw new ChannelError('invalid_ack')
            s.ack = seq
            while (s.sent[0] && s.sent[0].seq <= seq) s.bytes -= s.sent.shift()!.bytes
            result = { seq }
          } else {
            subscriptions.delete(p.stream_id)
            result = { unsubscribed: true }
          }
        } else result = await core.request(actor, frame.method, frame.params, frame.operation_id)
        response = {
          kind: 'response',
          request_id: frame.request_id,
          ...(frame.operation_id ? { operation_id: frame.operation_id } : {}),
          result,
        }
      } catch (error) {
        // Internal/storage failures can occur after commit. Do not manufacture a
        // terminal rejection: disconnect so the durable outbox retries its receipt.
        if (!(error instanceof ChannelError)) {
          await close('internal_failure')
          break
        }
        const code = error.code
        response = {
          kind: 'response',
          request_id: frame.request_id,
          ...(frame.operation_id ? { operation_id: frame.operation_id } : {}),
          error: { code, message: code, details: {} },
        }
      }
      // Do not block admission behind artifact writes. The scheduler bounds queued bytes.
      void send(
        response,
        frame.method === 'artifact.read' ? 2 : 0,
        response.error
          ? undefined
          : () => core.checkPublication(actor!, frame.method, frame.params, response.result)
      ).catch(() => close('send_failed'))
    }
  } catch {
    /* Reject unauthenticated/malformed records without application error details. */
  } finally {
    clearTimeout(authDeadline)
    clearInterval(heartbeat)
    clearInterval(pump)
    await close('channel_closed')
  }
}
