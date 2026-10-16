import { expect, it, vi } from 'vitest'
import { MemoryClientStore, NodeClient } from '../packages/node-client/src/index.js'
import {
  FrameCodec,
  LIMITS,
  type RecordTransport,
  type AuthenticatedChannel,
} from '../packages/channel-protocol/src/index.js'

// A streamed answer arrives as hundreds of events a second. A device whose store is slow (a
// phone's IndexedDB takes tens of milliseconds a transaction) must not spend a transaction on
// each: events that arrive while one is being written are kept together in the next.
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

function setup() {
  const store = new MemoryClientStore()
  const sent: { method?: string; params?: { seq?: number; after_seq?: number } }[] = []
  const transport: RecordTransport = {
    send: async (b) => {
      sent.push(FrameCodec.decode(b) as never)
    },
    close: async () => {},
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
  const client = new NodeClient(
    { url: 'ws://127.0.0.1:7777/channel', profile: 'local-token-v1', token: 'a'.repeat(64) },
    store
  )
  client.attach(channel)
  // The receive loop hands events over one by one, awaiting each, as RequestChannel does.
  const deliver = (frame: unknown) =>
    (client as unknown as { channel: { onEvent: (e: unknown) => Promise<void> } }).channel.onEvent(
      frame
    )
  return { store, client, sent, deliver }
}

it('keeps events that arrive during a slow write together in the next one, acks the last and tells listeners in order', async () => {
  const f = setup()
  await f.store.transaction((s) => {
    s.node_id = 'node'
  })
  const transaction = f.store.transaction.bind(f.store)
  let writes = 0
  f.store.transaction = async (work) => {
    writes++
    await new Promise((r) => setTimeout(r, 20))
    return transaction(work)
  }
  const heard: number[] = []
  f.client.onEvent((e) => heard.push(e.seq))
  for (let seq = 1; seq <= 50; seq++) await f.deliver(event(seq))
  await vi.waitFor(() => expect(heard).toHaveLength(50), { timeout: 5000 })
  expect(heard).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
  expect(await transaction((s) => s.cursors.session)).toBe(50)
  expect(await transaction((s) => s.events.session?.length)).toBe(50)
  expect(writes).toBeLessThan(10)
  const acks = f.sent.filter((r) => r.method === 'stream.ack')
  expect(acks.at(-1)?.params?.seq).toBe(50)
  expect(acks.length).toBeLessThan(10)
})

it('asks again from the cursor on a gap within a burst, once', async () => {
  const f = setup()
  await f.store.transaction((s) => {
    s.node_id = 'node'
  })
  for (const seq of [1, 2, 5, 6]) await f.deliver(event(seq))
  await vi.waitFor(async () => expect(await f.client.cursor('session')).toBe(2))
  await vi.waitFor(() =>
    expect(
      f.sent.filter((r) => r.method === 'stream.subscribe').map((r) => r.params?.after_seq)
    ).toEqual([2])
  )
})
