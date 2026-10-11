import {
  decodePairCode,
  shortPairingFingerprint,
  PairingRouteFailureSchema,
  type PairingRouteFailure,
  type PairCodePayload,
} from '@abele/node-protocol'
import {
  DeviceNameSchema,
  ChannelError,
  assertPairedTransportEndpoint,
  type NodeConnection,
} from '@abele/channel-protocol'
import type { NodeClient } from './index.js'
import type { PairedWssConnector } from './paired.js'

export interface PairingDetails {
  nodeName: string
  nodeId: string
  host: string
  port: number
  fingerprint: string
  expiresAt: number
}
export interface PairingState {
  phase:
    | 'paste'
    | 'decoded'
    | 'claiming'
    | 'waiting'
    | 'connecting'
    | 'connected'
    | 'cancelled'
    | 'error'
  details?: PairingDetails
  deviceName?: string
  deviceFingerprint?: string
  error?: string
  addressError?: PairingRouteFailure
}
type Client = Pick<NodeClient, 'connect' | 'disconnect' | 'connected'>
export interface PairingAdapters {
  connector: Pick<PairedWssConnector, 'claim' | 'target'>
  /** Must create a real NodeClient using the same connector and device-local principal store.
   * Keep registration provisional until the model returns an authenticated client. */
  createClient(target: NodeConnection): Client
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>
  maxAttempts?: number
}
function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('pairing_cancelled'))
      return
    }
    const cancel = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', cancel)
      reject(new Error('pairing_cancelled'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', cancel)
      resolve()
    }, milliseconds)
    signal.addEventListener('abort', cancel, { once: true })
  })
}
const transient = new Set([
  'connection_closed',
  'connection_timeout',
  'connection_failed',
  'pairing_failed',
])
function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  // Never surface arbitrary transport messages or invitation data in UI/logs.
  return /^[a-z][a-z0-9_]+$/.test(message) ? message : 'pairing_failed'
}
/** Foreground pairing lifecycle for any browser-compatible client.
 * No UI framework, registry, settings sync, owner RPC or implicit pin recovery. */
export class PairingSession {
  state: PairingState = { phase: 'paste' }
  onChange?: (state: PairingState) => void
  private payload?: PairCodePayload
  private controller?: AbortController
  private activeClient?: Client
  private lastDeviceName?: string
  constructor(private readonly adapters: PairingAdapters) {}
  private publish(state: PairingState) {
    this.state = state
    this.onChange?.(state)
  }
  decode(code: string): PairingDetails | undefined {
    this.cancel()
    this.payload = undefined
    this.lastDeviceName = undefined
    try {
      this.payload = decodePairCode(code)
      const url = new URL(this.payload.invite.endpoint)
      const details = {
        nodeName: this.payload.node_name,
        nodeId: this.payload.invite.node_id,
        host: url.hostname,
        port: Number(url.port || 443),
        fingerprint: this.payload.invite.node_fingerprint,
        expiresAt: this.payload.invite.expires_at,
      }
      this.publish({ phase: 'decoded', details })
      return details
    } catch {
      this.publish({ phase: 'error', error: 'invalid_pair_code' })
      return undefined
    }
  }
  resetAddress(): void {
    if (!this.payload || !this.state.details) return
    const url = new URL(this.payload.invite.endpoint)
    this.publish({
      ...this.state,
      details: { ...this.state.details, host: url.hostname, port: Number(url.port || 443) },
      error: undefined,
      addressError: undefined,
    })
  }
  cancel(): void {
    this.controller?.abort()
    this.controller = undefined
    const client = this.activeClient
    this.activeClient = undefined
    if (client) void client.disconnect().catch(() => {})
    if (this.payload) this.publish({ ...this.state, phase: 'cancelled', error: undefined })
  }
  /** Call cancel when the consumer closes or backgrounds. Retry is an explicit foreground action. */
  retry(): Promise<Client | undefined> {
    if (!this.lastDeviceName) return Promise.resolve(undefined)
    return this.connect(this.lastDeviceName)
  }
  async connect(
    deviceName: string,
    address?: { host: string; port: number }
  ): Promise<Client | undefined> {
    this.cancel()
    if (!this.payload || !this.state.details) {
      this.publish({ phase: 'error', error: 'invalid_pair_code' })
      return undefined
    }
    const payload = this.payload
    const details = { ...this.state.details, ...(address ?? {}) }
    this.lastDeviceName = deviceName
    const controller = new AbortController()
    this.controller = controller
    const current = () => !controller.signal.aborted && this.controller === controller
    let client: Client | undefined
    let transferred = false
    const update = (
      phase: PairingState['phase'],
      error?: string,
      addressError?: PairingRouteFailure
    ) => {
      if (current())
        this.publish({ ...this.state, phase, details, deviceName, error, addressError })
    }
    try {
      DeviceNameSchema.parse(deviceName)
      if (
        !Number.isInteger(details.port) ||
        details.port < 1 ||
        details.port > 65535 ||
        !details.host ||
        /[\s/@?#]/u.test(details.host)
      )
        throw new Error('endpoint_refused')
      const endpoint = new URL(`wss://${details.host}:${details.port}/channel`).href
      assertPairedTransportEndpoint(endpoint)
      const attempts = this.adapters.maxAttempts ?? 120
      if (!Number.isInteger(attempts) || attempts < 1 || attempts > 1000)
        throw new Error('invalid_pairing_configuration')
      update('claiming')
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (!current()) return undefined
        try {
          // Same invite and connector/key namespace on EVERY retry, including lost replies.
          const claim = await this.adapters.connector.claim(payload.invite, {
            deviceName,
            endpoint,
          })
          if (!current()) return undefined
          this.publish({
            ...this.state,
            deviceFingerprint: shortPairingFingerprint(claim.device_fingerprint),
          })
          if (claim.state === 'confirmed') {
            update('connecting')
            const target = await this.adapters.connector.target(payload.invite.node_id)
            if (!current()) return undefined
            client = this.adapters.createClient(target)
            this.activeClient = client
            await client.connect()
            if (!current()) {
              await client.disconnect()
              return undefined
            }
            if (!client.connected) throw new Error('connection_failed')
            // Notification can synchronously cancel/reenter the session. Keep the
            // client provisional until that callback returns and the generation holds.
            update('connected')
            if (!current()) return undefined
            this.activeClient = undefined // Authenticated connection ownership passes to caller.
            transferred = true
            return client
          }
        } catch (error) {
          if (!current()) return undefined
          // Authentication is a terminal step: do not register/loop a failed connected client.
          if (client || !transient.has(errorCode(error))) throw error
        }
        if (attempt + 1 < attempts) {
          update('waiting')
          await (this.adapters.wait ?? wait)(
            Math.min(500 * 2 ** Math.min(attempt, 4), 4000),
            controller.signal
          )
        }
      }
      throw new Error('pairing_wait_timeout')
    } catch (error) {
      if (client) await client.disconnect().catch(() => {})
      const failure = PairingRouteFailureSchema.safeParse(
        error instanceof ChannelError ? error.details : undefined
      )
      update('error', errorCode(error), failure.success ? failure.data : undefined)
      return undefined
    } finally {
      // NodeClient may attach its channel before replay rejects. Cancellation must
      // close that late channel on rejection too, not only on a late resolution.
      if (client && !transferred) await client.disconnect().catch(() => {})
      if (this.controller === controller) {
        this.controller = undefined
        this.activeClient = undefined
      }
    }
  }
}
