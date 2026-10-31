import { randomUUID } from 'node:crypto'
import {
  FrameCodec,
  LOCAL_PROOF_PROFILE,
  localTranscript,
  randomNonce,
  signProof,
  fingerprint,
  type LocalChallenge,
  LIMITS,
  ChannelError,
  type RecordTransport,
  type AuthorityContext,
  type RecordFrame,
  type JournalEvent,
} from '@abele/channel-protocol'
import { MethodSchemas, PairingMethodSchemas } from '@abele/node-protocol'
import { NodeCore } from '@abele/node-core'
import { legacyExecutionPolicy } from './execution-policy-wire.js'
import { legacyOwnerStop } from './owner-stop-wire.js'

const POLICY_ENABLE = 'execution.policy.v1.enable'
const OWNER_STOP_ENABLE = 'session.owner-stop.v1.enable'
const COMMAND_CONTEXT_ENABLE = 'command.context.v1.enable'
const INTEGRATION_CONTEXT_ENABLE = 'integration.context.v1.enable'

/**
 * The welcome travels inside the handshake, which clients bound to `LIMITS.auth_bytes`, so it
 * names each provider and its feature gates only. Configuration and gate evidence stay in
 * `node.describe`, which has no such bound and grows with every provider the node learns.
 */
function welcomeCapabilities(core: NodeCore) {
  const capabilities = core.capabilities()
  return {
    ...capabilities,
    providers: capabilities.providers.map((p) => {
      const { provider, provider_version, available, diagnostic } = p as Record<string, unknown>
      return {
        provider,
        provider_version,
        ...(available !== undefined ? { available } : {}),
        ...(diagnostic !== undefined ? { diagnostic } : {}),
        capabilities: p.capabilities,
      }
    }),
  }
}
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
  let localChallenge: LocalChallenge | undefined
  const localDeadline = performance.now() + LIMITS.auth_ms
  const subscriptions = new Map<string, Subscription>()
  // A followed session stream keeps its long-lived process from idling out.
  const watches = new Map<string, () => void>()
  const unwatch = (stream: string) => {
    watches.get(stream)?.()
    watches.delete(stream)
  }
  const connection = new AbortController()
  let executionPolicyEnabled = false
  let ownerStopEnabled = false
  let commandContextEnabled = false
  let integrationContextEnabled = false
  let selfDisconnectReply: string | undefined
  const requests = new Set<Promise<void>>()
  const scheduler = new RecordScheduler({
    receive: () => transport.receive(),
    close: (reason) => transport.close(reason),
    send: async (bytes) => {
      // Authority may change while a previous record is in flight. Fence the
      // actual publication boundary, including already queued responses/events.
      const frame = selfDisconnectReply === undefined ? undefined : FrameCodec.decode(bytes)
      const acknowledgement =
        frame?.kind === 'response' &&
        frame.request_id === selfDisconnectReply &&
        !frame.error &&
        JSON.stringify(frame.result) === '{"disconnected":true}'
      if (actor && !acknowledgement) core.authority.check(actor, 'publish')
      await transport.send(bytes)
      if (acknowledgement) {
        selfDisconnectReply = undefined
        await close('device_disconnected')
      }
    },
  })
  const send = (frame: unknown, priority = 0, authorize?: () => void) =>
    scheduler.send(
      ownerStopEnabled
        ? executionPolicyEnabled
          ? frame
          : legacyExecutionPolicy(frame)
        : legacyOwnerStop(executionPolicyEnabled ? frame : legacyExecutionPolicy(frame)),
      priority,
      authorize
    )
  const close = async (reason: string) => {
    if (closed) return
    closed = true
    connection.abort()
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
          // A skipped sequence makes contiguous clients replay the same gap forever.
          // Preserve only stream/sequence identity; none of the fenced event's type,
          // actor, timestamp or payload may cross the publication boundary.
          const published: JournalEvent = core.canPublishEvent(actor!, event)
            ? event
            : {
                kind: 'event',
                node_id: core.node_id,
                stream_id: stream,
                seq: event.seq,
                type: 'stream.redacted',
                actor: { kind: 'node' },
                at: new Date().toISOString(),
                data: { refresh_required: true },
              }
          const bytes = FrameCodec.encode(published)
          const unacked = [...subscriptions.values()].reduce((sum, s) => sum + s.bytes, 0)
          if (unacked + bytes.byteLength > LIMITS.unacked_bytes)
            throw new ChannelError('slow_consumer')
          subscription.bytes += bytes.byteLength
          subscription.sent.push({ seq: event.seq, bytes: bytes.byteLength })
          subscription.cursor = event.seq
          await send(published, 1, () => {
            if (!core.canPublishEvent(actor!, published)) throw new ChannelError('unauthorized')
          })
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
        if (!localChallenge) {
          if (frame.kind !== 'local.begin') throw new ChannelError('local_upgrade_required')
          const identity = await core.pairing.identity.load()
          const prepared = await core.authority.localChallenge(frame.selector, {
            kind: 'local.challenge',
            profile: LOCAL_PROOF_PROFILE,
            client_nonce: frame.client_nonce,
            selector: frame.selector,
            connection_id: randomNonce(),
            node_id: core.node_id,
            expires_at: Date.now() + LIMITS.auth_ms,
            node_key: identity.public_key,
          })
          const challenge = prepared.challenge
          challenge.signature = await signProof(
            identity.private_key,
            await localTranscript(challenge)
          )
          challenge.mac = await prepared.mac(challenge)
          if (closed || performance.now() >= localDeadline)
            throw new ChannelError('authentication_timeout')
          localChallenge = challenge
          await send(challenge)
          continue
        }
        if (
          frame.kind !== 'auth' ||
          closed ||
          performance.now() >= localDeadline ||
          Date.now() >= localChallenge.expires_at
        )
          throw new ChannelError('authentication_required')
        if (
          (await fingerprint((await core.pairing.identity.load()).public_key)) !==
          (await fingerprint(localChallenge.node_key))
        )
          throw new ChannelError('node_identity_changed')
        if (closed || performance.now() >= localDeadline)
          throw new ChannelError('authentication_timeout')
        actor = core.authority.authenticate(frame.token)
        if (actor.installation_id !== localChallenge.installation_id)
          throw new ChannelError('unauthorized')
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
            POLICY_ENABLE,
            OWNER_STOP_ENABLE,
            COMMAND_CONTEXT_ENABLE,
            INTEGRATION_CONTEXT_ENABLE,
            ...core.debuggerControl.methods(),
            ...core.trace.methods(),
            ...core.http.methods(),
            ...(actor.profile === 'local-token-v1' ? Object.keys(PairingMethodSchemas) : []),
          ],
          limits: LIMITS,
          // 0.4.2 welcome readers are strict at the envelope, but this
          // existing map is extensible. Never add unnegotiated top-level keys.
          capabilities: { ...welcomeCapabilities(core), ...core.discovery() },
        })
        continue
      }
      if (frame.kind === 'ping') {
        await send({ kind: 'pong' })
        continue
      }
      if (frame.kind === 'pong') continue
      if (frame.kind !== 'request') throw new ChannelError('unexpected_record')
      const execute = async () => {
        let response: RecordFrame
        try {
          let result: unknown
          if (
            frame.method === POLICY_ENABLE ||
            frame.method === OWNER_STOP_ENABLE ||
            frame.method === COMMAND_CONTEXT_ENABLE ||
            frame.method === INTEGRATION_CONTEXT_ENABLE
          ) {
            if (
              !frame.params ||
              typeof frame.params !== 'object' ||
              Array.isArray(frame.params) ||
              Object.keys(frame.params).length
            )
              throw new ChannelError('invalid_params')
            if (frame.method === POLICY_ENABLE) executionPolicyEnabled = true
            else if (frame.method === OWNER_STOP_ENABLE) ownerStopEnabled = true
            else if (frame.method === COMMAND_CONTEXT_ENABLE) commandContextEnabled = true
            else integrationContextEnabled = true
            result = { enabled: true }
          } else if (frame.method.startsWith('command.context.v1.') && !commandContextEnabled) {
            throw new ChannelError(
              'capability_required',
              'capability_required: enable command_context_v1 with command.context.v1.enable'
            )
          } else if (
            frame.method.startsWith('integration.context.v1.') &&
            !integrationContextEnabled
          ) {
            throw new ChannelError(
              'capability_required',
              'capability_required: enable integration_context_v1 with integration.context.v1.enable'
            )
          } else if (
            ['stream.subscribe', 'stream.ack', 'stream.unsubscribe'].includes(frame.method)
          ) {
            const schema =
              MethodSchemas[
                frame.method as 'stream.subscribe' | 'stream.ack' | 'stream.unsubscribe'
              ]
            const parsed = schema.safeParse(frame.params)
            if (!parsed.success) throw new ChannelError('invalid_params')
            const p = parsed.data
            core.authority.check(actor!, 'subscribe', p.stream_id)
            if ('after_seq' in p) {
              if (!subscriptions.has(p.stream_id) && subscriptions.size >= 256)
                throw new ChannelError('subscription_limit')
              const after = Number(p.after_seq)
              if (after > core.head(p.stream_id)) throw new ChannelError('resync_required')
              subscriptions.set(p.stream_id, { cursor: after, ack: after, bytes: 0, sent: [] })
              if (!watches.has(p.stream_id)) watches.set(p.stream_id, core.watch(p.stream_id))
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
              unwatch(p.stream_id)
              result = { unsubscribed: true }
            }
          } else
            result = await core.request(
              actor!,
              frame.method,
              frame.params,
              frame.operation_id,
              connection.signal
            )
          response = {
            kind: 'response',
            request_id: frame.request_id,
            ...(frame.operation_id ? { operation_id: frame.operation_id } : {}),
            result,
          }
          if (
            frame.method === 'node.disconnect' &&
            (result as { disconnected?: unknown })?.disconnected === true
          )
            selfDisconnectReply = frame.request_id
        } catch (error) {
          // Internal/storage failures can occur after commit. Do not manufacture a
          // terminal rejection: disconnect so the durable outbox retries its receipt.
          if (!(error instanceof ChannelError)) {
            console.error('[Abele channel] internal request failure', {
              method: frame.method,
              error: error instanceof Error ? error.message.slice(0, 512) : 'unknown',
            })
            await close('internal_failure')
            return
          }
          const code = error.code
          response = {
            kind: 'response',
            request_id: frame.request_id,
            ...(frame.operation_id ? { operation_id: frame.operation_id } : {}),
            error: { code, message: error.message.slice(0, 2048), details: error.details },
          }
        }
        // Do not block admission behind artifact writes. The scheduler bounds queued bytes.
        void send(
          response,
          frame.method === 'artifact.read' ? 2 : 0,
          response.error
            ? undefined
            : frame.method === POLICY_ENABLE ||
                frame.method === OWNER_STOP_ENABLE ||
                frame.method === COMMAND_CONTEXT_ENABLE ||
                frame.method === INTEGRATION_CONTEXT_ENABLE
              ? () => core.authority.check(actor!, 'request')
              : () => core.checkPublication(actor!, frame.method, frame.params, response.result)
        ).catch(() => close('send_failed'))
      }
      {
        // Feature work must not hold up heartbeat, cancellation, or unrelated
        // requests. Domain services retain their own mutation/receipt locks.
        if (requests.size >= 128) {
          await send({
            kind: 'response',
            request_id: frame.request_id,
            error: {
              code: 'resource_busy',
              message: 'Too many requests are in progress',
              details: {},
            },
          })
          continue
        }
        const task = execute()
          .catch(() => close('request_failed'))
          .finally(() => requests.delete(task))
        requests.add(task)
      }
    }
  } catch {
    /* Reject unauthenticated/malformed records without application error details. */
  } finally {
    clearTimeout(authDeadline)
    clearInterval(heartbeat)
    clearInterval(pump)
    for (const stream of [...watches.keys()]) unwatch(stream)
    await close('channel_closed')
    await Promise.allSettled(requests)
  }
}
