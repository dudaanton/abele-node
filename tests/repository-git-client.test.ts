import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { NodeClient, MemoryClientStore } from '../packages/node-client/src/index.js'
import { startDaemon, offlineToken } from '../packages/node-daemon/src/index.js'
import { GIT_WRITE_ERROR_MESSAGES } from '../packages/node-protocol/src/index.js'

const cleanup: (() => unknown | Promise<unknown>)[] = []
const home = process.env.HOME
beforeAll(() => {
  mkdirSync('.scratch', { recursive: true })
  const empty = mkdtempSync(resolve('.scratch/git-client-home-'))
  process.env.HOME = empty
  cleanup.push(() => rmSync(empty, { recursive: true, force: true }))
})
afterAll(() => {
  process.env.HOME = home
})
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
it('drives git writes through the client with receipts, results and the write capability', async () => {
  const dir = mkdtempSync(resolve('.scratch/repository-git-client-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo'),
    linked = join(dir, 'linked'),
    state = join(dir, 'state')
  mkdirSync(repo)
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    return r.stdout.trim()
  }
  git(repo, 'init', '-b', 'trunk')
  git(repo, 'config', 'user.name', 'Fixture')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(repo, 'file'), 'before\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'fixture')
  git(repo, 'worktree', 'add', '-b', 'side', linked)
  const token = (await offlineToken(state, { action: 'create', value: 'fixture' })) as {
    token: string
  }
  const daemon = await startDaemon(state, 0)
  cleanup.push(() => daemon.stop())
  const client = new NodeClient(
    { url: `ws://127.0.0.1:${daemon.port}/channel`, profile: 'local-token-v1', token: token.token },
    new MemoryClientStore()
  )
  cleanup.push(() => client.disconnect())
  await client.connect()
  expect(
    ((await client.describe()) as any).capabilities.capabilities.repository_git_write_v1.status
  ).toBe('supported')
  const project = await client.registerProject(repo, 'untrusted')
  await client.setRepositorySettings({ project_id: project.project_id, external_read: true })
  const worktree_id = (
    await client.repository.worktrees({ project_id: project.project_id })
  ).entries.find((e) => e.kind === 'external')!.worktree_id
  const head = git(linked, 'rev-parse', 'HEAD')
  writeFileSync(join(linked, 'file'), 'after\n')
  const info = await client.repository.git.info({ worktree_id })
  expect(info).toMatchObject({ head, branch: 'refs/heads/side', remotes: [], operation: null })
  await expect(
    client.repository.git.stage({ worktree_id, expected_head: head, all: true })
  ).rejects.toThrow('unauthorized')
  expect(GIT_WRITE_ERROR_MESSAGES.unauthorized).toMatch(/editing/)
  await client.repository.editing({ worktree_id, enabled: true })
  expect(
    await client.repository.git.stage({ worktree_id, expected_head: head, all: true })
  ).toEqual({ state: 'applied', head })
  const committed = await client.repository.git.commit(
    { worktree_id, expected_head: head, message: 'feat: from the client' },
    'client-commit'
  )
  expect(committed).toMatchObject({ state: 'committed', parent: head })
  expect(
    await client.repository.git.commit(
      { worktree_id, expected_head: head, message: 'feat: from the client' },
      'client-commit'
    )
  ).toEqual(committed)
  expect(git(linked, 'rev-list', '--count', 'HEAD')).toBe('2')
  const push = await client.repository.git.push({
    worktree_id,
    expected_head: committed.state === 'committed' ? committed.commit : '',
  })
  expect(push).toMatchObject({ state: 'failed', code: 'no_remote' })
  if (push.state === 'failed') expect(push.message).toBe(GIT_WRITE_ERROR_MESSAGES.no_remote)
  expect(await client.repository.git.fetch({ worktree_id })).toMatchObject({
    state: 'failed',
    code: 'no_remote',
  })
  const branch = await client.repository.git.createBranch(
    { worktree_id, name: 'side-two', start_point: head },
    'client-branch'
  )
  expect(branch).toEqual({
    state: 'created',
    branch: 'refs/heads/side-two',
    commit: head,
    switched: false,
    head: git(linked, 'rev-parse', 'HEAD'),
  })
  expect(
    await client.repository.git.createBranch(
      { worktree_id, name: 'side-two', start_point: head },
      'client-branch'
    )
  ).toEqual(branch)
  expect(git(repo, 'rev-parse', 'refs/heads/side-two')).toBe(head)
}, 30000)
