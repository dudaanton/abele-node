import { afterEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
const dirs: string[] = [],
  cores: NodeCore[] = []
const git = (cwd: string, ...args: string[]) => {
  const p = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' })
  if (p.status) throw new Error(p.stderr)
  return p.stdout.trim()
}
async function setup() {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/node-path-worktrees-'))
  dirs.push(dir)
  const folder = join(dir, 'folder')
  mkdirSync(folder)
  git(folder, 'init', '-b', 'trunk')
  git(folder, 'config', 'user.name', 'Fixture')
  git(folder, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(folder, 'sample'), 'initial')
  writeFileSync(join(folder, '.gitignore'), 'ignored\n')
  git(folder, 'add', '.')
  git(folder, 'commit', '-m', 'initial')
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let op = 0
  const request = async (method: string, params: unknown, operation?: string) =>
    (await core.request(actor, method, params, operation ?? 'fixture-' + ++op)) as any
  const project = await request('project.register', { path: folder, trust: 'untrusted' })
  return { dir, folder, core, actor, project, request }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of cores.splice(0)) {
    await c.resources.stop()
    c.close()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
it('creates a named branch from base, attaches an existing branch at its own tip and refuses checked-out names', async () => {
  const s = await setup()
  const created = await s.request('workspace.create', {
    project_id: s.project.project_id,
    branch: 'topic',
    base_ref: 'trunk',
  })
  await s.core.resources.jobs.drain()
  const work = await s.request('workspace.get', { workspace_id: created.workspace_id })
  expect(work).toMatchObject({ branch: 'topic', state: 'ready' })
  git(work.path, 'config', 'user.name', 'Fixture')
  git(work.path, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(work.path, 'topic'), 'topic')
  git(work.path, 'add', '.')
  git(work.path, 'commit', '-m', 'topic')
  const tip = git(work.path, 'rev-parse', 'HEAD')
  const removal = await s.request('workspace.remove', { workspace_id: work.workspace_id })
  await s.core.resources.jobs.drain()
  expect((await s.request('job.get', { job_id: removal.job_id })).state).toBe('succeeded')
  const existing = await s.request('workspace.create', {
    project_id: s.project.project_id,
    branch: 'topic',
    base_ref: 'does-not-exist',
  })
  await s.core.resources.jobs.drain()
  const attached = await s.request('workspace.get', { workspace_id: existing.workspace_id })
  expect(attached.state).toBe('ready')
  expect(git(attached.path, 'rev-parse', 'HEAD')).toBe(tip)
  await expect(
    s.request('workspace.create', { project_id: s.project.project_id, branch: 'topic' })
  ).rejects.toThrow('resource_busy')
  await expect(
    s.request('workspace.create', { project_id: s.project.project_id, branch: 'trunk' })
  ).rejects.toThrow('resource_busy')
  await expect(
    s.request('workspace.create', { project_id: s.project.project_id, branch: 'bad.lock' })
  ).rejects.toThrow('invalid_params')
})
it('reconciles an existing-branch create after a worktree effect without deleting the pre-existing branch', async () => {
  const s = await setup()
  git(s.folder, 'branch', 'existing')
  const created = await s.request('workspace.create', {
    project_id: s.project.project_id,
    branch: 'existing',
  })
  s.core.resources.jobs.fault = (point) => {
    if (point === 'worktree_created') throw new Error('crash')
  }
  await expect(s.core.resources.jobs.drain()).rejects.toThrow('crash')
  s.core.resources.jobs.fault = undefined
  await s.core.resources.jobs.drain()
  expect((await s.request('workspace.get', { workspace_id: created.workspace_id })).state).toBe(
    'ready'
  )
  expect(git(s.folder, 'rev-parse', 'refs/heads/existing')).toBe(git(s.folder, 'rev-parse', 'HEAD'))
})
it('deletes only a confirmed clean external identity, never root, dirty, ignored or locked worktrees', async () => {
  const s = await setup(),
    external = join(s.dir, 'external')
  git(s.folder, 'worktree', 'add', '-b', 'side', external)
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: true,
  })
  const entries = (await s.request('repository.v1.worktrees', { project_id: s.project.project_id }))
    .entries
  const target = entries.find((e: any) => e.kind === 'external').worktree_id
  const params = async (worktree_id = target) => {
    const observation = await s.request('repository.v1.observe', { worktree_id })
    return {
      worktree_id,
      expected_head: observation.revision.head,
      expected_observation_id: observation.revision.observation_id,
    }
  }
  await expect(
    s.request('repository.v1.worktree.delete', await params(entries[0].worktree_id))
  ).rejects.toThrow('unmanaged_workspace')
  writeFileSync(join(external, 'sample'), 'dirty')
  await expect(s.request('repository.v1.worktree.delete', await params())).rejects.toThrow(
    'workspace_dirty'
  )
  git(external, 'checkout', '--', 'sample')
  writeFileSync(join(external, 'ignored'), 'valuable')
  await expect(s.request('repository.v1.worktree.delete', await params())).rejects.toThrow(
    'workspace_dirty'
  )
  rmSync(join(external, 'ignored'))
  git(s.folder, 'worktree', 'lock', external)
  await expect(s.request('repository.v1.worktree.delete', await params())).rejects.toThrow(
    'resource_busy'
  )
  git(s.folder, 'worktree', 'unlock', external)
  const confirmed = await params()
  writeFileSync(join(external, 'new'), 'new')
  await expect(s.request('repository.v1.worktree.delete', confirmed)).rejects.toThrow(
    'stale_revision'
  )
  rmSync(join(external, 'new'))
  const final = await params()
  const deleted = await s.request('repository.v1.worktree.delete', final, 'delete-one')
  expect(deleted).toEqual({ worktree_id: target, state: 'deleted' })
  expect(existsSync(external)).toBe(false)
  expect(await s.request('repository.v1.worktree.delete', final, 'delete-one')).toEqual(deleted)
  expect(git(s.folder, 'rev-parse', 'refs/heads/side')).toBe(final.expected_head)
})
it('never replays an external deletion whose effect reply was lost across restart', async () => {
  const s = await setup(),
    external = join(s.dir, 'external')
  git(s.folder, 'worktree', 'add', '-b', 'side', external)
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: true,
  })
  const target = (
    await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  ).entries.find((e: any) => e.kind === 'external').worktree_id
  const observation = await s.request('repository.v1.observe', { worktree_id: target })
  const params = {
    worktree_id: target,
    expected_head: observation.revision.head,
    expected_observation_id: observation.revision.observation_id,
  }
  s.core.resources.repository.deleteFault = () => {
    throw new Error('crash')
  }
  await expect(
    s.request('repository.v1.worktree.delete', params, 'unknown-delete')
  ).rejects.toThrow('crash')
  expect(existsSync(external)).toBe(false)
  await expect(s.request('session.create', { title: 'reuse' }, 'unknown-delete')).rejects.toThrow(
    'idempotency_mismatch'
  )
  await s.core.resources.stop()
  s.core.close()
  cores.splice(cores.indexOf(s.core), 1)
  const core = new NodeCore(join(s.dir, 'state'))
  cores.push(core)
  const replay = vi.spyOn(core.resources.git, 'run')
  await core.resources.ready
  expect(
    await core.request(s.actor, 'repository.v1.worktree.delete', params, 'unknown-delete')
  ).toMatchObject({ worktree_id: target, state: 'deleted', reconciliation: 'applied_as_observed' })
  expect(replay.mock.calls.some(([, command]) => command.kind === 'worktree.remove')).toBe(false)
  expect(git(s.folder, 'rev-parse', 'refs/heads/side')).toBe(params.expected_head)
})
it('waits for an in-flight identical deletion rather than committing a premature unknown receipt', async () => {
  const s = await setup(),
    external = join(s.dir, 'external')
  git(s.folder, 'worktree', 'add', '-b', 'side', external)
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: true,
  })
  const target = (
    await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  ).entries.find((e: any) => e.kind === 'external').worktree_id
  const observed = (await s.request('repository.v1.observe', { worktree_id: target })).revision
  const params = {
    worktree_id: target,
    expected_head: observed.head,
    expected_observation_id: observed.observation_id,
  }
  const original = s.core.resources.git.run.bind(s.core.resources.git)
  let release!: () => void, arrived!: () => void
  const gate = new Promise<void>((resolve) => {
      release = resolve
    }),
    started = new Promise<void>((resolve) => {
      arrived = resolve
    })
  vi.spyOn(s.core.resources.git, 'run').mockImplementation(
    async (cwd, command, check, deadline) => {
      if (command.kind === 'worktree.remove') {
        arrived()
        await gate
      }
      return original(cwd, command, check, deadline)
    }
  )
  const first = s.request('repository.v1.worktree.delete', params, 'concurrent-delete')
  await started
  const second = s.request('repository.v1.worktree.delete', params, 'concurrent-delete')
  await new Promise((resolve) => setTimeout(resolve, 10))
  release()
  expect(await Promise.all([first, second])).toEqual([
    { worktree_id: target, state: 'deleted' },
    { worktree_id: target, state: 'deleted' },
  ])
})
it('rejects ignored files arriving after the clean scan but before the deletion baseline used at the effect', async () => {
  const s = await setup(),
    external = join(s.dir, 'external')
  git(s.folder, 'worktree', 'add', '-b', 'side', external)
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: true,
  })
  const target = (
    await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  ).entries.find((e: any) => e.kind === 'external').worktree_id
  const observed = (await s.request('repository.v1.observe', { worktree_id: target })).revision
  const original = s.core.resources.git.run.bind(s.core.resources.git)
  vi.spyOn(s.core.resources.git, 'run').mockImplementation(
    async (cwd, command, check, deadline) => {
      const result = await original(cwd, command, check, deadline)
      if (cwd === external && command.kind === 'untracked')
        writeFileSync(join(external, 'ignored'), 'valuable')
      return result
    }
  )
  await expect(
    s.request('repository.v1.worktree.delete', {
      worktree_id: target,
      expected_head: observed.head,
      expected_observation_id: observed.observation_id,
    })
  ).rejects.toThrow('stale_revision')
  expect(existsSync(join(external, 'ignored'))).toBe(true)
})
it('reserves an external deletion target against execution throughout validation and the asynchronous removal', async () => {
  const s = await setup(),
    external = join(s.dir, 'external')
  git(s.folder, 'worktree', 'add', '-b', 'side', external)
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: true,
  })
  await s.request('project.trust', { project_id: s.project.project_id, trust: 'trusted' })
  const worktree_id = (
    await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  ).entries.find((e: any) => e.kind === 'external').worktree_id
  const target = { kind: 'worktree', worktree_id }
  await s.request('project.execution', { project_id: s.project.project_id, target, enabled: true })
  const chat = await s.request('session.create', { provider: 'fake', target })
  await s.request('session.send', {
    session_id: chat.session_id,
    text: 'fixture',
    observed_seq: s.core.head(chat.session_id),
    script: [{ kind: 'hang' }],
  })
  const observed = (await s.request('repository.v1.observe', { worktree_id })).revision
  const original = s.core.resources.git.run.bind(s.core.resources.git),
    admissions: boolean[] = []
  vi.spyOn(s.core.resources.git, 'run').mockImplementation(
    async (cwd, command, check, deadline) => {
      if (
        (cwd === external && command.kind === 'untracked') ||
        command.kind === 'worktree.remove'
      ) {
        s.core.tick()
        admissions.push(s.core.read(chat.session_id, 0).some((e) => e.type === 'run.started'))
      }
      return original(cwd, command, check, deadline)
    }
  )
  expect(
    await s.request('repository.v1.worktree.delete', {
      worktree_id,
      expected_head: observed.head,
      expected_observation_id: observed.observation_id,
    })
  ).toEqual({ worktree_id, state: 'deleted' })
  expect(admissions).toEqual([false, false])
})
it('refuses deletion of a target with an already admitted execution lease', async () => {
  const s = await setup(),
    external = join(s.dir, 'external')
  git(s.folder, 'worktree', 'add', '-b', 'side', external)
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: true,
  })
  await s.request('project.trust', { project_id: s.project.project_id, trust: 'trusted' })
  const worktree_id = (
    await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  ).entries.find((e: any) => e.kind === 'external').worktree_id
  const target = { kind: 'worktree', worktree_id }
  await s.request('project.execution', { project_id: s.project.project_id, target, enabled: true })
  const chat = await s.request('session.create', { provider: 'fake', target })
  await s.request('session.send', {
    session_id: chat.session_id,
    text: 'fixture',
    observed_seq: s.core.head(chat.session_id),
    script: [{ kind: 'hang' }],
  })
  s.core.tick()
  const observed = (await s.request('repository.v1.observe', { worktree_id })).revision
  await expect(
    s.request('repository.v1.worktree.delete', {
      worktree_id,
      expected_head: observed.head,
      expected_observation_id: observed.observation_id,
    })
  ).rejects.toThrow('resource_busy')
  expect(existsSync(external)).toBe(true)
})
it('refuses valuable ignored files appearing after the asynchronous deletion checks', async () => {
  const s = await setup(),
    external = join(s.dir, 'external')
  git(s.folder, 'worktree', 'add', '-b', 'side', external)
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: true,
  })
  const target = (
    await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  ).entries.find((e: any) => e.kind === 'external').worktree_id
  const observed = (await s.request('repository.v1.observe', { worktree_id: target })).revision
  const original = s.core.resources.git.run.bind(s.core.resources.git)
  vi.spyOn(s.core.resources.git, 'run').mockImplementation((cwd, command, check, deadline) => {
    if (command.kind === 'worktree.remove') writeFileSync(join(external, 'ignored'), 'valuable')
    return original(cwd, command, check, deadline)
  })
  await expect(
    s.request('repository.v1.worktree.delete', {
      worktree_id: target,
      expected_head: observed.head,
      expected_observation_id: observed.observation_id,
    })
  ).rejects.toThrow('stale_revision')
  expect(existsSync(join(external, 'ignored'))).toBe(true)
})
