import { afterEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
import { FrameCodec } from '../packages/channel-protocol/src/index.js'

mkdirSync('.scratch', { recursive: true })
const dirs: string[] = []
const cores: NodeCore[] = []
function git(cwd: string, ...args: string[]) {
  const r = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return r.stdout.trim()
}
function setup() {
  const dir = mkdtempSync(resolve('.scratch/workspaces-'))
  dirs.push(dir)
  const repo = join(dir, 'repo with spaces')
  mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Fixture')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(repo, '.hidden'), 'original\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'fixture')
  const state = join(dir, 'state')
  const core = new NodeCore(state)
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let operation = 0
  const request = async (method: string, params: unknown = {}, id?: string) =>
    core.request(actor, method, params, id ?? 'operation-' + ++operation)
  return { dir, state, repo, core, actor, request }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const core of cores.splice(0)) {
    await core.resources.stop()
    core.close()
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
async function registered(s: ReturnType<typeof setup>) {
  return (await s.request('project.register', { path: s.repo, trust: 'untrusted' })) as {
    project_id: string
  }
}
it('places branch-named worktrees beside the repository by default', async () => {
  const s = setup()
  const p = await registered(s)
  const created = (await s.request('workspace.create', {
    project_id: p.project_id,
    branch: 'feature/files',
  })) as any
  await s.core.resources.jobs.drain()
  expect(await s.request('job.get', { job_id: created.job_id })).toMatchObject({
    state: 'succeeded',
  })
  const workspace = (await s.request('workspace.get', {
    workspace_id: created.workspace_id,
  })) as any
  expect(workspace.path).toBe(join(s.dir, 'repo with spaces.worktrees', 'feature%2Ffiles'))
})
it.each([false, true])('Open preserves a trusted plain folder (removed=%s)', async (removed) => {
  const s = setup()
  const folder = join(s.dir, 'sample-folder')
  mkdirSync(folder)
  const input = { path: folder, trust: 'untrusted', exact_root: true }
  const project = (await s.request('project.register', input)) as any
  const p = { project_id: project.project_id }
  await s.request('project.trust', { ...p, trust: 'trusted' })
  const current = await s.request('project.get', p)
  const workspaces = await s.request('workspace.list', p)
  if (removed) await s.request('project.remove', p)
  expect(await s.request('project.register', input)).toEqual(current)
  expect(await s.request('workspace.list', p)).toEqual(workspaces)
})
it.each(['trusted', 'untrusted'] as const)(
  'Open preserves current %s trust and is idempotent',
  async (trust) => {
    const s = setup()
    const input = { path: s.repo, trust: 'untrusted', exact_root: true }
    const project = (await s.request('project.register', input)) as any
    expect(project.trust).toBe('untrusted')
    await s.request('project.trust', { project_id: project.project_id, trust })
    if (trust === 'trusted')
      await s.request('project.claude_permissions', {
        project_id: project.project_id,
        use_repository_permissions: true,
      })
    const current = await s.request('project.get', { project_id: project.project_id })
    for (let i = 0; i < 2; i++) {
      expect(await s.request('project.register', input)).toEqual(current)
      expect(await s.request('project.get', { project_id: project.project_id })).toEqual(current)
    }
    expect(await s.request('project.register', { ...input, trust: 'trusted' })).toEqual(current)
  }
)
it.each(['trusted', 'untrusted'] as const)(
  'Open preserves a concurrent explicit trust change to %s',
  async (trust) => {
    const s = setup()
    const project = await registered(s)
    await s.request('project.trust', {
      project_id: project.project_id,
      trust: trust === 'trusted' ? 'untrusted' : 'trusted',
    })
    const inspect = s.core.resources.projects.inspect.bind(s.core.resources.projects)
    vi.spyOn(s.core.resources.projects, 'inspect').mockImplementationOnce(async (...args) => {
      const result = await inspect(...args)
      await s.request('project.trust', { project_id: project.project_id, trust })
      return result
    })
    const reopened = await s.request('project.register', {
      path: s.repo,
      trust: 'untrusted',
      exact_root: true,
    })
    expect(reopened).toMatchObject({ project_id: project.project_id, trust })
    expect(await s.request('project.get', { project_id: project.project_id })).toEqual(reopened)
  }
)
it.each([false, true])(
  're-adds an unregistered repository with the same project, target and sessions (legacy=%s)',
  async (legacy) => {
    const s = setup()
    const p = {
      project_id: ((await s.request('project.register', { path: s.repo, trust: 'trusted' })) as any)
        .project_id,
    }
    const before = (await s.request('repository.v1.worktrees', p)) as any
    const root = before.entries[0]
    const target = { kind: 'worktree', worktree_id: root.worktree_id }
    await s.request('project.execution', { ...p, target, enabled: true })
    const session = (await s.request('session.create', {
      provider: 'fake',
      title: 'saved',
      target,
    })) as any
    await s.request('project.remove', p)
    if (legacy)
      s.core.db.prepare('DELETE FROM repository_projects WHERE project_id=?').run(p.project_id)
    expect(
      await s.request('project.register', { path: s.repo, trust: 'untrusted', exact_root: true })
    ).toMatchObject({ ...p, trust: 'trusted' })
    expect(await s.request('project.list')).toContainEqual(expect.objectContaining(p))
    expect(await s.request('repository.v1.worktrees', p)).toMatchObject({ entries: [root] })
    expect(
      s.core.db
        .prepare('SELECT active FROM repository_targets WHERE worktree_id=?')
        .get(root.worktree_id)
    ).toMatchObject({ active: 1 })
    expect(await s.request('session.list')).toContainEqual(session)
    expect(
      await s.request('session.worktree.get', { session_id: session.session_id })
    ).toMatchObject({ ...p, target })
    expect(await s.request('session.create', { provider: 'fake', target })).toHaveProperty(
      'session_id'
    )
  }
)
it.each([false, true])(
  'registers a fresh project after repository replacement (legacy=%s)',
  async (legacy) => {
    const s = setup()
    const p = {
      project_id: ((await s.request('project.register', { path: s.repo, trust: 'trusted' })) as any)
        .project_id,
    }
    const before = (await s.request('repository.v1.worktrees', p)) as any
    const target = { kind: 'worktree', worktree_id: before.entries[0].worktree_id }
    await s.request('project.execution', { ...p, target, enabled: true })
    const session = (await s.request('session.create', { provider: 'fake', target })) as any
    await s.request('project.remove', p)
    if (legacy)
      s.core.db.prepare('DELETE FROM repository_projects WHERE project_id=?').run(p.project_id)
    renameSync(join(s.repo, '.git'), join(s.dir, 'old-git'))
    git(s.repo, 'init', '-b', 'main')
    const fresh = (await s.request('project.register', {
      path: s.repo,
      trust: 'untrusted',
      exact_root: true,
    })) as any
    expect(fresh.trust).toBe('untrusted')
    expect(fresh.project_id).not.toBe(p.project_id)
    expect(await s.request('project.list')).toEqual([fresh])
    const catalog = (await s.request('repository.v1.worktrees', {
      project_id: fresh.project_id,
    })) as any
    // Explicit trust still cannot revive a replaced identity's execution grant.
    await s.request('project.trust', { project_id: fresh.project_id, trust: 'trusted' })
    await expect(
      s.request('session.create', {
        provider: 'fake',
        target: { kind: 'worktree', worktree_id: catalog.entries[0].worktree_id },
      })
    ).rejects.toThrow('unauthorized')
    expect(s.core.resources.targets.bound(session.session_id)).toMatchObject({ ...p, target })
    await expect(
      s.request('repository.v1.refs', { worktree_id: before.entries[0].worktree_id })
    ).rejects.toThrow()
  }
)
it('never repins a registered linked root to a replaced common directory or revives its grants', async () => {
  const s = setup()
  const linked = join(s.dir, 'linked')
  git(s.repo, 'worktree', 'add', '-b', 'linked', linked)
  const p = {
    project_id: ((await s.request('project.register', { path: linked, trust: 'trusted' })) as any)
      .project_id,
  }
  const catalog = (await s.request('repository.v1.worktrees', p)) as any
  const target = {
    kind: 'worktree',
    worktree_id: catalog.entries.find((e: any) => e.kind === 'root').worktree_id,
  }
  await s.request('project.execution', { ...p, target, enabled: true })
  const session = (await s.request('session.create', { provider: 'fake', target })) as any
  const pin = () =>
    s.core.db
      .prepare('SELECT fingerprint FROM repository_projects WHERE project_id=?')
      .get(p.project_id)
  const original = pin()
  const common = join(s.repo, '.git')
  renameSync(common, join(s.dir, 'old-common'))
  cpSync(join(s.dir, 'old-common'), common, { recursive: true })
  await expect(s.core.resources.targets.runtime(session.session_id)).rejects.toThrow(
    'stale_resource'
  )
  await expect(
    s.request('project.register', { path: linked, trust: 'untrusted', exact_root: true })
  ).rejects.toThrow('stale_resource')
  expect(pin()).toEqual(original)
  await s.request('project.remove', p)
  const fresh = (await s.request('project.register', {
    path: linked,
    trust: 'untrusted',
    exact_root: true,
  })) as any
  expect(fresh.trust).toBe('untrusted')
  expect(fresh.project_id).not.toBe(p.project_id)
  await expect(s.core.resources.targets.runtime(session.session_id)).rejects.toThrow()
  await expect(s.request('session.create', { provider: 'fake', target })).rejects.toThrow()
})
it.each(['missing', 'leftover folder'])('unregisters a %s without deleting files', async (kind) => {
  const s = setup()
  const p = { project_id: (await registered(s)).project_id }
  await s.request('repository.v1.worktrees', p)
  if (kind === 'missing') renameSync(s.repo, join(s.dir, 'saved'))
  else {
    renameSync(join(s.repo, '.git'), join(s.dir, 'old-git'))
    mkdirSync(join(s.repo, '.abele'))
  }
  expect(await s.request('project.remove', p)).toEqual({ ...p, removed: true })
  expect(await s.request('project.list')).toEqual([])
  expect(existsSync(join(kind === 'missing' ? join(s.dir, 'saved') : s.repo, '.hidden'))).toBe(true)
})
async function provision(s: ReturnType<typeof setup>, project_id: string, id?: string) {
  const result = (await s.request('workspace.create', { project_id }, id)) as {
    workspace_id: string
    job_id: string
  }
  await s.core.resources.jobs.drain()
  const job = (await s.request('job.get', { job_id: result.job_id })) as { state: string }
  expect(job.state).toBe('succeeded')
  const workspace = (await s.request('workspace.get', { workspace_id: result.workspace_id })) as {
    workspace_id: string
    path: string
    branch: string
    base_commit: string
    state: string
  }
  return { ...result, ...workspace }
}
it('registers canonical repositories/folders, persists trust and exposes a browsing-only folder root', async () => {
  const s = setup()
  const project = await registered(s)
  const alias = join(s.dir, 'alias')
  symlinkSync(s.repo, alias)
  expect(await s.request('project.register', { path: alias, trust: 'untrusted' })).toMatchObject(
    project
  )
  const folder = join(s.dir, 'folder')
  mkdirSync(folder)
  const p = (await s.request('project.register', { path: folder, trust: 'trusted' })) as {
    project_id: string
  }
  expect(await s.request('workspace.list', { project_id: p.project_id })).toMatchObject([
    { kind: 'root', path: folder, state: 'ready' },
  ])
  await expect(s.request('workspace.create', { project_id: p.project_id })).rejects.toThrow(
    'git_required'
  )
  expect(await s.request('project.list')).toHaveLength(2)
  git(folder, 'init', '-b', 'main')
  git(folder, 'config', 'user.name', 'Fixture')
  git(folder, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(folder, 'initialized'), 'explicit initialization')
  git(folder, 'add', '.')
  git(folder, 'commit', '-m', 'explicit initialization')
  expect(await s.request('project.register', { path: folder, trust: 'trusted' })).toMatchObject({
    project_id: p.project_id,
    repository_path: folder,
  })
  const initialized = await provision(s, p.project_id)
  const removal = (await s.request('workspace.remove', {
    workspace_id: initialized.workspace_id,
  })) as { job_id: string }
  await s.core.resources.jobs.drain()
  expect(await s.request('job.get', { job_id: removal.job_id })).toMatchObject({
    state: 'succeeded',
  })
  await s.request('project.remove', { project_id: p.project_id })
  expect(await s.request('project.list')).toHaveLength(1)
})
it('allocates concurrent isolated branches, reuses original jobs and leaves the original checkout untouched', async () => {
  const s = setup(),
    p = await registered(s)
  const before = git(s.repo, 'status', '--porcelain')
  const params = { project_id: p.project_id }
  const jobs = (await Promise.all([
    s.request('workspace.create', params, 'same'),
    s.request('workspace.create', params, 'same'),
    s.request('workspace.create', params, 'other'),
  ])) as { job_id: string; workspace_id: string }[]
  expect(jobs[0]).toEqual(jobs[1])
  expect(jobs[0]!.workspace_id).not.toBe(jobs[2]!.workspace_id)
  await expect(
    s.request('session.create', { title: 'too early', workspace_id: jobs[0]!.workspace_id })
  ).rejects.toThrow('resource_busy')
  expect(await s.request('session.list')).toEqual([])
  await s.core.resources.jobs.drain()
  const workspaces = (await s.request('workspace.list', params)) as {
    kind: string
    branch: string
    path: string
  }[]
  const managed = workspaces.filter((w) => w.kind === 'managed')
  expect(managed).toHaveLength(2)
  expect(new Set(managed.map((w) => w.branch)).size).toBe(2)
  expect(
    managed.every((w) => w.path.startsWith(join(s.dir, 'repo with spaces.worktrees') + '/'))
  ).toBe(true)
  expect(git(s.repo, 'status', '--porcelain')).toBe(before)
  expect(git(s.repo, 'branch', '--show-current')).toBe('main')
  await expect(
    s.request('workspace.create', { ...params, base_ref: '--upload-pack=touch evil' }, 'injection')
  ).rejects.toThrow('invalid_params')
  await expect(
    s.request('workspace.create', { ...params, base_ref: 'HEAD;touch evil' })
  ).rejects.toThrow('invalid_params')
  await expect(s.request('workspace.create', { ...params, base_ref: 'missing' })).rejects.toThrow(
    'invalid_ref'
  )
  await expect(
    s.request('workspace.create', { ...params, base_ref: 'main' }, 'same')
  ).rejects.toThrow('idempotency_mismatch')
})
it('reads NUL status including renames/spaces/dotfiles and bounded unified HEAD diff', async () => {
  const s = setup(),
    p = await registered(s),
    w = await provision(s, p.project_id)
  writeFileSync(join(w.path, '.hidden'), 'changed\n')
  writeFileSync(join(w.path, 'new file\nname'), 'untracked')
  const status = (await s.request('workspace.status', { workspace_id: w.workspace_id })) as {
    entries: { path: string }[]
  }
  expect(status.entries.map((e) => e.path)).toContain('new file\nname')
  expect(status.entries.map((e) => e.path)).toContain('.hidden')
  expect(await s.request('workspace.diff', { workspace_id: w.workspace_id })).toMatchObject({
    diff: expect.stringContaining('+changed'),
  })
  expect(readFileSync(join(s.repo, '.hidden'), 'utf8')).toBe('original\n')
  git(w.path, 'mv', '.hidden', 'renamed space')
  expect(await s.request('workspace.status', { workspace_id: w.workspace_id })).toMatchObject({
    entries: expect.arrayContaining([
      expect.objectContaining({ path: 'renamed space', original_path: '.hidden' }),
    ]),
  })
})
it('refuses active leases, dirty/untracked/ignored content, roots and changed managed paths; retains branches', async () => {
  const s = setup(),
    p = await registered(s),
    w = await provision(s, p.project_id)
  const session = (await s.request('session.create', {
    title: 'attached',
    workspace_id: w.workspace_id,
  })) as { session_id: string }
  await expect(s.request('workspace.remove', { workspace_id: w.workspace_id })).rejects.toThrow(
    'resource_busy'
  )
  await expect(
    s.request('workspace.remove', { workspace_id: w.workspace_id })
  ).rejects.toMatchObject({
    code: 'resource_busy',
    details: { holder: 'session', session_id: session.session_id, title: 'attached' },
  })
  await expect(
    s.request('session.create', { title: 'second', workspace_id: w.workspace_id })
  ).rejects.toThrow('resource_busy')
  await s.request('session.detach', { session_id: session.session_id })
  writeFileSync(join(w.path, '.hidden'), 'dirty')
  await expect(s.request('workspace.remove', { workspace_id: w.workspace_id })).rejects.toThrow(
    'workspace_dirty'
  )
  git(w.path, 'restore', '.hidden')
  writeFileSync(join(w.path, 'ignored'), 'valuable')
  writeFileSync(join(s.repo, '.git/info/exclude'), 'ignored\n')
  await expect(s.request('workspace.remove', { workspace_id: w.workspace_id })).rejects.toThrow(
    'workspace_dirty'
  )
  rmSync(join(w.path, 'ignored'))
  const root = (
    (await s.request('workspace.list', { project_id: p.project_id })) as {
      kind: string
      workspace_id: string
    }[]
  ).find((x) => x.kind === 'root')!
  await expect(s.request('workspace.remove', { workspace_id: root.workspace_id })).rejects.toThrow(
    'unmanaged_workspace'
  )
  await expect(s.request('project.remove', { project_id: p.project_id })).rejects.toThrow(
    'resource_busy'
  )
  const removal = (await s.request('workspace.remove', { workspace_id: w.workspace_id })) as {
    job_id: string
  }
  await s.core.resources.jobs.drain()
  expect(await s.request('job.get', { job_id: removal.job_id })).toMatchObject({
    state: 'succeeded',
  })
  expect(git(s.repo, 'show-ref', '--verify', 'refs/heads/' + w.branch)).toContain(w.base_commit)
  await s.request('project.remove', { project_id: p.project_id })
  expect(await s.request('job.get', { job_id: removal.job_id })).toMatchObject({
    state: 'succeeded',
  })
  expect(await s.request('project.register', { path: s.repo, trust: 'untrusted' })).toMatchObject(p)
})
it('releases a stopped session lease when deleting its worktree', async () => {
  const s = setup(),
    p = await registered(s),
    w = await provision(s, p.project_id)
  const session = (await s.request('session.create', {
    provider: 'fake',
    title: 'Stopped chat',
    workspace_id: w.workspace_id,
  })) as any
  s.core.append(
    session.session_id,
    'session.stop_requested',
    { kind: 'installation', installation_id: s.actor.installation_id },
    { session_id: session.session_id }
  )
  const removed = (await s.request('workspace.remove', { workspace_id: w.workspace_id })) as any
  await s.core.resources.jobs.drain()
  expect(await s.request('job.get', { job_id: removed.job_id })).toMatchObject({
    state: 'succeeded',
  })
  expect(s.core.session(session.session_id).workspace_id).toBeNull()
})
it.each(['branch_created', 'worktree_created'] as const)(
  'reconciles crash after %s without a second branch/worktree/job',
  async (point) => {
    const s = setup(),
      p = await registered(s)
    const created = (await s.request(
      'workspace.create',
      { project_id: p.project_id },
      'stable'
    )) as { job_id: string; workspace_id: string }
    s.core.resources.jobs.fault = (at) => {
      if (at === point) throw new Error('simulated_crash')
    }
    await expect(s.core.resources.jobs.drain()).rejects.toThrow('simulated_crash')
    s.core.close()
    const reopened = new NodeCore(s.state)
    cores.push(reopened)
    await reopened.resources.jobs.drain()
    expect(
      await reopened.request(s.actor, 'workspace.create', { project_id: p.project_id }, 'stable')
    ).toEqual(created)
    expect(await reopened.request(s.actor, 'job.get', { job_id: created.job_id })).toMatchObject({
      state: 'succeeded',
    })
    expect(git(s.repo, 'worktree', 'list', '--porcelain').match(/worktree /g)).toHaveLength(2)
  }
)
it('fails closed for missing/moved repositories and symlink-replaced workspaces', async () => {
  const s = setup(),
    p = await registered(s),
    w = await provision(s, p.project_id)
  renameSync(w.path, w.path + '-moved')
  symlinkSync(w.path + '-moved', w.path)
  await expect(s.request('workspace.remove', { workspace_id: w.workspace_id })).rejects.toThrow(
    'unmanaged_workspace'
  )
  await expect(s.request('workspace.status', { workspace_id: w.workspace_id })).rejects.toThrow(
    'unmanaged_workspace'
  )
  renameSync(s.repo, s.repo + '-moved')
  await expect(s.request('workspace.create', { project_id: p.project_id })).rejects.toThrow(
    'repository_unavailable'
  )
})
it('reconciles a crash after removal without deleting the branch or losing the job', async () => {
  const s = setup(),
    p = await registered(s),
    w = await provision(s, p.project_id)
  const removal = (await s.request(
    'workspace.remove',
    { workspace_id: w.workspace_id },
    'remove-stable'
  )) as { job_id: string }
  s.core.resources.jobs.fault = (at) => {
    if (at === 'worktree_removed') throw new Error('simulated_crash')
  }
  await expect(s.core.resources.jobs.drain()).rejects.toThrow('simulated_crash')
  s.core.close()
  const reopened = new NodeCore(s.state)
  cores.push(reopened)
  await reopened.resources.jobs.drain()
  expect(
    await reopened.request(
      s.actor,
      'workspace.remove',
      { workspace_id: w.workspace_id },
      'remove-stable'
    )
  ).toEqual(removal)
  expect(await reopened.request(s.actor, 'job.get', { job_id: removal.job_id })).toMatchObject({
    state: 'succeeded',
  })
  expect(git(s.repo, 'show-ref', '--verify', 'refs/heads/' + w.branch)).toContain(w.base_commit)
})
it('refuses session detachment with queued/running work, retains leases across restart', async () => {
  const s = setup(),
    p = await registered(s),
    w = await provision(s, p.project_id)
  const session = (await s.request('session.create', {
    title: 'hang',
    workspace_id: w.workspace_id,
  })) as { session_id: string }
  await s.request('session.send', {
    session_id: session.session_id,
    text: 'queued',
    observed_seq: 0,
    script: [{ kind: 'hang' }],
  })
  await expect(s.request('session.detach', { session_id: session.session_id })).rejects.toThrow(
    'resource_busy'
  )
  s.core.tick()
  await expect(s.request('session.detach', { session_id: session.session_id })).rejects.toThrow(
    'resource_busy'
  )
  s.core.close()
  const reopened = new NodeCore(s.state)
  cores.push(reopened)
  await expect(
    reopened.resources.request(
      s.actor,
      'workspace.remove',
      { workspace_id: w.workspace_id },
      'remove'
    )
  ).rejects.toThrow('resource_busy')
  await reopened.request(
    s.actor,
    'session.detach',
    { session_id: session.session_id },
    'detach-after-restart'
  )
  expect(reopened.resources.workspaces.leased(w.workspace_id)).toBe(false)
})
it('disables repository checkout hooks and smudge/process filters, regardless of recorded trust', async () => {
  const s = setup()
  const marker = join(s.dir, 'executed')
  const hook = join(s.repo, '.git/hooks/post-checkout')
  writeFileSync(hook, '#!/bin/sh\ntouch "' + marker + '"\n')
  chmodSync(hook, 0o700)
  writeFileSync(join(s.repo, '.gitattributes'), '.hidden filter=fixture\n')
  git(s.repo, 'add', '.gitattributes')
  git(s.repo, 'commit', '-m', 'filter fixture')
  git(s.repo, 'config', 'filter.fixture.smudge', 'touch "' + marker + '"; cat')
  git(s.repo, 'config', 'filter.fixture.required', 'true')
  const p = await registered(s),
    w = await provision(s, p.project_id)
  expect(existsSync(marker)).toBe(false)
  expect(readFileSync(join(w.path, '.hidden'), 'utf8')).toBe('original\n')
  git(s.repo, 'config', 'filter.fixture.clean', 'touch "' + marker + '"; cat')
  writeFileSync(join(w.path, '.hidden'), 'changed\n')
  await s.request('workspace.status', { workspace_id: w.workspace_id })
  await s.request('workspace.diff', { workspace_id: w.workspace_id })
  expect(existsSync(marker)).toBe(false)
})
it('does not execute nested submodule clean filters during a root preview', async () => {
  const s = setup(),
    dependency = join(s.dir, 'dependency')
  mkdirSync(dependency)
  git(dependency, 'init', '-b', 'main')
  git(dependency, 'config', 'user.name', 'Fixture')
  git(dependency, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(dependency, '.hidden'), 'original\n')
  writeFileSync(join(dependency, '.gitattributes'), '.hidden filter=nested\n')
  git(dependency, 'add', '.')
  git(dependency, 'commit', '-m', 'nested fixture')
  git(s.repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', dependency, 'nested')
  git(s.repo, 'commit', '-am', 'submodule fixture')
  const nested = join(s.repo, 'nested'),
    marker = join(s.dir, 'nested-executed')
  git(nested, 'config', 'filter.nested.clean', 'touch "' + marker + '"; cat')
  writeFileSync(join(nested, '.hidden'), 'nested change\n')
  const p = await registered(s)
  const root = (
    (await s.request('workspace.list', { project_id: p.project_id })) as {
      kind: string
      workspace_id: string
    }[]
  ).find((w) => w.kind === 'root')!
  await s.request('workspace.status', { workspace_id: root.workspace_id })
  await s.request('workspace.diff', { workspace_id: root.workspace_id })
  expect(existsSync(marker)).toBe(false)
})
it('fences each effect against revocation and does not start queued jobs for revoked principals', async () => {
  const s = setup(),
    p = await registered(s)
  const created = (await s.request('workspace.create', { project_id: p.project_id })) as {
    job_id: string
  }
  s.core.resources.jobs.fault = (at) => {
    if (at === 'branch_created') s.core.revokeToken(s.actor.installation_id)
  }
  await s.core.resources.jobs.drain()
  expect(await s.core.resources.jobs.get(created.job_id)).toMatchObject({
    state: 'needs_attention',
    error: 'unauthorized',
  })
  expect(git(s.repo, 'worktree', 'list', '--porcelain').match(/worktree /g)).toHaveLength(1)
})
it('upgrades a stage 1 database without losing identity, credentials or session receipts', async () => {
  const s = setup()
  const session = await s.request('session.create', { title: 'old' }, 'old-create')
  const identity = s.core.node_id
  s.core.close()
  const db = new DatabaseSync(join(s.state, 'node.sqlite'))
  db.exec(
    'DROP TABLE debug_operations; DROP TABLE debug_grants; DROP TABLE debug_policy; DROP TABLE debug_history_payloads; DROP TABLE debug_history; DROP TABLE debug_events; DROP TABLE debug_sessions; DROP TABLE delegation_reports; DROP TABLE delegations; DROP TABLE delegation_grants; DROP TABLE provider_native_sessions; DROP TABLE codex_thread_bindings; DROP TABLE file_recovery_copies; DROP TABLE IF EXISTS legacy_file_recoveries; DROP TABLE file_mutations; DROP TABLE diff_snapshots; DROP TABLE workspace_contents; DROP TABLE prompt_deliveries; DROP INDEX prompts_session; DROP INDEX prompts_run; DROP TABLE provider_runs; DROP TABLE workspace_leases; DROP TABLE jobs; DROP TABLE workspaces; DROP TABLE projects; PRAGMA user_version=1;'
  )
  db.close()
  const reopened = new NodeCore(s.state)
  cores.push(reopened)
  expect(reopened.node_id).toBe(identity)
  expect(await reopened.request(s.actor, 'session.create', { title: 'old' }, 'old-create')).toEqual(
    session
  )
  expect(await reopened.request(s.actor, 'project.list', {})).toEqual([])
  expect(
    await reopened.request(
      s.actor,
      'project.register',
      { path: s.repo, trust: 'untrusted' },
      'project'
    )
  ).toMatchObject({ root_path: s.repo })
})
it('status pages remain record-bounded and large diffs fail explicitly without truncation', async () => {
  const s = setup(),
    p = await registered(s),
    w = await provision(s, p.project_id)
  for (let i = 0; i < 260; i++) writeFileSync(join(w.path, 'untracked-' + i), 'x')
  let offset = 0,
    count = 0
  do {
    const page = (await s.request('workspace.status', {
      workspace_id: w.workspace_id,
      offset,
      limit: 17,
    })) as { entries: unknown[]; next_offset: number | null }
    expect(() =>
      FrameCodec.encode({ kind: 'response', request_id: 'status', result: page })
    ).not.toThrow()
    count += page.entries.length
    if (page.next_offset === null) break
    offset = page.next_offset
  } while (true)
  expect(count).toBe(260)
  writeFileSync(join(w.path, '.hidden'), 'x'.repeat(40000))
  await expect(s.request('workspace.diff', { workspace_id: w.workspace_id })).rejects.toThrow(
    'output_limit'
  )
})
it('rejects non-UTF-8 filenames rather than returning lossy path identities', async () => {
  const s = setup(),
    p = await registered(s),
    w = await provision(s, p.project_id)
  // APFS refuses creation with EILSEQ, so inject the equivalent Git machine output.
  const runner = s.core.resources.git,
    run = runner.run.bind(runner)
  runner.run = async (cwd, command, beforeEffect) =>
    command.kind === 'status'
      ? Buffer.concat([Buffer.from('?? '), Buffer.from([0xff, 0])])
      : run(cwd, command, beforeEffect)
  await expect(s.request('workspace.status', { workspace_id: w.workspace_id })).rejects.toThrow(
    'unsupported_name'
  )
  await expect(s.request('workspace.remove', { workspace_id: w.workspace_id })).rejects.toThrow(
    'workspace_dirty'
  )
})
it('bounds project catalog pages even with long persisted paths', async () => {
  const s = setup()
  for (let i = 0; i < 100; i++) {
    const path = '/fixture/' + 'x'.repeat(3000) + '/' + i
    const project = {
      project_id: 'long-' + i.toString().padStart(3, '0'),
      root_path: path,
      repository_path: path,
      git_common_dir: path + '/.git',
      trust: 'untrusted',
      created_at: new Date().toISOString(),
    }
    s.core.db
      .prepare('INSERT INTO projects(project_id,root_path,body) VALUES(?,?,?)')
      .run(project.project_id, path, JSON.stringify(project))
  }
  let after_id: string | undefined,
    count = 0
  while (true) {
    const page = (await s.request('project.list', { ...(after_id ? { after_id } : {}) })) as {
      project_id: string
    }[]
    expect(() =>
      FrameCodec.encode({ kind: 'response', request_id: 'projects', result: page })
    ).not.toThrow()
    if (!page.length) break
    count += page.length
    after_id = page.at(-1)!.project_id
  }
  expect(count).toBe(100)
})
it('refuses a managed worktree whose Git metadata has been retargeted to the original checkout', async () => {
  const s = setup(),
    p = await registered(s),
    w = await provision(s, p.project_id)
  writeFileSync(join(w.path, '.git'), 'gitdir: ' + join(s.repo, '.git') + '\n')
  await expect(s.request('workspace.remove', { workspace_id: w.workspace_id })).rejects.toThrow(
    'unmanaged_workspace'
  )
  expect(readFileSync(join(s.repo, '.hidden'), 'utf8')).toBe('original\n')
})
it('allows an explicit empty node-owned root before provisioning and pins it across restarts', async () => {
  const s = setup()
  const custom = join(s.dir, 'custom worktrees')
  s.core.close()
  const configured = new NodeCore(s.state, { worktreeRoot: custom })
  cores.push(configured)
  const p = (await configured.request(
    s.actor,
    'project.register',
    { path: s.repo, trust: 'untrusted' },
    'custom-project'
  )) as { project_id: string }
  const created = (await configured.request(
    s.actor,
    'workspace.create',
    { project_id: p.project_id },
    'custom-workspace'
  )) as { workspace_id: string }
  await configured.resources.jobs.drain()
  expect(
    configured.resources.workspaces.get(created.workspace_id).path.startsWith(custom + '/')
  ).toBe(true)
  configured.close()
  const reopened = new NodeCore(s.state)
  cores.push(reopened)
  expect(reopened.resources.worktreeRoot).toBe(custom)
  reopened.close()
  expect(() => new NodeCore(s.state, { worktreeRoot: join(s.dir, 'another') })).toThrow(
    'worktree_root_already_configured'
  )
})
it('drains failed in-flight provisioning during shutdown without skipping resource cleanup', async () => {
  const s = setup(),
    p = await registered(s)
  await s.request('workspace.create', { project_id: p.project_id })
  let release!: () => void, started!: () => void
  const blocked = new Promise<void>((r) => {
    release = r
  })
  const running = new Promise<void>((r) => {
    started = r
  })
  const runner = s.core.resources.git,
    run = runner.run.bind(runner)
  runner.run = async (cwd, command, beforeEffect) => {
    const result = await run(cwd, command, beforeEffect)
    if (command.kind === 'branch.create') {
      started()
      await blocked
    }
    return result
  }
  s.core.resources.jobs.fault = () => {
    throw new Error('shutdown fault')
  }
  const drain = s.core.resources.jobs.drain()
  // Attach the rejection observer before unblocking the worker.
  const rejected = expect(drain).rejects.toThrow('shutdown fault')
  await running
  const stopped = s.core.resources.stop()
  release()
  await rejected
  await expect(stopped).resolves.toBeUndefined()
})
it('does not follow a symlink substituted for the node-owned worktree directory', async () => {
  const s = setup(),
    p = await registered(s)
  const outside = join(s.dir, 'outside')
  mkdirSync(outside)
  mkdirSync(join(s.state, 'worktrees'), { recursive: true })
  symlinkSync(outside, join(s.dir, 'repo with spaces.worktrees'))
  const created = (await s.request('workspace.create', { project_id: p.project_id })) as {
    job_id: string
  }
  await s.core.resources.jobs.drain()
  expect(await s.request('job.get', { job_id: created.job_id })).toMatchObject({
    state: 'needs_attention',
    error: 'unmanaged_workspace',
  })
  expect(git(s.repo, 'worktree', 'list', '--porcelain').match(/worktree /g)).toHaveLength(1)
})
