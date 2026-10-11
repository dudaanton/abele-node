import {
  FrameCodec,
  ChannelError,
  LIMITS,
  InviteSchema,
  ClaimSchema,
  DeviceNameSchema,
  assertPairedEndpoint,
  assertPairedTransportEndpoint,
  generateIdentity,
  fingerprint,
  randomNonce,
  signProof,
  verifyProof,
  proofTranscript,
  type DeviceIdentity,
  type PairingInvite,
  type NodeConnection,
  type ChannelConnector,
  type RecordTransport,
  type AuthenticatedChannel,
  type RecordFrame,
} from '@abele/channel-protocol'
import { BrowserRecordTransport } from '@abele/channel-client'
import type { PairingRouteReason } from '@abele/node-protocol'
import { PairingSession, type PairingAdapters } from './pairing-session.js'

export class PairedRouteError extends ChannelError {
  constructor(
    readonly reason: PairingRouteReason,
    readonly address: string,
    code = `paired_route_${reason}`
  ) {
    super(code, code, { reason, address })
  }
}
/** Native openers can expose TLS/network codes or PAIRED_HOST_NOT_ACCEPTED from the HTTP upgrade.
 * Browser WebSocket intentionally hides these: preserve that uncertainty instead of guessing. */
export function pairedRouteFailure(error: unknown, address: string): PairedRouteError {
  if (error instanceof PairedRouteError) return error
  const queue: unknown[] = [error],
    seen = new Set<unknown>(),
    codes: string[] = []
  while (queue.length && seen.size < 32) {
    const current = queue.shift()
    if (!current || typeof current !== 'object' || seen.has(current)) continue
    seen.add(current)
    const value = current as {
      code?: unknown
      cause?: unknown
      error?: unknown
      errors?: unknown[]
    }
    if (typeof value.code === 'string') codes.push(value.code)
    queue.push(value.cause, value.error, ...(Array.isArray(value.errors) ? value.errors : []))
  }
  if (codes.includes('PAIRED_HOST_NOT_ACCEPTED'))
    return new PairedRouteError('host_not_accepted', address)
  if (codes.includes('PAIRED_ROUTE_REFUSED'))
    return new PairedRouteError('policy_not_accepted', address)
  if (
    codes.some((code) =>
      /^(ERR_TLS_|ERR_SSL_|CERT_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_)/.test(
        code
      )
    )
  )
    return new PairedRouteError('tls', address)
  if (
    codes.some((code) =>
      [
        'ECONNREFUSED',
        'ECONNRESET',
        'ENOTFOUND',
        'EAI_AGAIN',
        'ETIMEDOUT',
        'EHOSTUNREACH',
        'ENETUNREACH',
      ].includes(code)
    )
  )
    return new PairedRouteError('unreachable', address)
  return new PairedRouteError(
    'tls_or_unreachable',
    address,
    error instanceof ChannelError ? error.code : undefined
  )
}

export interface PairedDevice extends DeviceIdentity {
  /** Signed canonical endpoint; never replaced by an edited transport address. */
  endpoint: string
  transport_endpoint?: string
  node_id: string
  node_fingerprint: string
  installation_id?: string
}
/** Device-local secrets only. Commit atomically before transmitting a claim; never settings-sync.
 * CryptoKeys must retain non-extractable private keys (e.g. structured clone in IndexedDB).
 * Inject a separately namespaced store for each independent installation.
 * Transactions must serialize all adapters/contexts sharing that namespace, commit
 * the returned device atomically, and leave the old value intact on rejection.
 * load() returns an isolated snapshot. Do not hold an IndexedDB transaction across
 * arbitrary async work: use a namespace lock/atomic commit adapter instead.
 */
export interface DeviceKeyStore {
  load(node_id: string): Promise<PairedDevice | undefined>
  transaction<T>(
    node_id: string,
    work: (device: PairedDevice | undefined) => Promise<{ device: PairedDevice; result: T }>
  ): Promise<T>
}
export type TransportOpener = (url: string) => Promise<RecordTransport>
async function openBrowser(url: string) {
  const ws = new WebSocket(url),
    transport = new BrowserRecordTransport(ws)
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      void transport.close('connection_timeout')
      reject(new ChannelError('connection_timeout'))
    }, LIMITS.auth_ms)
    const fail = (event: Event) => {
      clearTimeout(timer)
      reject(pairedRouteFailure(event, url))
    }
    ws.addEventListener('error', fail, { once: true })
    ws.addEventListener('close', fail, { once: true })
    ws.onopen = () => {
      clearTimeout(timer)
      resolve()
    }
  })
  return transport
}
export class PairedWssConnector implements ChannelConnector {
  constructor(
    private keys: DeviceKeyStore,
    private open: TransportOpener = openBrowser
  ) {}
  /** Framework-neutral foreground lifecycle using this exact key namespace and connector. */
  createPairingSession(adapters: Omit<PairingAdapters, 'connector'>): PairingSession {
    return new PairingSession({ ...adapters, connector: this })
  }
  /** Explicit owner-verified recovery only. Never call automatically on connection failure.
   * UI must verify this new invite fingerprint out-of-band and display both old/new pins.
   */
  async authorizeNodeKeyChange(raw: PairingInvite, expected_previous_fingerprint: string) {
    const invite = InviteSchema.parse(raw)
    assertPairedEndpoint(invite.endpoint)
    await this.keys.transaction(invite.node_id, async (device) => {
      if (
        !device ||
        device.node_id !== invite.node_id ||
        device.node_fingerprint !== expected_previous_fingerprint
      )
        throw new ChannelError('node_identity_mismatch')
      return {
        device: { ...device, endpoint: invite.endpoint, node_fingerprint: invite.node_fingerprint },
        result: undefined,
      }
    })
  }
  async claim(raw: PairingInvite, options: { deviceName?: string; endpoint?: string } = {}) {
    if (options.deviceName !== undefined) DeviceNameSchema.parse(options.deviceName)
    const invite = InviteSchema.parse(raw)
    assertPairedEndpoint(invite.endpoint)
    if (options.endpoint !== undefined) assertPairedTransportEndpoint(options.endpoint)
    const device = await this.keys.transaction(invite.node_id, async (stored) => {
      if (
        stored &&
        (stored.node_id !== invite.node_id ||
          stored.node_fingerprint !== invite.node_fingerprint ||
          stored.endpoint !== invite.endpoint)
      )
        throw new PairedRouteError(
          'different_node',
          options.endpoint ?? invite.endpoint,
          'node_identity_mismatch'
        )
      const identity: PairedDevice = {
        ...(stored ?? {
          ...(await generateIdentity()),
          endpoint: invite.endpoint,
          node_id: invite.node_id,
          node_fingerprint: invite.node_fingerprint,
        }),
        ...(options.endpoint !== undefined ? { transport_endpoint: options.endpoint } : {}),
      }
      return { device: identity, result: identity }
    })
    return this.handshake(
      device,
      invite,
      async (transport, next) => {
        const frame = await next()
        if (frame.kind !== 'paired.claimed') throw new ChannelError('pairing_failed')
        const claim = ClaimSchema.parse(frame.claim)
        await this.keys.transaction(invite.node_id, async (current) => {
          // A late claim response cannot overwrite a concurrently replaced key or explicit pin change.
          if (
            !current ||
            current.node_id !== device.node_id ||
            current.endpoint !== device.endpoint ||
            current.transport_endpoint !== device.transport_endpoint ||
            current.node_fingerprint !== device.node_fingerprint ||
            (await fingerprint(current.public_key)) !== (await fingerprint(device.public_key)) ||
            claim.device_fingerprint !== (await fingerprint(device.public_key))
          )
            throw new ChannelError('device_identity_mismatch')
          if (current.installation_id && current.installation_id !== claim.installation_id)
            throw new ChannelError('installation_identity_mismatch')
          return {
            device: { ...current, installation_id: claim.installation_id },
            result: undefined,
          }
        })
        await transport.close('claim_complete')
        return claim
      },
      options.deviceName
    )
  }
  async target(node_id: string): Promise<NodeConnection> {
    const device = await this.keys.load(node_id)
    if (!device?.installation_id) throw new ChannelError('pairing_required')
    if (device.node_id !== node_id) throw new ChannelError('device_identity_mismatch')
    return {
      profile: 'paired-wss-v1',
      url: device.transport_endpoint ?? device.endpoint,
      expected_node_id: device.node_id,
      node_fingerprint: device.node_fingerprint,
      installation_id: device.installation_id,
      public_key: device.public_key,
    }
  }
  async connect(target: NodeConnection): Promise<AuthenticatedChannel> {
    if (target.profile !== 'paired-wss-v1') throw new ChannelError('profile_refused')
    assertPairedTransportEndpoint(target.url)
    const device = await this.keys.load(target.expected_node_id)
    if (
      !device ||
      device.node_id !== target.expected_node_id ||
      device.installation_id !== target.installation_id ||
      (device.transport_endpoint ?? device.endpoint) !== target.url ||
      device.node_fingerprint !== target.node_fingerprint ||
      (await fingerprint(device.public_key)) !== (await fingerprint(target.public_key))
    )
      throw new ChannelError('device_identity_mismatch')
    return this.handshake(device, undefined, async (transport, next) => {
      const auth = await next()
      if (auth.kind !== 'authenticated' || auth.installation_id !== device.installation_id)
        throw new ChannelError('unauthorized')
      await transport.send(FrameCodec.encode({ kind: 'hello', version: { major: 0, minor: 0 } }))
      const welcome = await next()
      if (
        welcome.kind !== 'welcome' ||
        welcome.node_id !== device.node_id ||
        welcome.installation_id !== device.installation_id
      )
        throw new ChannelError('node_identity_mismatch')
      return {
        transport,
        authority: { installation_id: auth.installation_id, profile: 'paired-wss-v1' },
        welcome,
      }
    })
  }
  private async handshake<T>(
    device: PairedDevice,
    invite: PairingInvite | undefined,
    finish: (transport: RecordTransport, next: () => Promise<RecordFrame>) => Promise<T>,
    deviceName?: string
  ): Promise<T> {
    let transport: RecordTransport | undefined,
      abandoned = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = performance.now() + LIMITS.auth_ms
    const checkDeadline = () => {
      if (abandoned || performance.now() >= deadline) throw new ChannelError('connection_timeout')
    }
    try {
      return await Promise.race([
        (async () => {
          const address = device.transport_endpoint ?? device.endpoint
          transport = await this.open(address).catch((error: unknown) => {
            throw pairedRouteFailure(error, address)
          })
          // The race may already have rejected while open() was pending. Its catch
          // could not close an undefined transport, so the losing branch owns cleanup.
          if (abandoned) {
            await transport.close('connection_timeout')
            throw new ChannelError('connection_timeout')
          }
          checkDeadline()
          const iterator = transport.receive()[Symbol.asyncIterator]()
          const next = async () => {
            const row = await iterator.next()
            checkDeadline()
            if (row.done) throw new ChannelError('connection_closed')
            if (row.value.length > LIMITS.auth_bytes) throw new ChannelError('auth_too_large')
            const frame = FrameCodec.decode(row.value)
            if (frame.kind === 'paired.error') throw new ChannelError(frame.code)
            return frame
          }
          const nonce = randomNonce()
          await transport.send(
            FrameCodec.encode({
              kind: 'paired.begin',
              profile: 'paired-wss-v1',
              client_nonce: nonce,
              public_key: device.public_key,
              ...(invite
                ? { invite_id: invite.invite_id }
                : { installation_id: device.installation_id }),
            })
          )
          const challenge = await next().catch((error: unknown) => {
            // An old strict daemon closes on the new secret-free enrollment begin.
            // Never retry by sending its legacy secret-bearing begin.
            if (invite && error instanceof ChannelError && error.code === 'connection_closed')
              throw new ChannelError('pairing_upgrade_required')
            throw error
          })
          if (
            challenge.kind !== 'paired.challenge' ||
            challenge.client_nonce !== nonce ||
            challenge.node_id !== device.node_id ||
            challenge.endpoint !== device.endpoint ||
            challenge.installation_id !== (invite?.invite_id ?? device.installation_id) ||
            challenge.purpose !== (invite ? 'claim' : 'connect') ||
            challenge.device_fingerprint !== (await fingerprint(device.public_key)) ||
            (await fingerprint(challenge.node_key)) !== device.node_fingerprint ||
            !(await verifyProof(
              challenge.node_key,
              proofTranscript(challenge, 'node'),
              challenge.signature
            ))
          )
            throw new ChannelError('node_identity_mismatch')
          // The signed server expiry is enforced by the server's clock. Freshness here
          // comes from our nonce and local monotonic deadline, not synchronized wall clocks.
          checkDeadline()
          const signature = await signProof(
            device.private_key,
            proofTranscript(challenge, 'device')
          )
          checkDeadline()
          await transport.send(
            FrameCodec.encode({
              kind: 'paired.proof',
              signature,
              ...(invite
                ? { invite, ...(deviceName !== undefined ? { device_name: deviceName } : {}) }
                : {}),
            })
          )
          const result = await finish(transport, next)
          checkDeadline()
          return result
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
      if (error instanceof ChannelError && error.code === 'node_identity_mismatch')
        throw new PairedRouteError(
          'different_node',
          device.transport_endpoint ?? device.endpoint,
          error.code
        )
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
