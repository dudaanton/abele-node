import { expect, it } from 'vitest'
import { MemoryClientStore, NodeClient } from '../packages/node-client/src/index.js'
import {
  FrameCodec,
  LIMITS,
  assertLocalEndpoint,
  type RecordTransport,
  type AuthenticatedChannel,
} from '../packages/channel-protocol/src/index.js'

it('refuses remote endpoints, URL tokens, hostnames, alternate profiles and paths', () => {
  for (const url of [
    'ws://localhost:7777/channel',
    'ws://192.168.0.2/channel',
    'wss://127.0.0.1/channel',
    'ws://127.0.0.1/channel?token=x',
    'ws://127.0.0.1/other',
  ])
    expect(() =>
      assertLocalEndpoint({ url, token: 'a'.repeat(64), profile: 'local-token-v1' })
    ).toThrow('endpoint_refused')
})

it('persisted outbox survives a new client; gaps stop advancement and cursor failures never ack', async () => {
  const store = new MemoryClientStore()
  await store.transaction((s) => {
    s.node_id = 'node'
  })
  const target = {
    url: 'ws://127.0.0.1:7777/channel',
    profile: 'local-token-v1' as const,
    token: 'a'.repeat(64),
  }
  const client = new NodeClient(target, store)
  const op = await client.send('session', 'offline', 0)
  const reloaded = new NodeClient(target, store)
  expect((await reloaded.pending())[0]?.operation_id).toBe(op.operation_id)
  const sent: unknown[] = []
  let close = false
  const transport: RecordTransport = {
    send: async (b) => {
      sent.push(FrameCodec.decode(b))
    },
    close: async () => {
      close = true
    },
    receive: async function* () {},
  }
  const channel = {
    transport,
    authority: { installation_id: 'i' },
    welcome: {
      kind: 'welcome',
      node_id: 'node',
      installation_id: 'i',
      version: { major: 0, minor: 0 },
      instance_id: 'test',
      methods: [],
      limits: LIMITS,
      capabilities: {},
    },
  } satisfies AuthenticatedChannel
  reloaded.attach(channel)
  const event = (seq: number) => ({
    kind: 'event',
    node_id: 'node',
    stream_id: 'session',
    seq,
    type: 'unknown.optional',
    actor: { kind: 'node' },
    at: new Date().toISOString(),
    data: { text: 'kept' },
  })
  await reloaded.ingest(event(2))
  expect(await reloaded.cursor('session')).toBe(0)
  expect(sent.some((r) => (r as { method?: string }).method === 'stream.subscribe')).toBe(true)
  await reloaded.ingest(event(1))
  await reloaded.ingest(event(1))
  await reloaded.ingest(event(2))
  expect(await reloaded.cursor('session')).toBe(2)
  expect(await reloaded.history('session')).toHaveLength(2)
  store.fault = () => {
    throw new Error('cursor_storage_failure')
  }
  await expect(reloaded.ingest(event(3))).rejects.toThrow('cursor_storage_failure')
  expect(close).toBe(true)
  store.fault = undefined
  expect(await reloaded.cursor('session')).toBe(2)
  await reloaded.disconnect()
})

it('a stored node binding cannot override an explicit enrollment binding', async () => {
  const store = new MemoryClientStore()
  await store.transaction((s) => {
    s.node_id = 'stored-node'
  })
  const connector = {
    connect: async () => {
      throw new Error('must_not_open_transport')
    },
  }
  const client = new NodeClient(
    {
      url: 'ws://127.0.0.1:7777/channel',
      profile: 'local-token-v1',
      token: 'a'.repeat(64),
      expected_node_id: 'other-node',
    },
    store,
    connector
  )
  await expect(client.connect()).rejects.toThrow('node_identity_mismatch')
})

it('an outbox cannot be replayed under a different installation principal', async () => {
  const store = new MemoryClientStore()
  await store.transaction((s) => {
    s.node_id = 'node'
    s.installation_id = 'old'
    s.outbox.push({
      operation_id: 'pending',
      method: 'session.send',
      params: { session_id: 's', text: 'x', observed_seq: 0 },
    })
  })
  let sent = 0
  const channel = {
    transport: {
      send: async () => {
        sent++
      },
      receive: async function* () {},
      close: async () => {},
    },
    authority: { installation_id: 'new' },
    welcome: {
      kind: 'welcome',
      node_id: 'node',
      installation_id: 'new',
      version: { major: 0, minor: 0 },
      instance_id: 'test',
      methods: [],
      limits: LIMITS,
      capabilities: {},
    },
  } satisfies AuthenticatedChannel
  const client = new NodeClient(
    { url: 'ws://127.0.0.1:7777/channel', profile: 'local-token-v1', token: 'a'.repeat(64) },
    store,
    { connect: async () => channel }
  )
  await expect(client.connect()).rejects.toThrow('installation_identity_mismatch')
  expect(sent).toBe(0)
  expect(await client.pending()).toHaveLength(1)
})

it('outgoing malformed input never enters the durable outbox', async () => {
  const store = new MemoryClientStore()
  await store.transaction((s) => {
    s.node_id = 'node'
  })
  const client = new NodeClient(
    { url: 'ws://127.0.0.1:7777/channel', profile: 'local-token-v1', token: 'a'.repeat(64) },
    store
  )
  await expect(client.send('session', '', 0)).rejects.toThrow()
  await expect(client.send('session', 'text', Number.MAX_SAFE_INTEGER + 1)).rejects.toThrow()
  expect(await client.pending()).toHaveLength(0)
})
