import { afterEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  renameSync,
  realpathSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeClient, MemoryClientStore } from '../packages/node-client/src/index.js'
import { startDaemon, offlineToken } from '../packages/node-daemon/src/index.js'
import { systemProcessProbe } from '@abele/provider-claude'
import { GitRunner } from '@abele/node-core'

const cleanup: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const fn of cleanup.splice(0).reverse()) await fn()
  vi.unstubAllEnvs()
})
async function setup() {
  const dir = mkdtempSync(resolve('.scratch/stale-resource-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const state = join(dir, 'state')
  const home = join(dir, 'home')
  mkdirSync(home)
  vi.stubEnv('HOME', home)
  const token = (await offlineToken(state, { action: 'create', value: 'fixture' })) as {
    token: string
  }
  const start = async () => {
    const daemon = await startDaemon(state, 0)
    cleanup.push(() => daemon.stop())
    const client = new NodeClient(
      {
        url: `ws://127.0.0.1:${daemon.port}/channel`,
        profile: 'local-token-v1',
        token: token.token,
      },
      new MemoryClientStore()
    )
    cleanup.push(() => client.disconnect())
    await client.connect()
    return { daemon, client }
  }
  return { dir, start }
}
const git = (cwd: string, ...args: string[]) => {
  const p = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' })
  if (p.status) throw new Error(p.stderr)
  return p.stdout
}
it('returns a recoverable stale handle after restart or expiry without creating a child', async () => {
  const s = await setup()
  const first = await s.start()
  symlinkSync(s.dir, join(s.dir, 'logical'))
  const page = await first.client.nodePath.directories({ path: join(s.dir, 'logical') })
  expect(page.path).toBe(s.dir)
  await first.client.disconnect()
  await first.daemon.stop()
  const { client } = await s.start()
  await expect(
    client.nodePath.mkdir({ directory_id: page.directory_id, name: 'child' }, 'old')
  ).rejects.toThrow('stale_resource')
  const fresh = await client.nodePath.directories({ path: page.path })
  const now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61000)
  await expect(
    client.nodePath.mkdir({ directory_id: fresh.directory_id, name: 'child' }, 'expired')
  ).rejects.toThrow('stale_resource')
  clock.mockRestore()
  expect(existsSync(join(s.dir, 'child'))).toBe(false)
  const reopened = await client.nodePath.directories({ path: page.path })
  await expect(
    client.nodePath.mkdir({ directory_id: reopened.directory_id, name: 'child' }, 'fresh')
  ).resolves.toEqual({ path: join(s.dir, 'child') })
})
it('opens symlinked projects and pins linked worktrees to their resolved identity', async () => {
  const s = await setup()
  const repo = join(s.dir, 'repo'),
    pool = join(s.dir, 'pool'),
    alias = join(s.dir, 'alias')
  mkdirSync(repo)
  mkdirSync(pool)
  symlinkSync(pool, alias)
  git(repo, 'init', '-b', 'trunk')
  git(
    repo,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'initial'
  )
  git(repo, 'worktree', 'add', '-b', 'topic', join(alias, 'topic'))
  // Existing Git registrations can retain a logical path (e.g. after moving the pool
  // to a volume and leaving a symlink). Current Git canonicalizes new additions.
  writeFileSync(join(repo, '.git/worktrees/topic/gitdir'), join(alias, 'topic/.git') + '\n')
  expect(git(repo, 'worktree', 'list', '--porcelain')).toContain(join(alias, 'topic'))
  const { client } = await s.start()
  const project = await client.nodePath.register({
    path: join(alias, 'topic'),
    trust: 'trusted',
    exact_root: true,
  })
  expect(project.root_path).toBe(realpathSync(join(alias, 'topic')))
  const page = await client.repository.worktrees({ project_id: project.project_id })
  const entry = page.entries.find((e) => e.path_label === 'topic')!
  expect(entry).toMatchObject({ kind: 'root', availability: 'available' })
  const target = { kind: 'worktree' as const, worktree_id: entry.worktree_id }
  await client.nodePath.execution({ project_id: project.project_id, target, enabled: true })
  await expect(client.nodePath.createSession({ provider: 'fake', target })).resolves.toHaveProperty(
    'session_id'
  )
  renameSync(alias, alias + '-old')
  mkdirSync(alias)
  await expect(client.repository.observe({ worktree_id: entry.worktree_id })).rejects.toThrow(
    'repository_unavailable'
  )
  rmSync(alias, { recursive: true })
  renameSync(alias + '-old', alias)
  await expect(
    client.repository.observe({ worktree_id: entry.worktree_id })
  ).resolves.toHaveProperty('revision')
  renameSync(join(pool, 'topic'), join(pool, 'old'))
  mkdirSync(join(pool, 'topic'))
  await expect(client.repository.observe({ worktree_id: entry.worktree_id })).rejects.toThrow(
    'stale_resource'
  )
})
for (const swap of [false, 'preview', 'repair', 'gate', 'worker', 'backlink'] as const)
  it(`keeps external symlinked worktrees behind opt-in and ${swap ? 'refuses an alias swapped at ' + swap : 'deletes the confirmed Git registration'}`, async () => {
    // This test exercises path binding, not OS process inventory. The effect worker
    // is a detached group leader; the real inventory requires ps outside the sandbox.
    vi.spyOn(systemProcessProbe, 'identity').mockImplementation((pid) => {
      try {
        process.kill(pid, 0)
        return { pid, group: pid, fingerprint: 'fixture' }
      } catch {
        return undefined
      }
    })
    vi.spyOn(systemProcessProbe, 'groupMembers').mockReturnValue([])
    const s = await setup()
    const repo = join(s.dir, 'repo'),
      pool = join(s.dir, 'pool'),
      alias = join(s.dir, 'alias')
    mkdirSync(repo)
    mkdirSync(pool)
    symlinkSync(pool, alias)
    git(repo, 'init', '-b', 'trunk')
    git(
      repo,
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '--allow-empty',
      '-m',
      'initial'
    )
    git(repo, 'worktree', 'add', '-b', 'topic', join(alias, 'topic'))
    writeFileSync(join(repo, '.git/worktrees/topic/gitdir'), join(alias, 'topic/.git') + '\n')
    // Finish repository setup before the node starts watching it. Creating a ref
    // after the preview can invalidate that preview on Linux before our race hook.
    const other = join(s.dir, 'other')
    if (swap) {
      mkdirSync(other)
      git(repo, 'worktree', 'add', '-b', 'other', join(other, 'topic'))
    }
    const { client } = await s.start()
    const project = await client.nodePath.register({ path: repo, trust: 'trusted' })
    expect(
      (await client.repository.worktrees({ project_id: project.project_id })).entries
    ).toHaveLength(1)
    await client.setRepositorySettings({ project_id: project.project_id, external_read: true })
    const entry = (
      await client.repository.worktrees({ project_id: project.project_id })
    ).entries.find((e) => e.kind === 'external')!
    expect(entry.availability).toBe('available')
    const observation = await client.repository.observe({ worktree_id: entry.worktree_id })
    if (observation.revision.kind !== 'working') throw new Error('working revision required')
    if (swap) {
      const run = GitRunner.prototype.run
      let swapped = false
      const backlink = join(repo, '.git/worktrees/topic/gitdir')
      const sentinel = join(s.dir, 'registration')
      const original = readFileSync(backlink, 'utf8')
      const retarget = () => {
        swapped = true
        if (swap === 'backlink') {
          writeFileSync(sentinel, original)
          rmSync(backlink)
          symlinkSync(sentinel, backlink)
          return
        }
        rmSync(alias)
        symlinkSync(other, alias)
      }
      if (swap === 'preview') retarget()
      vi.spyOn(GitRunner.prototype, 'run').mockImplementation(function (this: GitRunner, ...args) {
        if (
          !swapped &&
          (((swap === 'repair' || swap === 'backlink') && args[1].kind === 'worktree.repair') ||
            (swap === 'gate' && args[1].kind === 'worktree.remove'))
        ) {
          retarget()
        }
        if (swap === 'worker' && args[1].kind === 'worktree.remove') {
          const identity = vi.mocked(systemProcessProbe.identity).getMockImplementation()!
          vi.spyOn(systemProcessProbe, 'identity').mockImplementation((pid) => {
            if (!swapped) retarget()
            return identity(pid)
          })
        }
        return run.apply(this, args)
      })
      await expect(
        client.nodePath.deleteWorktree({
          worktree_id: entry.worktree_id,
          expected_head: observation.revision.head!,
          expected_observation_id: observation.revision.observation_id,
        })
      ).rejects.toThrow(swap === 'preview' ? 'repository_unavailable' : 'stale_revision')
      expect(swapped).toBe(true)
      expect(existsSync(join(pool, 'topic/.git'))).toBe(true)
      expect(existsSync(join(other, 'topic/.git'))).toBe(true)
      if (swap === 'backlink') {
        expect(readFileSync(sentinel, 'utf8')).toBe(original)
        rmSync(backlink)
        writeFileSync(backlink, original)
      } else {
        rmSync(alias)
        symlinkSync(pool, alias)
      }
      const fresh = await client.repository.observe({ worktree_id: entry.worktree_id })
      if (fresh.revision.kind !== 'working') throw new Error('working revision required')
      await expect(
        client.nodePath.deleteWorktree({
          worktree_id: entry.worktree_id,
          expected_head: fresh.revision.head!,
          expected_observation_id: fresh.revision.observation_id,
        })
      ).resolves.toEqual({ worktree_id: entry.worktree_id, state: 'deleted' })
      expect(existsSync(join(other, 'topic/.git'))).toBe(true)
      return
    }
    const run = GitRunner.prototype.run
    let repaired = false
    vi.spyOn(GitRunner.prototype, 'run').mockImplementation(function (this: GitRunner, ...args) {
      if (args[1].kind === 'worktree.remove') {
        expect(readFileSync(join(repo, '.git/worktrees/topic/gitdir'), 'utf8')).toBe(
          join(pool, 'topic/.git') + '\n'
        )
        repaired = true
      }
      return run.apply(this, args)
    })
    await expect(
      client.nodePath.deleteWorktree({
        worktree_id: entry.worktree_id,
        expected_head: observation.revision.head!,
        expected_observation_id: observation.revision.observation_id,
      })
    ).resolves.toEqual({ worktree_id: entry.worktree_id, state: 'deleted' })
    expect(repaired).toBe(true)
  })
