import { afterEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, rmdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { ChannelError } from '@abele/channel-protocol'
import { NodeCore } from '../packages/node-core/src/index.js'
import { humanOutput } from '../packages/node-daemon/src/output.js'
const dirs: string[] = [],
  cores: NodeCore[] = []
async function setup() {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/deletion-finalization-'))
  dirs.push(dir)
  const folder = join(dir, 'folder'),
    external = join(dir, 'external')
  mkdirSync(folder)
  const git = (...args: string[]) => {
    const p = spawnSync('/usr/bin/git', args, { cwd: folder, encoding: 'utf8' })
    if (p.status) throw new Error(p.stderr)
  }
  git('init', '-b', 'trunk')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(folder, 'source'), 'contents')
  git('add', '.')
  git('commit', '-m', 'initial')
  git('worktree', 'add', '-b', 'side', external)
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  await core.resources.ready
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let op = 0
  const request = async (method: string, params: unknown, operation?: string) =>
    (await core.request(actor, method, params, operation ?? 'fixture-' + ++op)) as any
  const project = await request('project.register', { path: folder, trust: 'untrusted' })
  await request('project.repository_settings', {
    project_id: project.project_id,
    external_read: true,
  })
  const worktree_id = (
    await request('repository.v1.worktrees', { project_id: project.project_id })
  ).entries.find((e: any) => e.kind === 'external').worktree_id
  const observed = (await request('repository.v1.observe', { worktree_id })).revision
  const params = {
    worktree_id,
    expected_head: observed.head,
    expected_observation_id: observed.observation_id,
  }
  return { core, actor, request, project, external, params }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of cores.splice(0)) {
    await c.resources.stop()
    c.close()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
it('awaits target inspection and retains the fence after a settled removal exhausts its inspection budget', async () => {
  const s = await setup(),
    now = Date.now.bind(Date)
  let offset = 0,
    release!: () => void,
    arrived!: () => void
  const gate = new Promise<void>((resolve) => {
      release = resolve
    }),
    inspecting = new Promise<void>((resolve) => {
      arrived = resolve
    })
  vi.spyOn(Date, 'now').mockImplementation(() => now() + offset)
  const available = s.core.resources.projects.available.bind(s.core.resources.projects)
  vi.spyOn(s.core.resources.projects, 'available').mockImplementation(async (project) => {
    if (offset) {
      arrived()
      await gate
    }
    return available(project)
  })
  const run = s.core.resources.git.run.bind(s.core.resources.git)
  vi.spyOn(s.core.resources.git, 'run').mockImplementation(async (...args) => {
    const result = await run(...args)
    if (args[1].kind === 'worktree.remove') {
      offset = 20000
      throw new ChannelError('git_timeout')
    }
    return result
  })
  const deleting = s.request('repository.v1.worktree.delete', s.params, 'expired-delete')
  await inspecting
  const during = s.core.db.prepare('SELECT count(*) AS n FROM execution_target_reservations').get()
  release()
  const result = await deleting
  offset = 0
  expect(during).toEqual({ n: 1 })
  expect(result).toMatchObject({
    state: 'outcome_unknown',
    reason: 'target_unconfirmed',
    reconciliation: 'unresolved',
  })
  expect(
    s.core.db.prepare('SELECT count(*) AS n FROM execution_target_reservations').get()
  ).toEqual({ n: 1 })
  expect(s.core.db.prepare('SELECT count(*) AS n FROM repository_deletions').get()).toEqual({
    n: 1,
  })
  expect(existsSync(s.external)).toBe(false)
  await expect(s.request('project.remove', { project_id: s.project.project_id })).rejects.toThrow(
    'resource_busy'
  )
  await expect(
    s.request('project.trust', { project_id: s.project.project_id, trust: 'trusted' })
  ).rejects.toThrow('resource_busy')
  const unresolved = await s.core.resources.repository.recoverDeletions(
    'expired-delete',
    s.actor.installation_id
  )
  expect(unresolved[0]).toMatchObject({ state: 'deleted', reconciliation: 'applied_as_observed' })
  expect(
    s.core.db.prepare('SELECT count(*) AS n FROM execution_target_reservations').get()
  ).toEqual({ n: 0 })
  expect(
    humanOutput(
      ['recover-worktree-deletion'],
      [{ operation_id: 'expired-delete', installation_id: s.actor.installation_id, ...result }]
    )
  ).toContain('Reservation retained')
  expect(humanOutput(['recover-worktree-deletion'], unresolved)).not.toContain(
    'Reservation retained'
  )
  expect(humanOutput(['recover-worktree-deletion'], unresolved)).toContain(
    'Observed without replaying removal'
  )
})
it('does not tell the owner an unresolved legacy receipt retained a fence when none is present', () => {
  const message = humanOutput(
    ['recover-worktree-deletion'],
    [
      {
        operation_id: 'legacy',
        installation_id: 'fixture',
        state: 'outcome_unknown',
        reconciliation: 'unresolved',
        reason: 'target_unconfirmed',
        reservation_retained: false,
      },
    ]
  )
  expect(message).not.toContain('Reservation retained')
  expect(message).toContain('No reservation confirmed')
})
it('does not replace a terminal target observation with a successful process exit', async () => {
  const s = await setup()
  // The original target is gone, but its path has been occupied before receipt commit.
  s.core.resources.repository.deleteFault = () => mkdirSync(s.external)
  const result = await s.request('repository.v1.worktree.delete', s.params, 'inconsistent-delete')
  expect(result).toMatchObject({ state: 'outcome_unknown', reason: 'target_unconfirmed' })
  expect(
    s.core.db.prepare('SELECT count(*) AS n FROM execution_target_reservations').get()
  ).toEqual({ n: 1 })
  await expect(s.request('project.remove', { project_id: s.project.project_id })).rejects.toThrow(
    'resource_busy'
  )
  const recovery = await s.core.resources.repository.recoverDeletions(
    'inconsistent-delete',
    s.actor.installation_id
  )
  expect(recovery[0]).toMatchObject({ state: 'outcome_unknown', reason: 'target_unconfirmed' })
  expect(humanOutput(['recover-worktree-deletion'], recovery)).toContain('Reservation retained')
  rmdirSync(s.external)
  const terminal = await s.core.resources.repository.recoverDeletions(
    'inconsistent-delete',
    s.actor.installation_id
  )
  expect(terminal[0]).toMatchObject({ state: 'deleted', reconciliation: 'applied_as_observed' })
  expect(
    s.core.db.prepare('SELECT count(*) AS n FROM execution_target_reservations').get()
  ).toEqual({ n: 0 })
})
