import { expect, it } from 'vitest'
import { NodeClient, MemoryClientStore } from '../packages/node-client/src/index.js'
import { LIMITS, type AuthenticatedChannel } from '../packages/channel-protocol/src/index.js'
it('returns the durable review identity even when sending loses its outcome', async () => {
  const store = new MemoryClientStore()
  await store.transaction((s) => {
    s.node_id = 'node'
    s.installation_id = 'fixture'
  })
  const client = new NodeClient(
    { url: 'ws://127.0.0.1:7777/channel', profile: 'local-token-v1', token: 'a'.repeat(64) },
    store
  )
  client.attach({
    transport: { send: async () => {}, close: async () => {}, receive: async function* () {} },
    authority: { installation_id: 'fixture' },
    welcome: {
      kind: 'welcome',
      node_id: 'node',
      installation_id: 'fixture',
      version: { major: 0, minor: 0 },
      instance_id: 'fixture',
      methods: [],
      limits: LIMITS,
      capabilities: {},
    },
  } satisfies AuthenticatedChannel)
  client.flush = async () => {
    throw new Error('outcome_unknown')
  }
  const submitted = await client.submitReview({
    session_id: 'session',
    observed_seq: 0,
    anchors: [
      {
        node_id: 'node',
        workspace_id: 'workspace',
        diff_id: 'diff',
        path: 'sample',
        side: 'new',
        start_line: 1,
        end_line: 1,
        context_hash: 'a'.repeat(64),
        comment: 'Explain',
      },
    ],
  })
  expect((await client.pending())[0]?.operation_id).toBe(submitted.operation_id)
  expect(await client.reviewResult(submitted.operation_id)).toBeUndefined()
  await client.disconnect()
})
