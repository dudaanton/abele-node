import { afterEach, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { startDaemon, offlineToken } from '../packages/node-daemon/src/index.js'
import { NodeClient, MemoryClientStore } from '../packages/node-client/src/index.js'

const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})
function git(cwd: string, ...args: string[]) {
  const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
}
async function setup(kind: string) {
  const dir = mkdtempSync(resolve('.scratch/target-stability-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Fixture')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(repo, 'sample'), 'initial')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')
  if (kind !== 'plain') {
    const pool = join(dir, 'pool')
    mkdirSync(pool)
    const alias = join(dir, 'alias')
    symlinkSync(pool, alias)
    git(repo, 'worktree', 'add', '-b', 'topic', join(kind === 'symlink' ? alias : pool, 'topic'))
  }
  const state = join(dir, 'state')
  const { token } = (await offlineToken(state, { action: 'create', value: 'fixture' })) as {
    token: string
  }
  const connect = async () => {
    const daemon = await startDaemon(state, 0)
    cleanup.push(() => daemon.stop())
    const client = new NodeClient(
      { url: `ws://127.0.0.1:${daemon.port}/channel`, profile: 'local-token-v1', token },
      new MemoryClientStore()
    )
    cleanup.push(() => client.disconnect())
    await client.connect()
    return {
      client,
      stop: async () => {
        await client.disconnect()
        await daemon.stop()
      },
    }
  }
  const first = await connect()
  const project = await first.client.nodePath.register({ path: repo, trust: 'untrusted' })
  await first.client.setRepositorySettings({ project_id: project.project_id, external_read: true })
  const catalog = (client: NodeClient, extra = {}) =>
    client.repository.worktrees({ project_id: project.project_id, ...extra })
  return { dir, repo, project, first, connect, catalog }
}

it.each(['plain', 'worktree', 'symlink'])(
  'keeps %s target IDs across a daemon restart with the same home',
  async (kind) => {
    const s = await setup(kind)
    const before = await s.catalog(s.first.client)
    const identities = await s.catalog(s.first.client, { include_identity: true })
    expect(before.entries).toHaveLength(kind === 'plain' ? 1 : 2)
    expect(before.entries.every((e) => e.availability === 'available')).toBe(true)
    await s.first.stop()
    const second = await s.connect()
    expect(await s.catalog(second.client)).toEqual(before)
    expect(await s.catalog(second.client, { include_identity: true })).toEqual(identities)
  }
)

it('provides canonical path and pinned identity only when requested, and never reuses a replaced target ID', async () => {
  const s = await setup('plain')
  const before = await s.catalog(s.first.client)
  expect(before.entries[0]).not.toHaveProperty('identity')
  const detailed = await s.catalog(s.first.client, { include_identity: true })
  const entry = detailed.entries[0]!
  expect(entry.identity).toEqual({
    canonical_path: s.repo,
    fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
  })
  await s.first.stop()
  renameSync(s.repo, join(s.dir, 'old-repo'))
  mkdirSync(s.repo)
  git(s.repo, 'init', '-b', 'main')
  const second = await s.connect()
  await expect(
    second.client.request('repository.v1.refs', { worktree_id: entry.worktree_id })
  ).rejects.toThrow()
})

it('issues a different ID and fingerprint when linked worktree metadata is replaced', async () => {
  const s = await setup('worktree')
  const before = await s.catalog(s.first.client, { include_identity: true })
  const old = before.entries.find((e) => e.kind === 'external')!
  const gitfile = join(old.identity!.canonical_path, '.git')
  const contents = readFileSync(gitfile, 'utf8')
  renameSync(gitfile, gitfile + '.old')
  writeFileSync(gitfile, contents)
  const after = await s.catalog(s.first.client, { include_identity: true })
  const current = after.entries.find((e) => e.kind === 'external')!
  expect(current.availability).toBe('available')
  expect(current.identity!.canonical_path).toBe(old.identity!.canonical_path)
  expect(current.identity!.fingerprint).not.toBe(old.identity!.fingerprint)
  expect(current.worktree_id).not.toBe(old.worktree_id)
  await expect(
    s.first.client.request('repository.v1.refs', { worktree_id: old.worktree_id })
  ).rejects.toThrow()
})
