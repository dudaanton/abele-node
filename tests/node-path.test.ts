import { afterEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, renameSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'

const dirs: string[] = [],
  cores: NodeCore[] = []
function git(cwd: string, ...args: string[]) {
  const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' })
  if (result.status) throw new Error(result.stderr)
  return result.stdout.trim()
}
function setup() {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/node-path-'))
  dirs.push(dir)
  const folder = join(dir, 'folder')
  mkdirSync(folder)
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let op = 0
  const request = async (method: string, params: unknown = {}, operation?: string) =>
    (await core.request(actor, method, params, operation ?? 'fixture-' + ++op)) as any
  return { dir, folder, core, actor, request }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const core of cores.splice(0)) {
    await core.resources.stop()
    core.close()
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
it('registers an exact Git subfolder without granting the parent repository and preserves ceiling-bounded legacy registration', async () => {
  const s = setup()
  git(s.folder, 'init', '-b', 'trunk')
  const child = join(s.folder, 'child')
  mkdirSync(child)
  const exact = await s.request('project.register', {
    path: child,
    trust: 'untrusted',
    exact_root: true,
  })
  expect(exact).toMatchObject({ root_path: child, repository_path: null, git_common_dir: null })
  const root = (await s.request('workspace.list', { project_id: exact.project_id }))[0]
  writeFileSync(join(child, 'file.txt'), 'scoped')
  expect(
    (await s.request('workspace.files', { workspace_id: root.workspace_id })).entries.map(
      (e: any) => e.name
    )
  ).toEqual(['file.txt'])
  await expect(
    s.request('repository.v1.worktrees', { project_id: exact.project_id })
  ).rejects.toThrow('git_required')
  const legacy = await s.request('project.register', { path: child, trust: 'untrusted' })
  // The existing Git ceiling already stops inherited repository discovery for this case.
  expect(legacy.root_path).toBe(child)
})
it('lists directories with bounded owner handles, creates one child idempotently and rejects substituted parents', async () => {
  const s = setup()
  mkdirSync(join(s.folder, 'a'))
  mkdirSync(join(s.folder, 'b'))
  writeFileSync(join(s.folder, 'file'), 'file')
  symlinkSync(join(s.folder, 'a'), join(s.folder, 'link'))
  const page = await s.request('filesystem.v1.directories', { path: s.folder, limit: 1 })
  expect(page.entries.map((e: any) => e.name)).toEqual(['a'])
  const next = await s.request('filesystem.v1.directories', {
    path: s.folder,
    cursor: page.cursor,
    limit: 1,
  })
  expect(next.entries.map((e: any) => e.name)).toEqual(['b'])
  const params = { directory_id: page.directory_id, name: 'new' }
  const created = await s.request('filesystem.v1.mkdir', params, 'mkdir-one')
  expect(created.path).toBe(join(s.folder, 'new'))
  expect(await s.request('filesystem.v1.mkdir', params, 'mkdir-one')).toEqual(created)
  await expect(s.request('filesystem.v1.mkdir', { ...params, name: '../escape' })).rejects.toThrow(
    'invalid_params'
  )
  const other = s.core.authority.authenticate(s.core.createToken('other').token)
  await expect(
    Promise.resolve().then(() =>
      s.core.request(other, 'filesystem.v1.mkdir', params, 'other-mkdir')
    )
  ).rejects.toThrow('unauthorized')
  renameSync(s.folder, s.folder + '-old')
  mkdirSync(s.folder)
  await expect(s.request('filesystem.v1.mkdir', { ...params, name: 'bad' })).rejects.toThrow(
    'stale_resource'
  )
})
it('initializes a registered plain folder explicitly and retains project/root IDs without a first commit', async () => {
  const s = setup()
  const project = await s.request('project.register', {
    path: s.folder,
    trust: 'untrusted',
    exact_root: true,
  })
  const root = (await s.request('workspace.list', { project_id: project.project_id }))[0]
  const params = { project_id: project.project_id, initial_branch: 'trunk' }
  const initialized = await s.request('project.git_init', params, 'init-one')
  expect(initialized).toMatchObject({
    project_id: project.project_id,
    root_path: s.folder,
    repository_path: s.folder,
    trust: 'untrusted',
  })
  expect(await s.request('project.git_init', params, 'init-one')).toEqual(initialized)
  expect(
    (await s.request('repository.v1.worktrees', { project_id: project.project_id })).entries[0]
  ).toMatchObject({ kind: 'root', workspace_id: root.workspace_id, head: null })
  await expect(s.request('project.git_init', params)).rejects.toThrow('git_required')
})
it('reports opted-in partly/untracked details with stable observed IDs across refresh and restart, changing on content rather than XY', async () => {
  const s = setup()
  git(s.folder, 'init', '-b', 'trunk')
  git(s.folder, 'config', 'user.name', 'Fixture')
  git(s.folder, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(s.folder, 'sample'), 'initial')
  git(s.folder, 'add', '.')
  git(s.folder, 'commit', '-m', 'initial')
  const project = await s.request('project.register', { path: s.folder, trust: 'untrusted' })
  const target = (await s.request('repository.v1.worktrees', { project_id: project.project_id }))
    .entries[0].worktree_id
  writeFileSync(join(s.folder, 'sample'), 'staged')
  git(s.folder, 'add', 'sample')
  writeFileSync(join(s.folder, 'sample'), 'working')
  writeFileSync(join(s.folder, 'new'), 'new')
  const status = async () => {
    const observation = await s.request('repository.v1.observe', { worktree_id: target })
    return s.request('repository.v1.status', {
      worktree_id: target,
      revision: observation.revision,
      include_change_details: true,
    })
  }
  const first = await status()
  expect(first.entries.find((e: any) => e.path === 'sample')).toMatchObject({
    kind: 'M',
    stage: 'partly',
    time_basis: 'observed',
  })
  expect(first.entries.find((e: any) => e.path === 'new')).toMatchObject({
    kind: 'A',
    stage: 'unstaged',
  })
  expect(await status()).toEqual(first)
  const observation = await s.request('repository.v1.observe', { worktree_id: target })
  const legacy = await s.request('repository.v1.status', {
    worktree_id: target,
    revision: observation.revision,
  })
  expect(legacy.entries.find((e: any) => e.path === 'sample')).toEqual({
    index: 'M',
    worktree: 'M',
    path: 'sample',
  })
  await s.core.resources.stop()
  s.core.close()
  cores.splice(cores.indexOf(s.core), 1)
  const reopened = new NodeCore(join(s.dir, 'state'))
  cores.push(reopened)
  const persisted = reopened.db
    .prepare('SELECT body FROM repository_change_stamps WHERE worktree_id=? AND path=?')
    .get(target, 'sample') as { body: string }
  expect(JSON.parse(persisted.body).change_id).toBe(
    first.entries.find((e: any) => e.path === 'sample').change_id
  )
  const token = reopened.authority.authenticate(reopened.createToken('reopened').token)
  writeFileSync(join(s.folder, 'sample'), 'changed with same status')
  const current = (await reopened.request(token, 'repository.v1.observe', {
    worktree_id: target,
  })) as any
  const changed = (await reopened.request(token, 'repository.v1.status', {
    worktree_id: target,
    revision: current.revision,
    include_change_details: true,
  })) as any
  expect(changed.entries.find((e: any) => e.path === 'sample').change_id).not.toBe(
    first.entries.find((e: any) => e.path === 'sample').change_id
  )
})
it('counts actual divergence from the configured default, with both sides nonzero and no guessed default', async () => {
  const s = setup()
  git(s.folder, 'init', '-b', 'trunk')
  git(s.folder, 'config', 'user.name', 'Fixture')
  git(s.folder, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(s.folder, 'initial'), 'initial')
  git(s.folder, 'add', '.')
  git(s.folder, 'commit', '-m', 'initial')
  git(s.folder, 'branch', 'topic')
  writeFileSync(join(s.folder, 'base'), 'base')
  git(s.folder, 'add', '.')
  git(s.folder, 'commit', '-m', 'base')
  git(s.folder, 'checkout', 'topic')
  writeFileSync(join(s.folder, 'topic'), 'topic')
  git(s.folder, 'add', '.')
  git(s.folder, 'commit', '-m', 'topic')
  const project = await s.request('project.register', { path: s.folder, trust: 'untrusted' })
  const target = (await s.request('repository.v1.worktrees', { project_id: project.project_id }))
    .entries[0].worktree_id
  expect(await s.request('repository.v1.divergence', { worktree_id: target })).toMatchObject({
    ahead: null,
    behind: null,
    reason: 'default_branch_required',
  })
  await s.request('project.repository_settings', {
    project_id: project.project_id,
    external_read: false,
    default_branch: 'trunk',
  })
  expect(await s.request('repository.v1.divergence', { worktree_id: target })).toMatchObject({
    base_ref: 'trunk',
    ahead: 1,
    behind: 1,
    reason: 'ok',
  })
})
it('persists installation-specific selection without granting external read access or hiding the root', async () => {
  const s = setup()
  git(s.folder, 'init', '-b', 'trunk')
  git(s.folder, 'config', 'user.name', 'Fixture')
  git(s.folder, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(s.folder, 'sample'), 'initial')
  git(s.folder, 'add', '.')
  git(s.folder, 'commit', '-m', 'initial')
  const project = await s.request('project.register', { path: s.folder, trust: 'untrusted' })
  git(s.folder, 'worktree', 'add', '-b', 'side', join(s.dir, 'external'))
  await s.request('project.repository_settings', {
    project_id: project.project_id,
    external_read: true,
  })
  const catalog = () =>
    s.request('repository.v1.worktrees', {
      project_id: project.project_id,
      include_selection: true,
    })
  const entries = (await catalog()).entries
  expect(entries[0]).toMatchObject({ kind: 'root', listed: true })
  const external = entries.find((e: any) => e.kind === 'external')
  expect(external.listed).toBe(false)
  await expect(
    s.request('project.worktree_selection', {
      project_id: project.project_id,
      worktree_id: entries[0].worktree_id,
      listed: false,
    })
  ).rejects.toThrow('invalid_params')
  await s.request('project.worktree_selection', {
    project_id: project.project_id,
    worktree_id: external.worktree_id,
    listed: true,
  })
  expect((await catalog()).entries.find((e: any) => e.kind === 'external').listed).toBe(true)
  const other = s.core.authority.authenticate(s.core.createToken('other').token)
  expect(
    (
      (await s.core.request(other, 'repository.v1.worktrees', {
        project_id: project.project_id,
        include_selection: true,
      })) as any
    ).entries.find((e: any) => e.kind === 'external').listed
  ).toBe(false)
})
it('pushes plain folder invalidations on catalog, and stops leases on unwatch', async () => {
  const s = setup()
  const project = await s.request('project.register', { path: s.folder, trust: 'untrusted' })
  const workspace = (await s.request('workspace.list', { project_id: project.project_id }))[0]
  const lease = await s.request('workspace.watch', { workspace_id: workspace.workspace_id })
  const before = s.core.head('catalog')
  writeFileSync(join(s.folder, 'new'), 'changed')
  await expect.poll(() => s.core.head('catalog'), { timeout: 5000 }).toBeGreaterThan(before)
  const events = await s.request('stream.read', { stream_id: 'catalog', after_seq: before })
  expect(JSON.stringify(events)).toContain('workspace.invalidated')
  expect(
    await s.request('workspace.unwatch', {
      workspace_id: workspace.workspace_id,
      subscription_id: lease.subscription_id,
    })
  ).toEqual({ removed: true })
})

it('expires picker handles and refuses durable unknown effects after restart instead of replaying', async () => {
  const s = setup()
  const picker = await s.request('filesystem.v1.directories', { path: s.folder })
  const clock = vi.spyOn(Date, 'now')
  const before = Date.now()
  clock.mockReturnValue(before + 61000)
  await expect(
    s.request('filesystem.v1.mkdir', { directory_id: picker.directory_id, name: 'expired' })
  ).rejects.toThrow('stale_resource')
  clock.mockRestore()
  const fresh = await s.request('filesystem.v1.directories', { path: s.folder })
  const params = { directory_id: fresh.directory_id, name: 'unknown' }
  s.core.resources.nodePath.fault = () => {
    throw new Error('crash')
  }
  await expect(s.request('filesystem.v1.mkdir', params, 'unknown-mkdir')).rejects.toThrow('crash')
  await s.core.resources.stop()
  s.core.close()
  cores.splice(cores.indexOf(s.core), 1)
  const reopened = new NodeCore(join(s.dir, 'state'))
  cores.push(reopened)
  const actor = reopened.authority.authenticate(reopened.createToken('reopened').token)
  // Recovery belongs to the original installation, never a newly enrolled principal.
  await expect(
    Promise.resolve().then(() =>
      reopened.request(s.actor, 'filesystem.v1.mkdir', params, 'unknown-mkdir')
    )
  ).rejects.toThrow('outcome_unknown')
  await expect(
    Promise.resolve().then(() =>
      reopened.request(actor, 'filesystem.v1.mkdir', params, 'unknown-mkdir')
    )
  ).rejects.toThrow('stale_resource')
})
it('fences an uncertain filesystem operation ID against reuse by another mutation coordinator', async () => {
  const s = setup()
  const picker = await s.request('filesystem.v1.directories', { path: s.folder })
  s.core.resources.nodePath.fault = () => {
    throw new Error('crash')
  }
  const params = { directory_id: picker.directory_id, name: 'uncertain' }
  await expect(s.request('filesystem.v1.mkdir', params, 'shared-operation')).rejects.toThrow(
    'crash'
  )
  await expect(s.request('session.create', { title: 'reuse' }, 'shared-operation')).rejects.toThrow(
    'idempotency_mismatch'
  )
  await expect(
    s.request('project.register', { path: s.folder, trust: 'untrusted' }, 'shared-operation')
  ).rejects.toThrow('idempotency_mismatch')
})
it('maps staged rename/deletion and conflicts without treating an unmerged index as staged', async () => {
  const s = setup()
  git(s.folder, 'init', '-b', 'trunk')
  git(s.folder, 'config', 'user.name', 'Fixture')
  git(s.folder, 'config', 'user.email', 'fixture@example.invalid')
  for (const name of ['sample', 'delete', 'rename'])
    writeFileSync(join(s.folder, name), name + '\n')
  git(s.folder, 'add', '.')
  git(s.folder, 'commit', '-m', 'initial')
  git(s.folder, 'branch', 'side')
  writeFileSync(join(s.folder, 'sample'), 'trunk\n')
  git(s.folder, 'commit', '-am', 'trunk')
  git(s.folder, 'checkout', 'side')
  writeFileSync(join(s.folder, 'sample'), 'side\n')
  git(s.folder, 'commit', '-am', 'side')
  const merge = spawnSync('/usr/bin/git', ['merge', 'trunk'], { cwd: s.folder })
  expect(merge.status).not.toBe(0)
  git(s.folder, 'mv', 'rename', 'renamed')
  git(s.folder, 'rm', 'delete')
  const project = await s.request('project.register', { path: s.folder, trust: 'untrusted' })
  const worktree_id = (
    await s.request('repository.v1.worktrees', { project_id: project.project_id })
  ).entries[0].worktree_id
  const head = (await s.request('repository.v1.observe', { worktree_id })).revision
  const status = await s.request('repository.v1.status', {
    worktree_id,
    revision: head,
    include_change_details: true,
  })
  expect(status.entries.find((e: any) => e.path === 'sample')).toMatchObject({
    kind: 'conflict',
    stage: 'unstaged',
  })
  expect(status.entries.find((e: any) => e.path === 'delete')).toMatchObject({
    kind: 'D',
    stage: 'staged',
  })
  expect(status.entries.find((e: any) => e.path === 'renamed')).toMatchObject({
    kind: 'R',
    stage: 'staged',
    original_path: 'rename',
  })
})
