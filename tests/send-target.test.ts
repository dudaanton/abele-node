import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { NodeCore } from '../packages/node-core/src/index.js'
import { MemoryClientStore, NodeClient } from '../packages/node-client/src/index.js'

const dirs: string[] = [],
  cores: NodeCore[] = []
afterEach(async () => {
  for (const core of cores.splice(0)) {
    await core.execution.stop()
    await core.resources.stop()
    core.close()
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
async function setup(repository = false) {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/send-target-'))
  dirs.push(dir)
  const folder = join(dir, 'folder')
  mkdirSync(folder)
  if (repository) {
    const git = (...args: string[]) => {
      const r = spawnSync('/usr/bin/git', args, { cwd: folder, encoding: 'utf8' })
      if (r.status) throw new Error(r.stderr)
    }
    git('init', '-b', 'main')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    writeFileSync(join(folder, 'sample'), 'fixture')
    git('add', '.')
    git('commit', '-m', 'fixture')
    git('worktree', 'add', '-b', 'side', join(dir, 'side'))
  }
  let core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  const request = async (
    method: string,
    params: unknown,
    operation: string = crypto.randomUUID()
  ) => (await core.request(actor, method, params, operation)) as any
  const project = await request('project.register', { path: folder, trust: 'trusted' })
  let targets: any[]
  if (repository) {
    await request('project.repository_settings', {
      project_id: project.project_id,
      external_read: true,
    })
    targets = (
      await request('repository.v1.worktrees', { project_id: project.project_id })
    ).entries.map((e: any) => ({ kind: 'worktree', worktree_id: e.worktree_id }))
  } else {
    targets = (await request('workspace.list', { project_id: project.project_id })).map(
      (w: any) => ({ kind: 'workspace', workspace_id: w.workspace_id })
    )
  }
  for (const target of targets)
    await request('project.execution', { project_id: project.project_id, target, enabled: true })
  const chat = await request('session.create', { provider: 'fake', target: targets[0] })
  const displayed = async () => {
    const state = await request('session.worktree.get', {
      session_id: chat.session_id,
      include_incarnation: true,
    })
    expect(state.incarnation).toEqual(expect.any(String))
    return { target: state.target, incarnation: state.incarnation }
  }
  const send = (expected_target?: unknown, operation?: string) =>
    request(
      'session.send',
      {
        session_id: chat.session_id,
        text: 'only here',
        observed_seq: 0,
        ...(expected_target === undefined ? {} : { expected_target }),
      },
      operation
    )
  return {
    get core() {
      return core
    },
    request,
    targets,
    chat,
    displayed,
    send,
    async restart() {
      await core.execution.stop()
      await core.resources.stop()
      core.close()
      cores.splice(cores.indexOf(core), 1)
      core = new NodeCore(join(dir, 'state'))
      cores.push(core)
    },
  }
}
for (const repository of [false, true]) {
  it(`renames only the title and deletes idle ${repository ? 'worktree' : 'folder'} bindings without removing files`, async () => {
    const s = await setup(repository)
    const before = await s.displayed()
    const p = { session_id: s.chat.session_id }
    expect(await s.request('session.rename', { ...p, title: 'Display only' })).toEqual({
      ...s.chat,
      title: 'Display only',
    })
    expect(await s.displayed()).toEqual(before)
    await s.send(before)
    s.core.tick()
    expect(await s.request('session.delete', p, 'delete')).toEqual({ ...p, deleted: true })
    expect(s.core.resources.targets.bound(s.chat.session_id)).toBeUndefined()
    expect(
      s.core.db.prepare('SELECT 1 FROM workspace_leases WHERE session_id=?').get(s.chat.session_id)
    ).toBeUndefined()
    await s.restart()
    expect(await s.request('session.list', {})).toEqual([])
    expect(await s.request('session.delete', p, 'delete')).toEqual({ ...p, deleted: true })
    // The target still exists and can be bound to a fresh chat.
    expect(
      await s.request('session.create', { provider: 'fake', target: before.target })
    ).toMatchObject({ provider: 'fake' })
  })
  it(`admits matching ${repository ? 'worktree' : 'folder'} incarnations, preserving legacy sends`, async () => {
    const s = await setup(repository)
    const expected = await s.displayed()
    const receipt = await s.send(expected, 'guarded')
    expect(receipt).toMatchObject({
      input_id: expect.any(String),
      accepted_seq: expect.any(Number),
    })
    expect(await s.send(expected, 'guarded')).toEqual(receipt)
    expect(() =>
      s.core.request(
        s.core.authority.authenticate(s.core.createToken('retry').token),
        'session.send',
        {
          session_id: s.chat.session_id,
          text: 'bad',
          observed_seq: 0,
          expected_target: { target: expected.target },
        },
        'malformed'
      )
    ).toThrow('invalid_params')
    s.core.tick()
    await s.send()
    s.core.tick()
    expect(s.core.read(s.chat.session_id, 0).filter((e) => e.type === 'run.started')).toHaveLength(
      2
    )
  })
  it(`refuses a stale ${repository ? 'worktree' : 'folder'} incarnation without recording a turn and retains the refusal`, async () => {
    const s = await setup(repository)
    const current = await s.displayed()
    const stale = { ...current, incarnation: 'old-incarnation' }
    const head = s.core.head(s.chat.session_id)
    const refused = await s.send(stale, 'refused')
    expect(refused).toEqual({ code: 'target_changed', current_target: current })
    expect(s.core.head(s.chat.session_id)).toBe(head)
    expect(s.core.db.prepare('SELECT count(*) AS n FROM inputs').get()).toEqual({ n: 0 })
    await s.restart()
    expect(await s.displayed()).toEqual(current)
    expect(await s.send(stale, 'refused')).toEqual(refused)
    await expect(s.send(current, 'refused')).rejects.toThrow('idempotency_mismatch')
    s.core.tick()
    expect(s.core.read(s.chat.session_id, 0).some((e) => e.type === 'run.started')).toBe(false)
  })
}
it('refuses the check/send race, including switching back to the same id with a new incarnation', async () => {
  const s = await setup(true)
  const displayed = await s.displayed()
  await s.request('session.worktree.set', {
    session_id: s.chat.session_id,
    expected_target: displayed.target,
    target: s.targets[1],
  })
  const current = await s.displayed()
  expect(await s.send(displayed, 'race')).toEqual({
    code: 'target_changed',
    current_target: current,
  })
  s.core.tick()
  expect(s.core.read(s.chat.session_id, 0).some((e) => e.type === 'run.started')).toBe(false)
  await s.request('session.worktree.set', {
    session_id: s.chat.session_id,
    expected_target: current.target,
    target: displayed.target,
  })
  const rebound = await s.displayed()
  expect(rebound.incarnation).not.toBe(displayed.incarnation)
  expect(await s.send(displayed, 'aba')).toEqual({
    code: 'target_changed',
    current_target: rebound,
  })
  // A refusal is a durable receipt, not a second admission when the target changes again.
  expect(await s.send(displayed, 'race')).toEqual({
    code: 'target_changed',
    current_target: current,
  })
  await s.request('session.detach', { session_id: s.chat.session_id })
  expect(await s.send(rebound)).toEqual({ code: 'target_changed', current_target: null })
  expect(s.core.db.prepare('SELECT count(*) AS n FROM inputs').get()).toEqual({ n: 0 })
})
it('never dispatches a guarded queued turn into an agent-switched target', async () => {
  const s = await setup(true)
  const expected = await s.displayed()
  const receipt = await s.send(expected)
  const binding = s.core.resources.targets.bound(s.chat.session_id)!
  await s.core.resources.targets.schedule(
    s.core.authority.authenticate(s.core.createToken('agent').token),
    s.chat.session_id,
    'active-run',
    binding.generation,
    s.targets[1],
    () => true
  )
  s.core.transaction(() => s.core.resources.targets.settle(s.chat.session_id, 'active-run'))
  s.core.tick()
  expect(
    s.core.db.prepare('SELECT state FROM inputs WHERE input_id=?').get(receipt.input_id)
  ).toEqual({ state: 'cancelled' })
  expect(s.core.read(s.chat.session_id, 0).some((e) => e.type === 'run.started')).toBe(false)
})
it('rolls back admission and its receipt together on storage failure', async () => {
  const s = await setup()
  const expected = await s.displayed()
  const head = s.core.head(s.chat.session_id)
  s.core.db.exec(
    "CREATE TRIGGER fail_receipt BEFORE INSERT ON operations BEGIN SELECT RAISE(ABORT, 'fixture_failure'); END"
  )
  await expect(s.send(expected, 'atomic')).rejects.toThrow()
  expect(s.core.head(s.chat.session_id)).toBe(head)
  expect(s.core.db.prepare('SELECT count(*) AS n FROM inputs').get()).toEqual({ n: 0 })
  s.core.db.exec('DROP TRIGGER fail_receipt')
  // Audit-storage failures intentionally fence further admission until restart.
  await expect(s.send(expected, 'atomic')).rejects.toThrow('storage_unavailable')
  await s.restart()
  expect(await s.send(expected, 'atomic')).toHaveProperty('input_id')
})
it('retains the original precondition across offline reload and operation retries', async () => {
  const store = new MemoryClientStore()
  await store.transaction((s) => {
    s.node_id = 'fixture'
  })
  const target = {
    url: 'ws://127.0.0.1:7777/channel',
    profile: 'local-token-v1' as const,
    token: 'a'.repeat(64),
  }
  const expected = {
    target: { kind: 'worktree' as const, worktree_id: 'one' },
    incarnation: 'first',
  }
  const client = new NodeClient(target, store)
  await client.send('s', 'draft', 0, undefined, expected, 'retained')
  const reloaded = new NodeClient(target, store)
  expect(await reloaded.pending()).toMatchObject([
    { operation_id: 'retained', params: { expected_target: expected } },
  ])
  await reloaded.send('s', 'draft', 0, undefined, expected, 'retained')
  expect(await reloaded.pending()).toHaveLength(1)
  await expect(
    reloaded.send('s', 'draft', 0, undefined, { ...expected, incarnation: 'second' }, 'retained')
  ).rejects.toThrow('idempotency_mismatch')
  await expect(reloaded.send('s', 'draft', 0, undefined, undefined, 'retained')).rejects.toThrow(
    'idempotency_mismatch'
  )
})
