import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { NodeClient, MemoryClientStore } from '../packages/node-client/src/index.js'
import { startDaemon, offlineToken } from '../packages/node-daemon/src/index.js'
const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(check: () => Promise<boolean>) {
  const end = Date.now() + 10000
  while (Date.now() < end) {
    if (await check()) return
    await delay(25)
  }
  throw new Error('repository notification deadline')
}
it('uses the real client/daemon boundary for browsing, retained bytes, live invalidations and reconnect', async () => {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/repository-client-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo'),
    state = join(dir, 'state')
  mkdirSync(repo)
  const git = (...args: string[]) => {
    const result = spawnSync('/usr/bin/git', args, { cwd: repo, encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    return result.stdout.trim()
  }
  git('init', '-b', 'trunk')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  mkdirSync(join(repo, 'nested'))
  writeFileSync(join(repo, 'nested', 'sample'), 'fixture\n')
  git('add', '.')
  git('commit', '-m', 'fixture')
  const token = (await offlineToken(state, { action: 'create', value: 'fixture' })) as {
    token: string
  }
  let daemon = await startDaemon(state, 0)
  cleanup.push(() => daemon.stop())
  const store = new MemoryClientStore()
  const makeClient = () =>
    new NodeClient(
      {
        url: `ws://127.0.0.1:${daemon.port}/channel`,
        profile: 'local-token-v1',
        token: token.token,
      },
      store
    )
  let client = makeClient()
  cleanup.push(() => client.disconnect())
  await client.connect()
  const project = await client.registerProject(repo, 'untrusted')
  expect(
    ((await client.describe()) as any).capabilities.capabilities.repository_read_v1.status
  ).toBe('supported')
  await client.setRepositorySettings({ project_id: project.project_id, external_read: true })
  const worktree_id = (await client.repository.worktrees({ project_id: project.project_id }))
    .entries[0]!.worktree_id
  const revision = await client.repository.resolve({ worktree_id, ref: 'HEAD' })
  const params = { worktree_id, revision }
  const tree = await client.repository.tree(params)
  expect(tree.entries[0]!.kind).toBe('directory')
  const blob = await client.repository.blob({ ...params, path: 'nested/sample' })
  expect(
    Buffer.from(
      (await client.repository.content({ worktree_id, content_id: blob.content_id! })).base64,
      'base64'
    ).toString()
  ).toBe('fixture\n')
  expect((await client.repository.refs({ worktree_id })).default_branch).toBeNull()
  expect((await client.repository.history(params)).entries[0]!.subject).toBe('fixture')
  expect((await client.repository.commit(params)).subject).toBe('fixture')
  expect(
    (await client.repository.blame({ ...params, path: 'nested/sample' })).entries[0]!.author
  ).toBe('Fixture')
  expect(
    (await client.repository.search({ ...params, query: 'fixture', path_glob: 'nested/**' }))
      .entries[0]!.line
  ).toBe(1)
  await client.subscribe('catalog')
  const watch = await client.repository.watch({ worktree_id })
  await until(async () =>
    (await client.history('catalog')).some(
      (e) => e.type === 'repository.invalidated' && (e.data as any).reason === 'reconnect'
    )
  )
  const cursor = await client.cursor('catalog')
  // Nested edits are found by periodic reconciliation even on nonrecursive watcher platforms.
  writeFileSync(join(repo, 'nested', 'sample'), 'external edit\n')
  await until(async () =>
    (await client.history('catalog')).some(
      (e) => e.seq > cursor && e.type === 'repository.invalidated'
    )
  )
  const working = await client.repository.observe({ worktree_id })
  expect(
    (await client.repository.status({ worktree_id, revision: working.revision })).entries[0]!
      .worktree
  ).toBe('M')
  const comparison = await client.repository.compare({
    worktree_id,
    base: revision,
    head: working.revision,
  })
  const patch = await client.repository.patch({
    worktree_id,
    comparison_id: comparison.comparison_id,
    path: 'nested/sample',
  })
  expect(
    Buffer.from(
      (await client.repository.content({ worktree_id, content_id: patch.content_id! })).base64,
      'base64'
    ).toString()
  ).toContain('+external edit')
  await client.repository.unwatch({ worktree_id, subscription_id: watch.subscription_id })
  await client.disconnect()
  await daemon.stop()
  daemon = await startDaemon(state, 0)
  client = makeClient()
  await client.connect()
  expect(
    (await client.repository.worktrees({ project_id: project.project_id })).entries[0]!.worktree_id
  ).toBe(worktree_id)
  expect(
    Buffer.from(
      (await client.repository.content({ worktree_id, content_id: blob.content_id! })).base64,
      'base64'
    ).toString()
  ).toBe('fixture\n')
  await expect(client.repository.tree({ worktree_id, revision: working.revision })).rejects.toThrow(
    'stale_revision'
  )
  const renewed = await client.repository.watch({ worktree_id })
  expect(renewed.refresh_required).toBe(true)
  const beforeRef = await client.cursor('catalog')
  git('branch', 'external-ref')
  await until(async () =>
    (await client.history('catalog')).some(
      (e) => e.seq > beforeRef && e.type === 'repository.invalidated'
    )
  )
  await client.repository.unwatch({ worktree_id, subscription_id: renewed.subscription_id })
}, 30000)
