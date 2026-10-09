import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NodeCore, ClaudeProviderAdapter, PiProviderAdapter } from '@abele/node-core'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const f of cleanup.splice(0).reverse()) await f()
})
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'abele-delegation-lease-')),
    repo = join(dir, 'repo'),
    state = join(dir, 'state')
  mkdirSync(repo)
  const git = (...args: string[]) => {
    const r = spawnSync('/usr/bin/git', args, { cwd: repo, encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
  }
  git('init', '-b', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(repo, 'file.txt'), 'fixture')
  git('add', '.')
  git('commit', '-m', 'fixture')
  const claude = new ClaudeProviderAdapter(),
    pi = new PiProviderAdapter({ stateDir: state, profile: 'isolated' })
  let core = new NodeCore(state, { claude, pi })
  cleanup.push(async () => {
    await core.execution.stop()
    await core.resources.stop()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const actor = core.authority.authenticate(core.createToken('owner').token)
  const request = (method: string, p: unknown) =>
    core.request(actor, method, p, crypto.randomUUID()) as any
  const project = await request('project.register', { path: repo, trust: 'trusted' })
  const grant = request('delegation.grant.create', {
    parent_id: 'parent',
    project_ids: [project.project_id],
    allow_fake: true,
  })
  const create = (provider: 'fake' | 'claude' | 'pi' = 'fake') =>
    request('delegation.create', {
      grant_id: grant.grant_id,
      delegation_key: crypto.randomUUID(),
      project_id: project.project_id,
      provider,
      title: 'child',
      text: 'echo',
    })
  return {
    get core() {
      return core
    },
    request,
    create,
    claude,
    pi,
    restart() {
      core.close()
      core = new NodeCore(state, { claude, pi })
    },
  }
}
it('leases the workspace atomically with child creation and retains it through readiness and provisioning cancellation', async () => {
  const f = await fixture(),
    child = await f.create()
  expect(f.core.resources.workspaces.leased(child.workspace_id)).toBe(true)
  await f.core.resources.jobs.drain()
  // Readiness has committed, but delegation settle has not run yet.
  expect(() =>
    f.request('session.create', { title: 'intruder', workspace_id: child.workspace_id })
  ).toThrow(/resource_busy/)
  expect(() => f.core.tick()).not.toThrow()
  const cancelled = await f.create()
  f.request('delegation.cancel', { delegation_id: cancelled.delegation_id })
  await f.core.resources.jobs.drain()
  f.restart()
  expect(f.core.resources.workspaces.leased(cancelled.workspace_id)).toBe(true)
  expect(() =>
    f.request('session.create', { title: 'intruder', workspace_id: cancelled.workspace_id })
  ).toThrow(/resource_busy/)
  f.request('session.send', { session_id: cancelled.session_id, text: 'human', observed_seq: 0 })
  f.core.tick()
  expect(f.core.read(cancelled.session_id, 0).some((e) => e.type === 'run.completed')).toBe(true)
  expect(
    f.core.read(cancelled.mailbox_stream_id, 0).filter((e) => e.type === 'delegation.terminal')
  ).toHaveLength(1)
})
it('repairs legacy unleased retained children but never steals a conflicting lease or stalls unrelated work', async () => {
  const f = await fixture(),
    legacy = await f.create(),
    conflict = await f.create()
  await f.core.resources.jobs.drain()
  f.core.db
    .prepare('DELETE FROM workspace_leases WHERE session_id IN (?,?)')
    .run(legacy.session_id, conflict.session_id)
  const other = f.request('session.create', {
    title: 'existing lease',
    workspace_id: conflict.workspace_id,
  })
  f.restart()
  expect(f.core.resources.workspaces.leased(legacy.workspace_id)).toBe(true)
  const owned = f.core.db
    .prepare('SELECT session_id FROM workspace_leases WHERE workspace_id=?')
    .get(conflict.workspace_id) as any
  expect(owned.session_id).toBe(other.session_id)
  f.request('session.send', { session_id: other.session_id, text: 'unrelated', observed_seq: 0 })
  expect(() => f.core.tick()).not.toThrow()
  expect(f.core.read(other.session_id, 0).some((e) => e.type === 'run.completed')).toBe(true)
  expect(f.core.read(conflict.session_id, 0).some((e) => e.type === 'run.started')).toBe(false)
  expect(() =>
    f.request('session.send', { session_id: conflict.session_id, text: 'unsafe', observed_seq: 0 })
  ).toThrow(/resource_busy/)
})
for (const provider of ['claude', 'pi'] as const)
  it(`checks lease ownership again after asynchronous workspace validation before fake ${provider} dispatch`, async () => {
    const f = await fixture(),
      child = await f.create(provider)
    await f.core.resources.jobs.drain()
    f.core.tick()
    const adapter = provider === 'pi' ? f.pi : f.claude
    const start = vi.spyOn(adapter, 'startTurn')
    const other = f.request('session.create', { title: 'other' })
    const bound = f.core.resources.workspaces.bound.bind(f.core.resources.workspaces)
    vi.spyOn(f.core.resources.workspaces, 'bound').mockImplementation(async (workspace) => {
      const project = await bound(workspace)
      f.core.db
        .prepare('UPDATE workspace_leases SET session_id=? WHERE workspace_id=?')
        .run(other.session_id, workspace.workspace_id)
      return project
    })
    await f.core.execution.drain()
    expect(start).not.toHaveBeenCalled()
    expect(f.core.read(child.session_id, 0).some((e) => e.type === 'run.started')).toBe(false)
    expect(() =>
      f.request('session.send', { session_id: child.session_id, text: 'unsafe', observed_seq: 0 })
    ).toThrow(/resource_busy/)
  })
