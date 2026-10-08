import { expect, it } from 'vitest'
import { MemoryClientStore, NodeClient } from '../packages/node-client/src/index.js'
it('can resume a save whose identity was persisted locally before outbox admission', async () => {
  const store = new MemoryClientStore()
  await store.transaction((s) => {
    s.node_id = 'fixture'
    s.installation_id = 'fixture'
  })
  const client = new NodeClient(
    { url: 'ws://127.0.0.1:7777/channel', profile: 'local-token-v1', token: 'a'.repeat(64) },
    store
  )
  const params = {
    workspace_id: 'workspace',
    path: 'sample.txt',
    expected_content_id: 'a'.repeat(64),
    text: 'draft',
  }
  await client.writeFile(params, 'retained-save')
  await client.writeFile(params, 'retained-save')
  expect((await client.pending()).map((e) => e.operation_id)).toEqual(['retained-save'])
  await expect(client.writeFile({ ...params, text: 'changed' }, 'retained-save')).rejects.toThrow(
    'idempotency_mismatch'
  )
  await store.transaction((s) => {
    s.outbox = []
    s.results['retained-save'] = { error: 'unsafe_path' }
  })
  await client.writeFile(params, 'retained-save')
  expect(await client.pending()).toEqual([])
})
