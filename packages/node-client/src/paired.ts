import {
  FrameCodec,
  ChannelError,
  LIMITS,
  InviteSchema,
  ClaimSchema,
  assertPairedEndpoint,
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

export interface PairedDevice extends DeviceIdentity {
  endpoint: string
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
    const fail = () => {
      clearTimeout(timer)
      reject(new ChannelError('connection_failed'))
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
  async claim(raw: PairingInvite) {
    const invite = InviteSchema.parse(raw)
    assertPairedEndpoint(invite.endpoint)
    const device = await this.keys.transaction(invite.node_id, async (stored) => {
      if (
        stored &&
        (stored.node_id !== invite.node_id ||
          stored.node_fingerprint !== invite.node_fingerprint ||
          stored.endpoint !== invite.endpoint)
      )
        throw new ChannelError('node_identity_mismatch')
      const identity = stored ?? {
        ...(await generateIdentity()),
        endpoint: invite.endpoint,
        node_id: invite.node_id,
        node_fingerprint: invite.node_fingerprint,
      }
      return { device: identity, result: identity }
    })
    return this.handshake(device, invite, async (transport, next) => {
      const frame = await next()
      if (frame.kind !== 'paired.claimed') throw new ChannelError('pairing_failed')
      const claim = ClaimSchema.parse(frame.claim)
      await this.keys.transaction(invite.node_id, async (current) => {
        // A late claim response cannot overwrite a concurrently replaced key or explicit pin change.
        if (
          !current ||
          current.node_id !== device.node_id ||
          current.endpoint !== device.endpoint ||
          current.node_fingerprint !== device.node_fingerprint ||
          (await fingerprint(current.public_key)) !== (await fingerprint(device.public_key)) ||
          claim.device_fingerprint !== (await fingerprint(device.public_key))
        )
          throw new ChannelError('device_identity_mismatch')
        if (current.installation_id && current.installation_id !== claim.installation_id)
          throw new ChannelError('installation_identity_mismatch')
        return { device: { ...current, installation_id: claim.installation_id }, result: undefined }
      })
      await transport.close('claim_complete')
      return claim
    })
  }
  async target(node_id: string): Promise<NodeConnection> {
    const device = await this.keys.load(node_id)
    if (!device?.installation_id) throw new ChannelError('pairing_required')
    if (device.node_id !== node_id) throw new ChannelError('device_identity_mismatch')
    return {
      profile: 'paired-wss-v1',
      url: device.endpoint,
      expected_node_id: device.node_id,
      node_fingerprint: device.node_fingerprint,
      installation_id: device.installation_id,
      public_key: device.public_key,
    }
  }
  async connect(target: NodeConnection): Promise<AuthenticatedChannel> {
    if (target.profile !== 'paired-wss-v1') throw new ChannelError('profile_refused')
    assertPairedEndpoint(target.url)
    const device = await this.keys.load(target.expected_node_id)
    if (
      !device ||
      device.node_id !== target.expected_node_id ||
      device.installation_id !== target.installation_id ||
      device.endpoint !== target.url ||
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
    finish: (transport: RecordTransport, next: () => Promise<RecordFrame>) => Promise<T>
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
          transport = await this.open(device.endpoint)
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
            return FrameCodec.decode(row.value)
          }
          const nonce = randomNonce()
          await transport.send(
            FrameCodec.encode({
              kind: 'paired.begin',
              profile: 'paired-wss-v1',
              client_nonce: nonce,
              public_key: device.public_key,
              ...(invite ? { invite } : { installation_id: device.installation_id }),
            })
          )
          const challenge = await next()
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
          await transport.send(FrameCodec.encode({ kind: 'paired.proof', signature }))
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
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
