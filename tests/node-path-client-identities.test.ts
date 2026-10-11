import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { NodeClient, MemoryClientStore } from '../packages/node-client/src/index.js'
import { startDaemon, offlineToken } from '../packages/node-daemon/src/index.js'
const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
async function setup() {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/client-identities-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const folder = join(dir, 'folder')
  mkdirSync(folder)
  writeFileSync(join(folder, 'source'), 'contents')
  const state = join(dir, 'state'),
    token = (await offlineToken(state, { action: 'create', value: 'fixture' })) as { token: string }
  const daemon = await startDaemon(state, 0)
  cleanup.push(() => daemon.stop())
  const store = new MemoryClientStore(),
    target = {
      url: `ws://127.0.0.1:${daemon.port}/channel`,
      profile: 'local-token-v1' as const,
      token: token.token,
    }
  const makeClient = () => {
    const client = new NodeClient(target, store)
    cleanup.push(() => client.disconnect())
    return client
  }
  const client = makeClient()
  await client.connect()
  const project = await client.nodePath.register({
    path: folder,
    trust: 'untrusted',
    exact_root: true,
  })
  const workspace_id = (await client.listWorkspaces(project.project_id))[0]!.workspace_id
  const params = {
    workspace_id,
    from: 'source',
    to: 'copy',
    expected_content_id: createHash('sha256').update('contents').digest('hex'),
  }
  return { folder, client, store, params, makeClient }
}
it('persists every retained mutation identity and rejects different methods or normalized parameters without returning old success', async () => {
  const s = await setup(),
    copied = await s.client.nodePath.fileCopy(s.params, 'retained-id')
  expect(copied.state).toBe('applied')
  await s.client.disconnect()
  const reloaded = s.makeClient()
  await reloaded.connect()
  const wire = vi.spyOn((reloaded as any).channel, 'request')
  expect(await reloaded.nodePath.fileCopy(s.params, 'retained-id')).toEqual(copied)
  await expect(
    reloaded.nodePath.fileRemove(
      {
        workspace_id: s.params.workspace_id,
        path: 'source',
        expected_content_id: s.params.expected_content_id,
      },
      'retained-id'
    )
  ).rejects.toThrow('idempotency_mismatch')
  await expect(
    reloaded.nodePath.fileCopy({ ...s.params, to: 'different' }, 'retained-id')
  ).rejects.toThrow('idempotency_mismatch')
  expect(wire).not.toHaveBeenCalled()
  expect(existsSync(join(s.folder, 'source'))).toBe(true)
  expect(existsSync(join(s.folder, 'different'))).toBe(false)
})
it('compares schema-normalized defaults rather than rejecting equivalent mutation inputs', async () => {
  const s = await setup()
  const created = await s.client.nodePath.createSession({}, 'normalized-id')
  expect(
    await s.client.nodePath.createSession(
      { provider: 'fake', title: 'Fake session' },
      'normalized-id'
    )
  ).toEqual(created)
  await expect(
    s.client.nodePath.createSession({ title: 'different' }, 'normalized-id')
  ).rejects.toThrow('idempotency_mismatch')
})
it('refuses a legacy receipt with no retained request identity instead of assuming it belongs to a new mutation', async () => {
  const s = await setup()
  await s.store.transaction((state) => {
    state.results['legacy-id'] = {
      result: { operation_id: 'legacy-id', state: 'applied', recovery_path: null },
    }
  })
  await expect(s.client.nodePath.fileCopy(s.params, 'legacy-id')).rejects.toThrow(
    'idempotency_mismatch'
  )
  expect(existsSync(join(s.folder, 'copy'))).toBe(false)
})
