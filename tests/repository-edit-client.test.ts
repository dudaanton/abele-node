import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { NodeClient, MemoryClientStore } from '../packages/node-client/src/index.js'
import { startDaemon, offlineToken } from '../packages/node-daemon/src/index.js'
const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
it('persists exact repository saves offline and replays receipts across daemon restart', async () => {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/repository-edit-client-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo'),
    linked = join(dir, 'linked'),
    state = join(dir, 'state')
  mkdirSync(repo)
  const git = (...args: string[]) => {
    const r = spawnSync('/usr/bin/git', args, { cwd: repo, encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
  }
  git('init', '-b', 'trunk')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(repo, 'file'), 'before\n')
  git('add', '.')
  git('commit', '-m', 'fixture')
  git('worktree', 'add', '-b', 'side', linked)
  const token = (await offlineToken(state, { action: 'create', value: 'fixture' })) as {
    token: string
  }
  let daemon = await startDaemon(state, 0)
  cleanup.push(() => daemon.stop())
  const store = new MemoryClientStore()
  const make = () =>
    new NodeClient(
      {
        url: `ws://127.0.0.1:${daemon.port}/channel`,
        profile: 'local-token-v1',
        token: token.token,
      },
      store
    )
  let client = make()
  cleanup.push(() => client.disconnect())
  await client.connect()
  const project = await client.registerProject(repo, 'untrusted')
  await client.setRepositorySettings({ project_id: project.project_id, external_read: true })
  const worktree_id = (
    await client.repository.worktrees({ project_id: project.project_id })
  ).entries.find((e) => e.kind === 'external')!.worktree_id
  expect(
    ((await client.describe()) as any).capabilities.capabilities.repository_editing_v1.status
  ).toBe('supported')
  const params = {
    worktree_id,
    path: 'file',
    expected_content_id: hash('before\n'),
    text: 'after\n',
  }
  const refused = await client.repository.write(params)
  await expect(client.repository.mutationResult(refused.operation_id)).rejects.toThrow(
    'unauthorized'
  )
  await client.repository.editing({ worktree_id, enabled: true })
  await client.disconnect()
  const save = await client.repository.write(params, 'offline-save')
  expect(await client.repository.mutationResult(save.operation_id)).toBeUndefined()
  expect((await store.transaction((s) => s.outbox))[0]).toMatchObject({
    method: 'repository.v1.write',
    operation_id: 'offline-save',
    params,
  })
  await client.connect()
  const saved = await client.repository.mutationResult(save.operation_id)
  expect(saved?.state).toBe('saved')
  expect((await client.operationResult(save.operation_id))?.request).toEqual({
    method: 'repository.v1.write',
    params,
  })
  expect(readFileSync(join(linked, 'file'), 'utf8')).toBe('after\n')
  await client.disconnect()
  await daemon.stop()
  writeFileSync(join(linked, 'file'), 'later\n')
  daemon = await startDaemon(state, 0)
  client = make()
  await client.connect()
  expect(await client.repository.write(params, save.operation_id)).toEqual(save)
  expect(await client.repository.mutationResult(save.operation_id)).toEqual(saved)
  expect(readFileSync(join(linked, 'file'), 'utf8')).toBe('later\n')
  const recovery = await client.repository.readRecovery({
    worktree_id,
    recovery_path: saved!.recovery_path!,
  })
  expect(Buffer.from(recovery.base64, 'base64').toString()).toBe('before\n')
  const restored = await client.repository.restore({
    worktree_id,
    path: 'file',
    expected_content_id: hash('later\n'),
    recovery_path: saved!.recovery_path!,
  })
  expect((await client.repository.mutationResult(restored.operation_id))?.state).toBe('saved')
  await client.repository.editing({ worktree_id, enabled: false })
  const rejected = await client.repository.write({ ...params, text: 'no approval\n' })
  await expect(client.repository.mutationResult(rejected.operation_id)).rejects.toThrow(
    'unauthorized'
  )
}, 30000)
