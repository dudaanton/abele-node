import { expect, it, vi } from 'vitest'
import {
  PairedWssConnector,
  type DeviceKeyStore,
  type PairedDevice,
} from '../packages/node-client/src/paired.js'
import { generateIdentity, LIMITS, type RecordTransport } from '@abele/channel-protocol'

it.each(['claim', 'connect'] as const)(
  'a paired %s transport opening after auth timeout is closed without transmitting credentials',
  async (mode) => {
    const device: PairedDevice = {
      ...(await generateIdentity()),
      node_id: 'node',
      endpoint: 'wss://node.example.ts.net:8443/channel',
      node_fingerprint: '0'.repeat(64),
      installation_id: 'installation',
    }
    const keys: DeviceKeyStore = {
      load: async () => device,
      transaction: async (_node_id, work) => (await work(device)).result,
    }
    let complete!: (transport: RecordTransport) => void, entered!: () => void
    const opening = new Promise<void>((resolve) => {
      entered = resolve
    })
    const connector = new PairedWssConnector(
      keys,
      () =>
        new Promise((resolve) => {
          complete = resolve
          entered()
        })
    )
    const send = vi.fn(async () => {}),
      close = vi.fn(async () => {})
    vi.useFakeTimers()
    try {
      const attempt =
        mode === 'connect'
          ? connector.connect(await connector.target(device.node_id))
          : connector.claim({
              endpoint: device.endpoint,
              node_id: device.node_id,
              node_fingerprint: device.node_fingerprint,
              invite_id: 'invite',
              secret: 'a'.repeat(64),
              expires_at: Date.now() + 60000,
            })
      const rejected = expect(attempt).rejects.toThrow('connection_timeout')
      await opening
      await vi.advanceTimersByTimeAsync(LIMITS.auth_ms)
      await rejected
      expect(close).not.toHaveBeenCalled()
      complete({ send, close, receive: async function* () {} })
      await vi.advanceTimersByTimeAsync(0)
      expect(send).not.toHaveBeenCalled()
      expect(close).toHaveBeenCalledTimes(1)
      expect(close).toHaveBeenCalledWith('connection_timeout')
    } finally {
      vi.useRealTimers()
    }
  }
)
