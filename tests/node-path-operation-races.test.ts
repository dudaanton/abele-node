import { afterEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
const dirs: string[] = [],
  cores: NodeCore[] = []
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
async function setup(repository = false) {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/operation-races-'))
  dirs.push(dir)
  const folder = join(dir, 'folder')
  mkdirSync(folder)
  const git = (...args: string[]) => {
    const p = spawnSync('/usr/bin/git', args, { cwd: folder, encoding: 'utf8' })
    if (p.status) throw new Error(p.stderr)
  }
  writeFileSync(join(folder, 'source'), 'contents')
  if (repository) {
    git('init', '-b', 'trunk')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    git('add', '.')
    git('commit', '-m', 'initial')
  }
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let op = 0
  const request = async (method: string, params: unknown, operation?: string) =>
    (await core.request(actor, method, params, operation ?? 'fixture-' + ++op)) as any
  const project = await request('project.register', { path: folder, trust: 'untrusted' })
  const workspace_id = (await request('workspace.list', { project_id: project.project_id }))[0]
    .workspace_id
  return { dir, folder, git, core, actor, request, project, workspace_id }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of cores.splice(0)) {
    await c.resources.stop()
    c.close()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
it('atomically fences a file operation paused in preparation when another coordinator commits its operation ID', async () => {
  const s = await setup(true)
  const worktree_id = (
    await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  ).entries[0].worktree_id
  const params = { worktree_id, from: 'source', to: 'copy', expected_content_id: hash('contents') }
  const original = s.core.resources.repository.prepareEdit.bind(s.core.resources.repository)
  let release!: () => void, arrived!: () => void
  const gate = new Promise<void>((resolve) => {
      release = resolve
    }),
    started = new Promise<void>((resolve) => {
      arrived = resolve
    })
  vi.spyOn(s.core.resources.repository, 'prepareEdit').mockImplementation(async (...args) => {
    arrived()
    await gate
    return original(...args)
  })
  const copying = s.request('repository.v1.file.copy', params, 'shared-id')
  await started
  const committed = await s.request('session.create', { title: 'occupied' }, 'shared-id')
  release()
  await expect(copying).rejects.toThrow('idempotency_mismatch')
  expect(existsSync(join(s.folder, 'copy'))).toBe(false)
  expect(s.core.db.prepare('SELECT count(*) AS n FROM file_mutations').get()).toEqual({ n: 0 })
  expect(() => s.core.assertAuditStorageAvailable()).not.toThrow()
  await s.core.resources.stop()
  s.core.close()
  cores.splice(cores.indexOf(s.core), 1)
  const reopened = new NodeCore(join(s.dir, 'state'))
  cores.push(reopened)
  expect(
    await reopened.request(s.actor, 'session.create', { title: 'occupied' }, 'shared-id')
  ).toEqual(committed)
  await expect(
    Promise.resolve().then(() =>
      reopened.request(s.actor, 'repository.v1.file.copy', params, 'shared-id')
    )
  ).rejects.toThrow('idempotency_mismatch')
})
it('atomically fences existing writes when an operation ID is committed at the final file check', async () => {
  const s = await setup()
  s.core.resources.mutations.fault = (point) => {
    if (point === 'before_check')
      s.core.request(s.actor, 'session.create', { title: 'occupied' }, 'shared-id')
  }
  await expect(
    s.request(
      'workspace.write',
      {
        workspace_id: s.workspace_id,
        path: 'source',
        expected_content_id: hash('contents'),
        text: 'wrong effect',
      },
      'shared-id'
    )
  ).rejects.toThrow('idempotency_mismatch')
  expect(readFileSync(join(s.folder, 'source'), 'utf8')).toBe('contents')
  expect(s.core.db.prepare('SELECT count(*) AS n FROM file_mutations').get()).toEqual({ n: 0 })
  expect(() => s.core.assertAuditStorageAvailable()).not.toThrow()
})
it('atomically reserves git-init IDs after asynchronous inspection and before Git effects', async () => {
  const s = await setup(),
    original = s.core.resources.git.text.bind(s.core.resources.git)
  vi.spyOn(s.core.resources.git, 'text').mockImplementation(async (cwd, command) => {
    try {
      return await original(cwd, command)
    } catch (e) {
      if (command.kind === 'root')
        await s.request('session.create', { title: 'occupied' }, 'shared-id')
      throw e
    }
  })
  await expect(
    s.request(
      'project.git_init',
      { project_id: s.project.project_id, initial_branch: 'trunk' },
      'shared-id'
    )
  ).rejects.toThrow('idempotency_mismatch')
  expect(existsSync(join(s.folder, '.git'))).toBe(false)
  expect(s.core.db.prepare('SELECT count(*) AS n FROM node_path_effects').get()).toEqual({ n: 0 })
})
it('atomically reserves deletion IDs after asynchronous checks and before removing a target', async () => {
  const s = await setup(true),
    external = join(s.dir, 'external')
  s.git('worktree', 'add', '-b', 'side', external)
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: true,
  })
  const worktree_id = (
    await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  ).entries.find((e: any) => e.kind === 'external').worktree_id
  const observed = (await s.request('repository.v1.observe', { worktree_id })).revision
  const original = s.core.resources.git.run.bind(s.core.resources.git)
  vi.spyOn(s.core.resources.git, 'run').mockImplementation(
    async (cwd, command, check, deadline) => {
      const result = await original(cwd, command, check, deadline)
      if (cwd === external && command.kind === 'untracked')
        await s.request('session.create', { title: 'occupied' }, 'shared-id')
      return result
    }
  )
  await expect(
    s.request(
      'repository.v1.worktree.delete',
      {
        worktree_id,
        expected_head: observed.head,
        expected_observation_id: observed.observation_id,
      },
      'shared-id'
    )
  ).rejects.toThrow('idempotency_mismatch')
  expect(existsSync(external)).toBe(true)
  expect(s.core.db.prepare('SELECT count(*) AS n FROM repository_deletions').get()).toEqual({
    n: 0,
  })
})
