import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
import { remoteForge, sanitizeRemoteUrl } from '../packages/node-core/src/repository-git.js'

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
// Owner git reads the user's global configuration; give these fixtures an empty one.
const home = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
beforeAll(() => {
  mkdirSync('.scratch', { recursive: true })
  const empty = mkdtempSync(resolve('.scratch/git-write-home-'))
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
const identity = (cwd: string) => {
  git(cwd, 'config', 'user.name', 'Fixture Owner')
  git(cwd, 'config', 'user.email', 'owner@example.invalid')
}
async function setup() {
  const dir = mkdtempSync(resolve('.scratch/repository-git-write-'))
  dirs.push(dir)
  const remote = join(dir, 'remote.git'),
    folder = join(dir, 'folder'),
    other = join(dir, 'other')
  git(dir, 'init', '--bare', '-b', 'trunk', remote)
  mkdirSync(folder)
  git(folder, 'init', '-b', 'trunk')
  identity(folder)
  writeFileSync(join(folder, 'sample'), 'one\ntwo\nthree\n')
  git(folder, 'add', '.')
  git(folder, 'commit', '-m', 'initial')
  git(folder, 'remote', 'add', 'origin', remote)
  git(folder, 'push', '-u', 'origin', 'trunk')
  git(folder, 'remote', 'set-head', 'origin', 'trunk')
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
  return { dir, folder, other, remote, core, actor, project, root, request, head }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of cores.splice(0)) {
    await c.resources.stop()
    c.close()
  }
})

it('stages and unstages paths and everything, with literal option-like names and a head precondition', async () => {
  const s = await setup()
  writeFileSync(join(s.folder, '-n'), 'dash\n')
  writeFileSync(join(s.folder, '*'), 'star\n')
  writeFileSync(join(s.folder, 'sample'), 'changed\n')
  const head = s.head()
  const staged = await s.request('repository.v1.git.stage', {
    worktree_id: s.root,
    expected_head: head,
    paths: ['-n'],
  })
  expect(staged).toEqual({ state: 'applied', head })
  // `-n` is a file, not git's dry-run flag; `*` is literal, not a glob over the tree.
  expect(git(s.folder, 'diff', '--cached', '--name-only')).toBe('-n')
  await s.request('repository.v1.git.stage', {
    worktree_id: s.root,
    expected_head: head,
    paths: ['*'],
  })
  expect(git(s.folder, 'diff', '--cached', '--name-only').split('\n').sort()).toEqual(['*', '-n'])
  await s.request('repository.v1.git.stage', {
    worktree_id: s.root,
    expected_head: head,
    all: true,
  })
  expect(git(s.folder, 'diff', '--cached', '--name-only').split('\n')).toContain('sample')
  await s.request('repository.v1.git.unstage', {
    worktree_id: s.root,
    expected_head: head,
    paths: ['sample'],
  })
  expect(git(s.folder, 'diff', '--cached', '--name-only').split('\n')).not.toContain('sample')
  await s.request('repository.v1.git.unstage', {
    worktree_id: s.root,
    expected_head: head,
    all: true,
  })
  expect(git(s.folder, 'diff', '--cached', '--name-only')).toBe('')
  await expect(
    s.request('repository.v1.git.stage', {
      worktree_id: s.root,
      expected_head: 'a'.repeat(40),
      all: true,
    })
  ).rejects.toThrow('stale_revision')
  for (const path of ['../escape', '/etc/passwd', '.git/config', 'a/../../b', 'a//b', ''])
    await expect(
      s.request('repository.v1.git.stage', {
        worktree_id: s.root,
        expected_head: head,
        paths: [path],
      })
    ).rejects.toThrow('invalid_params')
  await expect(
    s.request('repository.v1.git.stage', {
      worktree_id: s.root,
      expected_head: head,
      paths: ['sample'],
      all: true,
    })
  ).rejects.toThrow('invalid_params')
  await expect(
    s.request('repository.v1.git.stage', { worktree_id: s.root, expected_head: head }, '')
  ).rejects.toThrow()
})

it('commits staged changes only, as the worktree identity, once per operation id', async () => {
  const s = await setup()
  const head = s.head()
  expect(
    await s.request('repository.v1.git.commit', {
      worktree_id: s.root,
      expected_head: head,
      message: 'nothing',
    })
  ).toMatchObject({ state: 'failed', code: 'nothing_staged' })
  writeFileSync(join(s.folder, 'sample'), 'staged\n')
  git(s.folder, 'add', 'sample')
  writeFileSync(join(s.folder, 'sample'), 'not staged\n')
  writeFileSync(join(s.folder, 'loose'), 'untracked\n')
  const params = { worktree_id: s.root, expected_head: head, message: 'feat: staged only\n\nbody' }
  const committed = await s.request('repository.v1.git.commit', params, 'commit-once')
  expect(committed).toMatchObject({
    state: 'committed',
    parent: head,
    author: { name: 'Fixture Owner', email: 'owner@example.invalid' },
  })
  expect(committed.commit).toBe(s.head())
  expect(git(s.folder, 'show', 'HEAD:sample')).toBe('staged')
  expect(git(s.folder, 'log', '-1', '--format=%an <%ae>|%cn|%B')).toBe(
    'Fixture Owner <owner@example.invalid>|Fixture Owner|feat: staged only\n\nbody'
  )
  expect(readFileSync(join(s.folder, 'sample'), 'utf8')).toBe('not staged\n')
  // A retried request returns the receipt and makes no second commit.
  expect(await s.request('repository.v1.git.commit', params, 'commit-once')).toEqual(committed)
  expect(git(s.folder, 'rev-list', '--count', 'HEAD')).toBe('2')
  await expect(
    s.request('repository.v1.git.commit', { ...params, message: 'other' }, 'commit-once')
  ).rejects.toThrow('idempotency_mismatch')
  await expect(s.request('repository.v1.git.commit', params, 'commit-twice')).rejects.toThrow(
    'stale_revision'
  )
  await expect(
    s.request('repository.v1.git.commit', { ...params, expected_head: s.head(), message: ' \n ' })
  ).rejects.toThrow('invalid_params')
})

it('reports hook refusals and a missing identity in plain words, and never takes the environment as author', async () => {
  const s = await setup()
  const hook = join(s.folder, '.git', 'hooks', 'pre-commit')
  writeFileSync(hook, '#!/bin/sh\necho "lint failed: sample is not formatted" >&2\nexit 1\n')
  chmodSync(hook, 0o755)
  writeFileSync(join(s.folder, 'sample'), 'staged\n')
  git(s.folder, 'add', 'sample')
  const head = s.head()
  const refused = await s.request('repository.v1.git.commit', {
    worktree_id: s.root,
    expected_head: head,
    message: 'blocked',
  })
  expect(refused).toMatchObject({ state: 'failed', code: 'hook_failed' })
  expect(refused.message).toMatch(/hook/)
  expect(refused.output).toContain('lint failed: sample is not formatted')
  expect(s.head()).toBe(head)
  rmSync(hook)
  git(s.folder, 'config', '--unset', 'user.name')
  git(s.folder, 'config', '--unset', 'user.email')
  const saved = { ...process.env }
  Object.assign(process.env, {
    GIT_AUTHOR_NAME: 'Agent',
    GIT_AUTHOR_EMAIL: 'agent@example.invalid',
    GIT_COMMITTER_NAME: 'Agent',
    GIT_COMMITTER_EMAIL: 'agent@example.invalid',
    EMAIL: 'agent@example.invalid',
  })
  try {
    expect(
      await s.request('repository.v1.git.commit', {
        worktree_id: s.root,
        expected_head: head,
        message: 'who',
      })
    ).toMatchObject({ state: 'failed', code: 'identity_missing' })
    expect((await s.request('repository.v1.git.info', { worktree_id: s.root })).author).toBeNull()
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  }
  expect(s.head()).toBe(head)
})

it('discards only confirmed paths from an unchanged observation', async () => {
  const s = await setup()
  writeFileSync(join(s.folder, 'sample'), 'edited\n')
  writeFileSync(join(s.folder, 'new'), 'untracked\n')
  writeFileSync(join(s.folder, 'kept'), 'other\n')
  writeFileSync(join(s.folder, 'staged'), 'staged\n')
  git(s.folder, 'add', 'staged')
  const observation = (await s.request('repository.v1.observe', { worktree_id: s.root })).revision
    .observation_id
  const params = {
    worktree_id: s.root,
    paths: ['sample', 'new'],
    expected_observation_id: observation,
  }
  await expect(
    s.request('repository.v1.git.discard', { ...params, confirmed: false })
  ).rejects.toThrow('confirmation_required')
  await expect(s.request('repository.v1.git.discard', params)).rejects.toThrow('invalid_params')
  // An unrelated file may change; a confirmed one may not.
  writeFileSync(join(s.folder, 'kept'), 'other, edited later\n')
  const discarded = await s.request('repository.v1.git.discard', { ...params, confirmed: true })
  expect(discarded).toMatchObject({ state: 'applied', head: s.head() })
  expect(discarded.discarded.sort()).toEqual(['new', 'sample'])
  expect(readFileSync(join(s.folder, 'sample'), 'utf8')).toBe('one\ntwo\nthree\n')
  expect(existsSync(join(s.folder, 'new'))).toBe(false)
  expect(existsSync(join(s.folder, 'kept'))).toBe(true)
  const second = (await s.request('repository.v1.observe', { worktree_id: s.root })).revision
    .observation_id
  writeFileSync(join(s.folder, 'kept'), 'changed after the confirm\n')
  await expect(
    s.request('repository.v1.git.discard', {
      worktree_id: s.root,
      paths: ['kept'],
      expected_observation_id: second,
      confirmed: true,
    })
  ).rejects.toThrow('stale_revision')
  expect(readFileSync(join(s.folder, 'kept'), 'utf8')).toBe('changed after the confirm\n')
  // A staged new file stays unless staged changes are discarded too.
  const third = (await s.request('repository.v1.observe', { worktree_id: s.root })).revision
    .observation_id
  const keepStaged = await s.request('repository.v1.git.discard', {
    worktree_id: s.root,
    paths: ['staged'],
    expected_observation_id: third,
    confirmed: true,
  })
  expect(keepStaged.discarded).toEqual([])
  expect(existsSync(join(s.folder, 'staged'))).toBe(true)
  const fourth = (await s.request('repository.v1.observe', { worktree_id: s.root })).revision
    .observation_id
  await s.request('repository.v1.git.discard', {
    worktree_id: s.root,
    paths: ['staged'],
    expected_observation_id: fourth,
    include_staged: true,
    confirmed: true,
  })
  expect(existsSync(join(s.folder, 'staged'))).toBe(false)
  expect(git(s.folder, 'diff', '--cached', '--name-only')).toBe('')
  await expect(
    s.request('repository.v1.git.discard', {
      worktree_id: s.root,
      paths: ['sample'],
      expected_observation_id: 'not-an-observation',
      confirmed: true,
    })
  ).rejects.toThrow('stale_revision')
})

it('updates from base like Orca (fetch, then rebase), reports conflicts as data and aborts or continues', async () => {
  const s = await setup()
  const external = join(s.dir, 'side')
  git(s.folder, 'worktree', 'add', '-b', 'side', external, 'trunk')
  identity(external)
  writeFileSync(join(external, 'side'), 'side\n')
  git(external, 'add', 'side')
  git(external, 'commit', '-m', 'side work')
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: true,
  })
  const side = (
    await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  ).entries.find((e: any) => e.kind === 'external').worktree_id
  // Upstream moves on in another clone.
  writeFileSync(join(s.other, 'upstream'), 'upstream\n')
  git(s.other, 'add', 'upstream')
  git(s.other, 'commit', '-m', 'upstream work')
  git(s.other, 'push', 'origin', 'trunk')
  const before = s.head(external)
  await expect(
    s.request('repository.v1.git.update', { worktree_id: side, expected_head: before })
  ).rejects.toThrow('unauthorized')
  await s.request('repository.v1.editing', { worktree_id: side, enabled: true })
  writeFileSync(join(external, 'side'), 'dirty\n')
  expect(
    await s.request('repository.v1.git.update', { worktree_id: side, expected_head: before })
  ).toMatchObject({ state: 'failed', code: 'workspace_dirty' })
  git(external, 'checkout', '--', 'side')
  const updated = await s.request('repository.v1.git.update', {
    worktree_id: side,
    expected_head: before,
  })
  expect(updated).toMatchObject({
    state: 'updated',
    strategy: 'rebase',
    previous_head: before,
    base_ref: 'refs/remotes/origin/trunk',
    changed: true,
  })
  expect(updated.base_commit).toBe(git(s.other, 'rev-parse', 'HEAD'))
  expect(git(external, 'rev-parse', 'HEAD~1')).toBe(updated.base_commit)
  expect(git(external, 'log', '--format=%s', '-2')).toBe('side work\nupstream work')
  expect(git(s.folder, 'for-each-ref', '--format=%(refname)', 'refs/abele')).toBe('')
  // A conflicting upstream change stops the rebase in a known state.
  writeFileSync(join(s.other, 'sample'), 'upstream line\n')
  git(s.other, 'commit', '-qam', 'upstream edit')
  git(s.other, 'push', 'origin', 'trunk')
  writeFileSync(join(external, 'sample'), 'side line\n')
  git(external, 'commit', '-qam', 'side edit')
  const ours = s.head(external)
  const stopped = await s.request('repository.v1.git.update', {
    worktree_id: side,
    expected_head: ours,
  })
  expect(stopped).toEqual({
    state: 'conflicts',
    operation: 'rebase',
    base_ref: 'refs/remotes/origin/trunk',
    conflicted_paths: ['sample'],
  })
  const info = await s.request('repository.v1.git.info', { worktree_id: side })
  expect(info.operation).toEqual({ kind: 'rebase', conflicted_paths: ['sample'] })
  expect(
    await s.request('repository.v1.git.commit', {
      worktree_id: side,
      expected_head: info.head,
      message: 'not now',
    })
  ).toMatchObject({ state: 'failed', code: 'operation_in_progress' })
  expect(
    await s.request('repository.v1.git.abort', { worktree_id: side, operation: 'merge' })
  ).toMatchObject({ state: 'failed', code: 'no_operation' })
  expect(
    await s.request('repository.v1.git.abort', { worktree_id: side, operation: 'rebase' })
  ).toEqual({ state: 'aborted', head: ours })
  expect(s.head(external)).toBe(ours)
  expect((await s.request('repository.v1.git.info', { worktree_id: side })).operation).toBeNull()
  expect(
    await s.request('repository.v1.git.abort', { worktree_id: side, operation: 'rebase' })
  ).toEqual({ state: 'not_in_progress', head: ours })
  // Again, and this time resolve and continue.
  await s.request('repository.v1.git.update', { worktree_id: side, expected_head: ours })
  const during = (await s.request('repository.v1.git.info', { worktree_id: side })).head
  expect(
    await s.request('repository.v1.git.continue', { worktree_id: side, operation: 'rebase' })
  ).toMatchObject({ state: 'conflicts', conflicted_paths: ['sample'] })
  writeFileSync(join(external, 'sample'), 'resolved\n')
  await s.request('repository.v1.git.stage', {
    worktree_id: side,
    expected_head: during,
    paths: ['sample'],
  })
  const continued = await s.request('repository.v1.git.continue', {
    worktree_id: side,
    operation: 'rebase',
  })
  expect(continued).toEqual({ state: 'continued', head: s.head(external) })
  expect(git(external, 'log', '--format=%s', '-1')).toBe('side edit')
  expect(git(external, 'show', 'HEAD:sample')).toBe('resolved')
  expect((await s.request('repository.v1.git.info', { worktree_id: side })).operation).toBeNull()
})

it('pushes the current branch, setting its upstream, and names rejections and missing remotes', async () => {
  const s = await setup()
  git(s.folder, 'switch', '-q', '-c', 'topic')
  writeFileSync(join(s.folder, 'topic'), 'topic\n')
  git(s.folder, 'add', 'topic')
  git(s.folder, 'commit', '-qm', 'topic')
  const head = s.head()
  const before = await s.request('repository.v1.git.info', { worktree_id: s.root })
  expect(before).toMatchObject({ branch: 'refs/heads/topic', detached: false, upstream: null })
  const pushed = await s.request('repository.v1.git.push', {
    worktree_id: s.root,
    expected_head: head,
  })
  expect(pushed).toEqual({
    state: 'pushed',
    remote: 'origin',
    branch: 'refs/heads/topic',
    upstream: 'refs/remotes/origin/topic',
    set_upstream: true,
    commit: head,
  })
  expect(git(s.remote, 'rev-parse', 'refs/heads/topic')).toBe(head)
  writeFileSync(join(s.folder, 'topic'), 'more\n')
  git(s.folder, 'commit', '-qam', 'more')
  expect((await s.request('repository.v1.git.info', { worktree_id: s.root })).upstream).toEqual({
    ref: 'refs/remotes/origin/topic',
    remote: 'origin',
    branch: 'refs/heads/topic',
    commit: head,
    ahead: 1,
    behind: 0,
  })
  // Someone else pushes to the same branch first.
  git(s.other, 'fetch', '-q', 'origin')
  git(s.other, 'switch', '-q', '-c', 'topic', 'origin/topic')
  writeFileSync(join(s.other, 'theirs'), 'theirs\n')
  git(s.other, 'add', 'theirs')
  git(s.other, 'commit', '-qm', 'theirs')
  git(s.other, 'push', '-q', 'origin', 'topic')
  const rejected = await s.request('repository.v1.git.push', {
    worktree_id: s.root,
    expected_head: s.head(),
  })
  expect(rejected).toMatchObject({ state: 'failed', code: 'push_rejected' })
  expect(rejected.message).toMatch(/update/i)
  expect(git(s.remote, 'rev-parse', 'refs/heads/topic')).toBe(git(s.other, 'rev-parse', 'HEAD'))
  git(s.folder, 'remote', 'remove', 'origin')
  expect(
    await s.request('repository.v1.git.push', { worktree_id: s.root, expected_head: s.head() })
  ).toMatchObject({ state: 'failed', code: 'no_remote' })
  git(s.folder, 'remote', 'add', 'one', s.remote)
  git(s.folder, 'remote', 'add', 'two', s.remote)
  expect(
    await s.request('repository.v1.git.push', { worktree_id: s.root, expected_head: s.head() })
  ).toMatchObject({ state: 'failed', code: 'remote_required' })
  git(s.folder, 'checkout', '-q', '--detach')
  expect(
    await s.request('repository.v1.git.push', { worktree_id: s.root, expected_head: s.head() })
  ).toMatchObject({ state: 'failed', code: 'detached_head' })
})

it('describes remotes without credentials and with the hosted repository to list pull requests from', async () => {
  const s = await setup()
  git(s.folder, 'remote', 'add', 'hub', 'https://someone:secret-token@github.com/acme/widget.git')
  git(s.folder, 'remote', 'add', 'lab', 'git@gitlab.example.com:group/sub/tool.git')
  const info = await s.request('repository.v1.git.info', { worktree_id: s.root })
  expect(JSON.stringify(info)).not.toContain('secret-token')
  expect(info).toMatchObject({
    head: s.head(),
    branch: 'refs/heads/trunk',
    default_branch: 'refs/remotes/origin/trunk',
    upstream: { ref: 'refs/remotes/origin/trunk', remote: 'origin', ahead: 0, behind: 0 },
    author: { name: 'Fixture Owner', email: 'owner@example.invalid' },
    operation: null,
  })
  expect(info.remotes).toEqual([
    {
      name: 'hub',
      url: 'https://github.com/acme/widget.git',
      forge: { kind: 'github', host: 'github.com', owner: 'acme', name: 'widget' },
    },
    {
      name: 'lab',
      url: 'git@gitlab.example.com:group/sub/tool.git',
      forge: { kind: 'gitlab', host: 'gitlab.example.com', owner: 'group/sub', name: 'tool' },
    },
    { name: 'origin', url: s.remote, forge: null },
  ])
  expect(sanitizeRemoteUrl('ssh://git@github.com/acme/widget.git')).toBe(
    'ssh://git@github.com/acme/widget.git'
  )
  expect(sanitizeRemoteUrl('https://x-access-token@github.com/a/b?token=1')).toBe(
    'https://github.com/a/b'
  )
  expect(remoteForge('ssh://git@ssh.github.com:443/acme/widget')).toEqual({
    kind: 'github',
    host: 'github.com',
    owner: 'acme',
    name: 'widget',
  })
})

it('settles an effect a previous run never finished as unknown and never repeats it', async () => {
  const s = await setup()
  writeFileSync(join(s.folder, 'sample'), 'staged\n')
  git(s.folder, 'add', 'sample')
  const head = s.head()
  const params = { worktree_id: s.root, expected_head: head, message: 'interrupted' }
  // An effect that throws once started is reported as unknown, not as refused.
  s.core.resources.repositoryGit.fault = () => {
    throw new Error('crash')
  }
  expect(await s.request('repository.v1.git.commit', params, 'crashed')).toEqual({
    state: 'outcome_unknown',
  })
  s.core.resources.repositoryGit.fault = undefined
  expect(await s.request('repository.v1.git.commit', params, 'crashed')).toEqual({
    state: 'outcome_unknown',
  })
  expect(s.head()).toBe(head)
  // A durable intent left behind by a dead process.
  const { createHash } = await import('node:crypto')
  const { canonical } = await import('../packages/node-core/src/index.js')
  const method = 'repository.v1.git.commit'
  s.core.db
    .prepare('INSERT INTO repository_git_effects VALUES(?,?,?)')
    .run(
      s.actor.installation_id,
      'left-behind',
      createHash('sha256').update(canonical({ method, params })).digest('hex')
    )
  await expect(s.request('session.create', { title: 'reuse' }, 'left-behind')).rejects.toThrow()
  await s.core.resources.stop()
  s.core.close()
  cores.splice(cores.indexOf(s.core), 1)
  const core = new NodeCore(join(s.dir, 'state'))
  cores.push(core)
  const runs = vi.spyOn(core.resources.repositoryGit.owner, 'run')
  expect(await core.request(s.actor, method, params, 'left-behind')).toEqual({
    state: 'outcome_unknown',
  })
  expect(runs).not.toHaveBeenCalled()
  expect(s.head()).toBe(head)
})
