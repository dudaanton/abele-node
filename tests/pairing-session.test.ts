import { expect, it, vi } from 'vitest'
import { ChannelError } from '@abele/channel-protocol'
import { encodePairCode } from '@abele/node-protocol'
import { PairingSession } from '../packages/node-client/src/pairing-session.js'
const invite = {
  endpoint: 'wss://node.example.ts.net:8443/channel',
  node_id: 'node-id',
  node_fingerprint: 'a'.repeat(64),
  invite_id: 'invite-id',
  secret: 'b'.repeat(64),
  expires_at: 1,
}
const code = encodePairCode({ version: 1, node_name: 'Test node', invite })
const claim = {
  installation_id: 'installation-id',
  device_fingerprint: 'c'.repeat(64),
  state: 'pending' as const,
}
function setup() {
  const connector = {
    claim: vi.fn().mockResolvedValue({ ...claim, state: 'confirmed' }),
    target: vi.fn().mockResolvedValue({
      profile: 'paired-wss-v1',
      url: invite.endpoint,
      expected_node_id: invite.node_id,
    }),
  }
  const client = {
    connected: false,
    connect: vi.fn(async () => {
      client.connected = true
    }),
    disconnect: vi.fn(async () => {
      client.connected = false
    }),
  }
  const wait = vi.fn(async (_ms: number, _signal: AbortSignal) => {})
  const model = new PairingSession({
    connector,
    createClient: () => client,
    wait,
    maxAttempts: 4,
  })
  return { model, connector, client, wait }
}
it('decodes without network, edits/reset address, retries lost replies with the same invite, waits for authenticated connect', async () => {
  const { model, connector, client, wait } = setup()
  model.decode(code)
  expect(connector.claim).not.toHaveBeenCalled()
  expect(model.state.details).toMatchObject({
    nodeName: 'Test node',
    host: 'node.example.ts.net',
    port: 8443,
    fingerprint: invite.node_fingerprint,
  })
  connector.claim
    .mockRejectedValueOnce(new ChannelError('connection_closed'))
    .mockResolvedValueOnce(claim)
  const phases: string[] = []
  model.onChange = (state) => {
    phases.push(state.phase)
  }
  await model.connect('Test device', { host: 'alternate.example', port: 9443 })
  expect(phases).toContain('waiting')
  expect(phases.indexOf('connecting')).toBeLessThan(phases.indexOf('connected'))
  expect(client.connect).toHaveBeenCalledTimes(1)
  expect(wait).toHaveBeenCalledTimes(2)
  expect(model.state.deviceFingerprint).toBe('cccc cccc')
  for (const call of connector.claim.mock.calls) {
    expect(call[0]).toEqual(invite)
    expect(call[1]).toEqual({
      deviceName: 'Test device',
      endpoint: 'wss://alternate.example:9443/channel',
    })
  }
  model.resetAddress()
  expect(model.state.details?.host).toBe('node.example.ts.net')
})
it('pin errors are terminal and malformed addresses never reach the connector', async () => {
  const { model, connector, wait } = setup()
  model.decode(code)
  await model.connect('Test device', { host: 'bad.example/path', port: 1 })
  expect(model.state.phase).toBe('error')
  expect(connector.claim).not.toHaveBeenCalled()
  connector.claim.mockRejectedValue(new ChannelError('node_identity_mismatch'))
  model.resetAddress()
  await model.connect('Test device')
  expect(model.state.error).toBe('node_identity_mismatch')
  expect(connector.claim).toHaveBeenCalledTimes(1)
  expect(wait).not.toHaveBeenCalled()
})
it('cancellation fences an in-flight claim and retry retains the same decoded invitation', async () => {
  const { model, connector, client } = setup()
  model.decode(code)
  let release!: (value: typeof claim) => void
  connector.claim.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve
      })
  )
  const task = model.connect('Test device')
  model.cancel()
  release(claim)
  await task
  expect(model.state.phase).toBe('cancelled')
  expect(client.connect).not.toHaveBeenCalled()
  await model.retry()
  expect(model.state.phase).toBe('connected')
  expect(connector.claim.mock.calls[1]![0]).toEqual(invite)
})
it('cancellation during authentication closes late connections instead of showing success', async () => {
  const { model, client } = setup()
  model.decode(code)
  let release!: () => void
  client.connect.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = () => {
          client.connected = true
          resolve()
        }
      })
  )
  const task = model.connect('Test device')
  while (!release) await Promise.resolve()
  model.cancel()
  release()
  await task
  expect(client.connected).toBe(false)
  expect(model.state.phase).toBe('cancelled')
})
it('cancellation also closes a channel attached before connect rejects late', async () => {
  const { model, client } = setup()
  model.decode(code)
  let rejectLate!: () => void
  client.connect.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectLate = () => {
          client.connected = true
          reject(new Error('replay_failed'))
        }
      })
  )
  const task = model.connect('Test device')
  while (!rejectLate) await Promise.resolve()
  model.cancel()
  rejectLate()
  await task
  expect(client.connected).toBe(false)
  expect(model.state.phase).toBe('cancelled')
})
it('cancellation from the connected notification closes the provisional client instead of transferring it', async () => {
  const { model, client } = setup()
  model.decode(code)
  model.onChange = (state) => {
    if (state.phase === 'connected') model.cancel()
  }
  const returned = await model.connect('Test device')
  expect(returned).toBeUndefined()
  expect(client.connected).toBe(false)
  expect(client.disconnect).toHaveBeenCalled()
  expect(model.state.phase).toBe('cancelled')
})
it('retains typed address diagnostics without raw transport exception text', async () => {
  const { model, connector } = setup()
  model.decode(code)
  connector.claim.mockRejectedValue(
    new ChannelError('paired_route_tls', 'paired_route_tls', {
      reason: 'tls',
      address: invite.endpoint,
    })
  )
  await model.connect('Test device')
  expect(model.state.addressError).toEqual({ reason: 'tls', address: invite.endpoint })
  expect(model.state.error).toBe('paired_route_tls')
  model.resetAddress()
  expect(model.state.addressError).toBeUndefined()
})
it('bounded pending polling never becomes connected on exhaustion', async () => {
  const { model, connector, client } = setup()
  model.decode(code)
  connector.claim.mockResolvedValue(claim)
  await model.connect('Test device')
  expect(model.state.error).toBe('pairing_wait_timeout')
  expect(connector.claim).toHaveBeenCalledTimes(4)
  expect(client.connect).not.toHaveBeenCalled()
})
