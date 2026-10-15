import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
import { createBranch } from '../packages/node-core/src/repository-git-refs.js'

const dirs: string[] = [],
  cores: NodeCore[] = []
const git = (cwd: string, ...args: string[]) => {
  const p = spawnSync('/usr/bin/git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  })
  if (p.status) throw new Error(p.stderr)
  return p.stdout.trim()
}
const has = (cwd: string, ref: string) =>
  spawnSync('/usr/bin/git', ['show-ref', '--verify', '--quiet', ref], { cwd }).status === 0
// Owner git reads the user's global configuration; give these fixtures an empty one.
const home = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
beforeAll(() => {
  mkdirSync('.scratch', { recursive: true })
  const empty = mkdtempSync(resolve('.scratch/git-refs-home-'))
  dirs.push(empty)
  process.env.HOME = empty
  process.env.XDG_CONFIG_HOME = join(empty, '.config')
})
afterAll(() => {
  process.env.HOME = home.HOME
  if (home.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = home.XDG_CONFIG_HOME
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of cores.splice(0)) {
    await c.resources.stop()
    c.close()
  }
})
const identity = (cwd: string) => {
  git(cwd, 'config', 'user.name', 'Fixture Owner')
  git(cwd, 'config', 'user.email', 'owner@example.invalid')
}
const commit = (cwd: string, file: string, text: string, message = file) => {
  writeFileSync(join(cwd, file), text)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-qm', message)
  return git(cwd, 'rev-parse', 'HEAD')
}
async function setup() {
  const dir = mkdtempSync(resolve('.scratch/repository-git-refs-'))
  dirs.push(dir)
  const remote = join(dir, 'remote.git'),
    folder = join(dir, 'folder'),
    other = join(dir, 'other')
  git(dir, 'init', '--bare', '-b', 'trunk', remote)
  mkdirSync(folder)
  git(folder, 'init', '-b', 'trunk')
  identity(folder)
  commit(folder, 'sample', 'one\n', 'initial')
  git(folder, 'remote', 'add', 'origin', remote)
  git(folder, 'push', '-q', '-u', 'origin', 'trunk')
  git(dir, 'clone', '-q', '-b', 'trunk', remote, other)
  identity(other)
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let op = 0
  const request = async (method: string, params: unknown, operation?: string) =>
    (await core.request(actor, method, params, operation ?? 'fixture-' + ++op)) as any
  const project = await request('project.register', { path: folder, trust: 'untrusted' })
  const root = (
    await request('repository.v1.worktrees', { project_id: project.project_id })
  ).entries.find((e: any) => e.kind === 'root').worktree_id
  const head = (cwd = folder) => git(cwd, 'rev-parse', 'HEAD')
  return { dir, folder, other, remote, core, actor, root, request, head }
}

it('fetches a remote, reports what moved and the new ahead/behind, and prunes only when asked', async () => {
  const s = await setup()
  const theirs = commit(s.other, 'theirs', 'theirs\n')
  git(s.other, 'push', '-q', 'origin', 'trunk', 'trunk:feature')
  // Without a fetch the node knows nothing of it.
  expect((await s.request('repository.v1.git.info', { worktree_id: s.root })).upstream).toEqual({
    ref: 'refs/remotes/origin/trunk',
    remote: 'origin',
    branch: 'refs/heads/trunk',
    commit: s.head(),
    ahead: 0,
    behind: 0,
  })
  const params = { worktree_id: s.root }
  const fetched = await s.request('repository.v1.git.fetch', params, 'fetch-once')
  expect(fetched).toEqual({
    state: 'fetched',
    remote: 'origin',
    pruned: false,
    updated: ['refs/remotes/origin/feature', 'refs/remotes/origin/trunk'],
    removed: [],
    upstream: {
      ref: 'refs/remotes/origin/trunk',
      remote: 'origin',
      branch: 'refs/heads/trunk',
      commit: theirs,
      ahead: 0,
      behind: 1,
    },
  })
  expect((await s.request('repository.v1.git.info', params)).upstream).toEqual(fetched.upstream)
  // The receipt answers a retry; git does not run again.
  const runs = vi.spyOn(s.core.resources.repositoryGit.owner, 'run')
  expect(await s.request('repository.v1.git.fetch', params, 'fetch-once')).toEqual(fetched)
  expect(runs).not.toHaveBeenCalled()
  runs.mockRestore()
  // The branch goes away upstream; the repository is configured to prune on every fetch.
  git(s.other, 'push', '-q', 'origin', '--delete', 'feature')
  git(s.folder, 'config', 'fetch.prune', 'true')
  expect(await s.request('repository.v1.git.fetch', params)).toMatchObject({
    state: 'fetched',
    pruned: false,
    removed: [],
  })
  expect(has(s.folder, 'refs/remotes/origin/feature')).toBe(true)
  expect(await s.request('repository.v1.git.fetch', { ...params, prune: true })).toMatchObject({
    state: 'fetched',
    pruned: true,
    updated: [],
    removed: ['refs/remotes/origin/feature'],
  })
  expect(has(s.folder, 'refs/remotes/origin/feature')).toBe(false)
  // Choosing a remote.
  await expect(
    s.request('repository.v1.git.fetch', { ...params, remote: '--upload-pack=x' })
  ).rejects.toThrow('invalid_params')
  expect(await s.request('repository.v1.git.fetch', { ...params, remote: 'nope' })).toMatchObject({
    state: 'failed',
    code: 'no_remote',
  })
  git(s.folder, 'remote', 'add', 'gone', join(s.dir, 'missing.git'))
  const unreachable = await s.request('repository.v1.git.fetch', { ...params, remote: 'gone' })
  expect(unreachable).toMatchObject({ state: 'failed', code: 'remote_unreachable' })
  expect(unreachable.message).toMatch(/could not be reached/)
  git(s.folder, 'remote', 'rename', 'origin', 'upstream')
  expect(await s.request('repository.v1.git.fetch', params)).toMatchObject({
    state: 'failed',
    code: 'remote_required',
  })
  git(s.folder, 'remote', 'remove', 'gone')
  expect(await s.request('repository.v1.git.fetch', params)).toMatchObject({
    state: 'fetched',
    remote: 'upstream',
  })
})

it('force-pushes a rebased branch only over the remote commit the client saw', async () => {
  const s = await setup()
  git(s.folder, 'switch', '-q', '-c', 'topic')
  const first = commit(s.folder, 'topic', 'topic\n')
  expect(
    await s.request('repository.v1.git.push', { worktree_id: s.root, expected_head: first })
  ).toMatchObject({ state: 'pushed', set_upstream: true })
  // Rewritten locally after it was pushed.
  git(s.folder, 'commit', '-q', '--amend', '-m', 'topic, reworded')
  const rewritten = s.head()
  expect(
    await s.request('repository.v1.git.push', { worktree_id: s.root, expected_head: rewritten })
  ).toMatchObject({ state: 'failed', code: 'push_rejected' })
  const seen = (await s.request('repository.v1.git.info', { worktree_id: s.root })).upstream
  expect(seen).toMatchObject({ commit: first, ahead: 1, behind: 1 })
  await expect(
    s.request('repository.v1.git.push', {
      worktree_id: s.root,
      expected_head: rewritten,
      force_with_lease: 'origin/topic',
    })
  ).rejects.toThrow('invalid_params')
  const forced = await s.request('repository.v1.git.push', {
    worktree_id: s.root,
    expected_head: rewritten,
    force_with_lease: seen.commit,
  })
  expect(forced).toEqual({
    state: 'pushed',
    remote: 'origin',
    branch: 'refs/heads/topic',
    upstream: 'refs/remotes/origin/topic',
    set_upstream: false,
    commit: rewritten,
  })
  expect(git(s.remote, 'rev-parse', 'refs/heads/topic')).toBe(rewritten)
  // Someone else pushes on top; the client still holds the commit it saw before.
  git(s.other, 'fetch', '-q', 'origin')
  git(s.other, 'switch', '-q', '-c', 'topic', 'origin/topic')
  const theirs = commit(s.other, 'theirs', 'theirs\n')
  git(s.other, 'push', '-q', 'origin', 'topic')
  git(s.folder, 'commit', '-q', '--amend', '-m', 'topic, again')
  const again = s.head()
  // A fetch the user never looked at moved the tracking ref onto their commit: the lease is the
  // commit the client passes, never whatever the tracking ref says now.
  git(s.folder, 'fetch', '-q', 'origin')
  expect(git(s.folder, 'rev-parse', 'refs/remotes/origin/topic')).toBe(theirs)
  const refused = await s.request('repository.v1.git.push', {
    worktree_id: s.root,
    expected_head: again,
    force_with_lease: rewritten,
  })
  expect(refused).toMatchObject({ state: 'failed', code: 'lease_rejected' })
  expect(refused.message).toMatch(/changed since you last saw it/)
  expect(git(s.remote, 'rev-parse', 'refs/heads/topic')).toBe(theirs)
})

it('creates a branch at a commit with a name git accepts, and switches a clean worktree to it', async () => {
  const s = await setup()
  const initial = s.head()
  const later = commit(s.folder, 'later', 'later\n')
  const create = (params: Record<string, unknown>, operation?: string) =>
    s.request(
      'repository.v1.git.create_branch',
      { worktree_id: s.root, start_point: initial, ...params },
      operation
    )
  for (const name of ['a..b', 'x.lock', 'with space', 'end/', 'HEAD', '@', 'a@{1}', 'q?'])
    expect(await create({ name })).toMatchObject({ state: 'failed', code: 'invalid_branch_name' })
  for (const name of ['-f', '', 'a\0b'])
    await expect(create({ name })).rejects.toThrow('invalid_params')
  expect(await create({ name: 'trunk' })).toMatchObject({ state: 'failed', code: 'branch_exists' })
  expect(await create({ name: 'n', start_point: 'f'.repeat(40) })).toMatchObject({
    state: 'failed',
    code: 'commit_not_found',
  })
  const created = await create({ name: 'feature/one' }, 'branch-once')
  expect(created).toEqual({
    state: 'created',
    branch: 'refs/heads/feature/one',
    commit: initial,
    switched: false,
    head: later,
  })
  expect(git(s.folder, 'rev-parse', 'refs/heads/feature/one')).toBe(initial)
  expect(git(s.folder, 'symbolic-ref', 'HEAD')).toBe('refs/heads/trunk')
  expect(await create({ name: 'feature/one' }, 'branch-once')).toEqual(created)
  expect(await create({ name: 'feature/one' })).toMatchObject({ code: 'branch_exists' })
  // Inside an existing branch's name: git refuses the ref, the node says it exists.
  expect(await create({ name: 'feature/one/sub' })).toMatchObject({ code: 'branch_exists' })
  // Switching needs the head the user saw and a worktree without tracked changes.
  await expect(create({ name: 'two', switch: true })).rejects.toThrow('invalid_params')
  await expect(create({ name: 'two', switch: true, expected_head: initial })).rejects.toThrow(
    'stale_revision'
  )
  writeFileSync(join(s.folder, 'sample'), 'dirty\n')
  expect(await create({ name: 'two', switch: true, expected_head: later })).toMatchObject({
    state: 'failed',
    code: 'workspace_dirty',
  })
  expect(has(s.folder, 'refs/heads/two')).toBe(false)
  git(s.folder, 'checkout', '--', 'sample')
  writeFileSync(join(s.folder, 'loose'), 'untracked is fine\n')
  expect(await create({ name: 'two', switch: true, expected_head: later })).toEqual({
    state: 'created',
    branch: 'refs/heads/two',
    commit: initial,
    switched: true,
    head: initial,
  })
  expect(git(s.folder, 'symbolic-ref', 'HEAD')).toBe('refs/heads/two')
  expect(existsSync(join(s.folder, 'later'))).toBe(false)
  expect(existsSync(join(s.folder, 'loose'))).toBe(true)
  expect((await s.request('repository.v1.git.info', { worktree_id: s.root })).branch).toBe(
    'refs/heads/two'
  )
  // An untracked file the switch would overwrite: git refuses, and the branch is not kept.
  writeFileSync(join(s.folder, 'later'), 'mine, untracked\n')
  const refused = await create({
    name: 'three',
    start_point: later,
    switch: true,
    expected_head: initial,
  })
  expect(refused).toMatchObject({ state: 'failed', code: 'switch_failed' })
  expect(refused.output).toMatch(/untracked/)
  expect(has(s.folder, 'refs/heads/three')).toBe(false)
  expect(git(s.folder, 'symbolic-ref', 'HEAD')).toBe('refs/heads/two')
  // A node workspace keeps the branch it was made with.
  const target = await s.core.resources.repository.readableTarget(s.actor, s.root)
  expect(
    await createBranch(
      s.core.resources.repositoryGit,
      { name: 'four', start_point: initial, switch: true, expected_head: initial },
      { ...target, kind: 'managed' },
      async () => {}
    )
  ).toMatchObject({ state: 'failed', code: 'managed_branch' })
  expect(has(s.folder, 'refs/heads/four')).toBe(false)
})
