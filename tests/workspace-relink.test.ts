import { afterEach, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { Workspace } from '../packages/node-protocol/src/resources.js'
import { NodeCore } from '../packages/node-core/src/index.js'

const dirs: string[] = [],
  cores: NodeCore[] = []
function git(cwd: string, ...args: string[]) {
  const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
async function setup() {
  const dir = mkdtempSync(resolve('.scratch/workspace-relink-'))
  dirs.push(dir)
  const repo = join(dir, 'sample-repo')
  mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Fixture')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(repo, 'file'), 'original\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'fixture')
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let operation = 0
  const request = async (method: string, params: unknown = {}, id?: string): Promise<any> =>
    core.request(actor, method, params, id ?? `fixture-${++operation}`)
  const project = await request('project.register', { path: repo, trust: 'trusted' })
  const params = { project_id: project.project_id, branch: 'feature' }
  const created = await request('workspace.create', params)
  return { dir, repo, core, actor, request, project, params, created }
}
afterEach(async () => {
  for (const core of cores.splice(0)) {
    await core.resources.stop()
    core.close()
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function duplicate(
  s: Awaited<ReturnType<typeof setup>>,
  original: Workspace,
  state: Workspace['state']
) {
  const workspace = { ...original, workspace_id: randomUUID(), state }
  s.core.db
    .prepare('INSERT INTO workspaces VALUES(?,?,?,?)')
    .run(workspace.workspace_id, workspace.project_id, state, JSON.stringify(workspace))
  return workspace
}

it('rejects repeated and concurrent reservations for the same path before any Git job runs', async () => {
  const s = await setup()
  const results = await Promise.allSettled([
    s.request('workspace.create', s.params),
    s.request('workspace.create', s.params),
  ])
  expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
  for (const result of results)
    if (result.status === 'rejected') expect(result.reason).toMatchObject({ code: 'resource_busy' })
  expect(await s.request('workspace.list', { project_id: s.project.project_id })).toHaveLength(2)
  expect(await s.request('job.list', { project_id: s.project.project_id })).toHaveLength(1)
  await s.core.resources.jobs.drain()
  expect(await s.request('job.get', { job_id: s.created.job_id })).toMatchObject({
    state: 'succeeded',
  })
})

it('allows only one of simultaneous first creates for a new path', async () => {
  const s = await setup()
  const params = { ...s.params, branch: 'concurrent' }
  const results = await Promise.allSettled(
    Array.from({ length: 3 }, () => s.request('workspace.create', params))
  )
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(2)
  await s.core.resources.jobs.drain()
  const workspaces = await s.request('workspace.list', { project_id: s.project.project_id })
  expect(workspaces.filter((w: Workspace) => w.branch === 'concurrent')).toMatchObject([
    { state: 'ready' },
  ])
})

it('keeps a failed create reserved until the owner retires it, then permits a fresh create', async () => {
  const s = await setup()
  const workspace = s.core.resources.workspaces.get(s.created.workspace_id)
  s.core.resources.workspaces.save({ ...workspace, state: 'needs_attention' })
  const job = s.core.resources.jobs.get(s.created.job_id)
  s.core.resources.jobs.save({ ...job, state: 'needs_attention', error: 'unmanaged_workspace' })
  await expect(s.request('workspace.create', s.params)).rejects.toMatchObject({
    code: 'resource_busy',
  })
  const retired = await s.request(
    'workspace.retire',
    { workspace_id: workspace.workspace_id },
    'retire'
  )
  expect(retired).toMatchObject({ workspace_id: workspace.workspace_id, state: 'removed' })
  expect(
    await s.request('workspace.retire', { workspace_id: workspace.workspace_id }, 'retire')
  ).toEqual(retired)
  const created = await s.request('workspace.create', s.params)
  await s.core.resources.jobs.drain()
  expect(await s.request('workspace.get', { workspace_id: created.workspace_id })).toMatchObject({
    state: 'ready',
  })
})

it.each([false, true])(
  'prefers the ready workspace and heals an existing target (existing=%s)',
  async (existing) => {
    const s = await setup()
    await s.core.resources.jobs.drain()
    const original = s.core.resources.workspaces.get(s.created.workspace_id)
    // Reproduce legacy insertion order: two failed records precede the successful one.
    s.core.resources.workspaces.save({ ...original, state: 'needs_attention' })
    duplicate(s, original, 'needs_attention')
    let target: any
    if (existing) {
      target = (
        await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
      ).entries.find((e: any) => e.workspace_id === original.workspace_id)
      expect(target).toBeDefined()
    }
    const ready = duplicate(s, original, 'ready')
    const entry = (
      await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
    ).entries.find((e: any) => e.branch === 'refs/heads/feature')
    expect(entry).toMatchObject({
      workspace_id: ready.workspace_id,
      kind: 'managed',
      availability: 'available',
    })
    if (existing) expect(entry.worktree_id).toBe(target.worktree_id)
    expect(s.core.resources.repository.executionIdentity(entry.worktree_id)).toMatchObject({
      path: ready.path,
    })
    expect(
      s.core.db
        .prepare('SELECT workspace_id FROM repository_targets WHERE worktree_id=?')
        .get(entry.worktree_id)
    ).toMatchObject({ workspace_id: ready.workspace_id })
    // The same stored target survives subsequent reads too.
    expect(
      (await s.request('repository.v1.worktrees', { project_id: s.project.project_id })).entries
    ).toContainEqual(
      expect.objectContaining({ worktree_id: entry.worktree_id, workspace_id: ready.workspace_id })
    )
  }
)

it('updates an external target when a ready managed record appears at the same path', async () => {
  const s = await setup()
  await s.core.resources.jobs.drain()
  const workspace = s.core.resources.workspaces.get(s.created.workspace_id)
  s.core.resources.workspaces.save({ ...workspace, state: 'removed' })
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: true,
  })
  const external = (
    await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  ).entries.find((e: any) => e.kind === 'external')
  s.core.resources.workspaces.save(workspace)
  const entry = (
    await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  ).entries.find((e: any) => e.worktree_id === external.worktree_id)
  expect(entry).toMatchObject({ workspace_id: workspace.workspace_id, kind: 'managed' })
  expect(
    s.core.db
      .prepare('SELECT kind FROM repository_targets WHERE worktree_id=?')
      .get(entry.worktree_id)
  ).toMatchObject({ kind: 'managed' })
})

it('prepares integration with the same source target after its workspace link heals', async () => {
  const s = await setup()
  await s.core.resources.jobs.drain()
  const workspace = s.core.resources.workspaces.get(s.created.workspace_id)
  const entries = (await s.request('repository.v1.worktrees', { project_id: s.project.project_id }))
    .entries
  const root = entries.find((e: any) => e.kind === 'root')
  const source = entries.find((e: any) => e.workspace_id === workspace.workspace_id)
  const context = await s.request('integration.context.v1.create', {
    parent_chat_id: 'fixture-integration',
    worktree_id: root.worktree_id,
  })
  const params = {
    context_id: context.context_id,
    parent_chat_id: 'fixture-integration',
    worktree_id: root.worktree_id,
    source_worktree_id: source.worktree_id,
    target_branch: 'main',
    source_branch: 'feature',
    expected_target_head: root.head,
    expected_source_head: source.head,
    permission_mode: 'ask',
  }
  s.core.resources.workspaces.save({ ...workspace, state: 'needs_attention' })
  await expect(s.request('integration.context.v1.prepare', params)).rejects.toMatchObject({
    code: 'resource_busy',
  })
  duplicate(s, workspace, 'ready')
  await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  expect(await s.request('integration.context.v1.prepare', params)).toMatchObject({
    state: 'pending_approval',
  })
  expect(git(s.repo, 'rev-parse', 'HEAD')).toBe(root.head)
})

it('drops managed access after retiring a sole failed record while preserving its folder', async () => {
  const s = await setup()
  await s.core.resources.jobs.drain()
  const workspace = s.core.resources.workspaces.get(s.created.workspace_id)
  const entry = (
    await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  ).entries.find((e: any) => e.workspace_id === workspace.workspace_id)
  s.core.resources.workspaces.save({ ...workspace, state: 'needs_attention' })
  const job = s.core.resources.jobs.get(s.created.job_id)
  s.core.resources.jobs.save({ ...job, state: 'needs_attention', error: 'unmanaged_workspace' })
  await s.request('workspace.retire', { workspace_id: workspace.workspace_id })
  expect(
    (await s.request('repository.v1.worktrees', { project_id: s.project.project_id })).entries
  ).not.toContainEqual(expect.objectContaining({ worktree_id: entry.worktree_id }))
  expect(() => s.core.resources.repository.executionIdentity(entry.worktree_id)).toThrow(
    'unauthorized'
  )
  expect(readFileSync(join(workspace.path, 'file'), 'utf8')).toBe('original\n')
})

it('returns a readable reason when execution prepare finds a non-ready workspace', async () => {
  const s = await setup()
  await s.core.resources.jobs.drain()
  const workspace = s.core.resources.workspaces.get(s.created.workspace_id)
  const entry = (
    await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  ).entries.find((e: any) => e.workspace_id === workspace.workspace_id)
  const target = { kind: 'worktree', worktree_id: entry.worktree_id }
  await s.request('project.execution', { project_id: s.project.project_id, target, enabled: true })
  const context = await s.request('command.context.v1.create', {
    parent_chat_id: 'fixture-chat',
    worktree_id: entry.worktree_id,
  })
  s.core.resources.workspaces.save({ ...workspace, state: 'needs_attention' })
  await expect(
    s.request('command.context.v1.prepare', {
      context_id: context.context_id,
      parent_chat_id: 'fixture-chat',
      argv: ['true'],
      permission_mode: 'ask',
    })
  ).rejects.toMatchObject({
    code: 'resource_busy',
    message: expect.stringContaining('workspace record is not ready: needs_attention'),
  })
})

it('retires only the failed create record without touching a ready sibling, files or jobs', async () => {
  const s = await setup()
  await s.core.resources.jobs.drain()
  const original = s.core.resources.workspaces.get(s.created.workspace_id)
  s.core.resources.workspaces.save({ ...original, state: 'needs_attention' })
  const job = s.core.resources.jobs.get(s.created.job_id)
  s.core.resources.jobs.save({ ...job, state: 'needs_attention', error: 'unmanaged_workspace' })
  const ready = duplicate(s, original, 'ready')
  writeFileSync(join(ready.path, 'file'), 'owner changes\n')
  const before = git(s.repo, 'worktree', 'list', '--porcelain')
  const jobs = await s.request('job.list', { project_id: s.project.project_id })
  await s.request('workspace.retire', { workspace_id: original.workspace_id })
  expect(s.core.resources.workspaces.get(original.workspace_id).state).toBe('removed')
  expect(s.core.resources.workspaces.get(ready.workspace_id)).toEqual(ready)
  expect(readFileSync(join(ready.path, 'file'), 'utf8')).toBe('owner changes\n')
  expect(git(s.repo, 'worktree', 'list', '--porcelain')).toBe(before)
  expect(await s.request('job.list', { project_id: s.project.project_id })).toEqual(jobs)
})

it('refuses retirement of ready, provisioning, leased or still-running records and failed removals', async () => {
  const s = await setup()
  const params = { workspace_id: s.created.workspace_id }
  await expect(s.request('workspace.retire', params)).rejects.toMatchObject({
    code: 'resource_busy',
  })
  await s.core.resources.jobs.drain()
  await expect(s.request('workspace.retire', params)).rejects.toMatchObject({
    code: 'resource_busy',
  })
  const workspace = s.core.resources.workspaces.get(s.created.workspace_id)
  s.core.resources.workspaces.save({ ...workspace, state: 'needs_attention' })
  const job = s.core.resources.jobs.get(s.created.job_id)
  s.core.resources.jobs.save({ ...job, state: 'running' })
  await expect(s.request('workspace.retire', params)).rejects.toMatchObject({
    code: 'resource_busy',
  })
  s.core.resources.jobs.save({ ...job, kind: 'workspace.remove', state: 'needs_attention' })
  await expect(s.request('workspace.retire', params)).rejects.toMatchObject({
    code: 'resource_busy',
  })
  s.core.resources.jobs.save({ ...job, state: 'needs_attention' })
  const session = await s.request('session.create', { title: 'fixture', provider: 'fake' })
  s.core.db
    .prepare('INSERT INTO workspace_leases VALUES(?,?)')
    .run(workspace.workspace_id, session.session_id)
  await expect(s.request('workspace.retire', params)).rejects.toMatchObject({
    code: 'resource_busy',
  })
})
