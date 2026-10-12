import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { NodeCore } from '../packages/node-core/src/index.js'
import type { ProviderAdapter } from '../packages/node-core/src/providers.js'
import type { TurnContext, ProviderEventSink } from '@abele/provider-contract'
const dirs: string[] = [],
  cores: NodeCore[] = []
interface Turn {
  context: TurnContext
  sink: ProviderEventSink
  complete: (reason?: string) => void
}
function adapter() {
  const turns: Turn[] = []
  const fake: ProviderAdapter = {
    available: true,
    configuration: {},
    capabilities: () => ({ provider: 'claude', capabilities: {} }),
    configurationForTurn: () => ({}),
    reconcile: async () => {},
    startTurn: async (context, sink) => {
      let complete!: Turn['complete']
      const done = new Promise<any>((resolve) => {
        complete = (reason) =>
          resolve(reason ? { reason } : { result: { subtype: 'success', is_error: false } })
      })
      turns.push({ context, sink, complete })
      return {
        done,
        interrupt: async () => {
          complete()
        },
      }
    },
  }
  return { fake, turns }
}
async function setup(gitRepository = false) {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/node-path-execution-'))
  dirs.push(dir)
  const folder = join(dir, 'folder')
  mkdirSync(folder)
  const git = (...args: string[]) => {
    const p = spawnSync('/usr/bin/git', args, { cwd: folder, encoding: 'utf8' })
    if (p.status) throw new Error(p.stderr)
  }
  if (gitRepository) {
    git('init', '-b', 'trunk')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    writeFileSync(join(folder, 'sample'), 'initial')
    git('add', '.')
    git('commit', '-m', 'initial')
  }
  const provider = adapter(),
    core = new NodeCore(join(dir, 'state'), { claude: provider.fake })
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let op = 0
  const request = async (method: string, params: unknown, operation?: string) =>
    (await core.request(actor, method, params, operation ?? 'fixture-' + ++op)) as any
  const project = await request('project.register', {
    path: folder,
    trust: 'untrusted',
    exact_root: true,
  })
  const root = gitRepository
    ? (await request('repository.v1.worktrees', { project_id: project.project_id })).entries[0]
    : (await request('workspace.list', { project_id: project.project_id }))[0]
  const target = gitRepository
    ? { kind: 'worktree', worktree_id: root.worktree_id }
    : { kind: 'workspace', workspace_id: root.workspace_id }
  return { dir, folder, git, provider, core, actor, request, project, target }
}
afterEach(async () => {
  for (const c of cores.splice(0)) {
    await c.execution.stop()
    await c.resources.stop()
    c.close()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
for (const repository of [false, true])
  it(`runs approved ${repository ? 'Git root' : 'plain folder'} chats at the actual root with execution-time exclusive leases`, async () => {
    const s = await setup(repository)
    await expect(
      s.request('session.create', { provider: 'claude', target: s.target })
    ).rejects.toThrow('project_untrusted')
    await s.request('project.trust', { project_id: s.project.project_id, trust: 'trusted' })
    await expect(
      s.request('session.create', { provider: 'claude', target: s.target })
    ).rejects.toThrow('unauthorized')
    await s.request('project.execution', {
      project_id: s.project.project_id,
      target: s.target,
      enabled: true,
    })
    const one = await s.request('session.create', {
      provider: 'claude',
      title: 'one',
      target: s.target,
    })
    const two = await s.request('session.create', {
      provider: 'claude',
      title: 'two',
      target: s.target,
    })
    expect(await s.request('session.worktree.get', { session_id: one.session_id })).toEqual({
      project_id: s.project.project_id,
      target: s.target,
    })
    for (const chat of [one, two])
      await s.request('session.send', {
        session_id: chat.session_id,
        text: 'fixture',
        observed_seq: s.core.head(chat.session_id),
      })
    await s.core.execution.drain()
    expect(s.provider.turns).toHaveLength(1)
    expect(s.provider.turns[0]!.context.cwd).toBe(s.folder)
    await expect(
      s.request('project.trust', { project_id: s.project.project_id, trust: 'untrusted' })
    ).rejects.toThrow('resource_busy')
    await expect(
      s.request('project.execution', {
        project_id: s.project.project_id,
        target: s.target,
        enabled: false,
      })
    ).rejects.toThrow('resource_busy')
    s.provider.turns[0]!.complete()
    await expect
      .poll(() => s.core.db.prepare('SELECT count(*) AS n FROM execution_target_leases').get())
      .toEqual({ n: 0 })
    await s.core.execution.drain()
    expect(s.provider.turns).toHaveLength(2)
    expect(s.provider.turns[1]!.context.cwd).toBe(s.folder)
    s.provider.turns[1]!.complete()
  })
it('schedules a run-bound agent switch inside one project only after cleanup and uses the new cwd next turn', async () => {
  const s = await setup(true),
    external = join(s.dir, 'external')
  s.git('worktree', 'add', '-b', 'side', external)
  await s.request('project.trust', { project_id: s.project.project_id, trust: 'trusted' })
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: true,
  })
  const entry = (
    await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  ).entries.find((e: any) => e.kind === 'external')
  const destination = { kind: 'worktree', worktree_id: entry.worktree_id }
  for (const target of [s.target, destination])
    await s.request('project.execution', {
      project_id: s.project.project_id,
      target,
      enabled: true,
    })
  const chat = await s.request('session.create', { provider: 'claude', target: s.target })
  await s.request('session.send', {
    session_id: chat.session_id,
    text: 'fixture',
    observed_seq: s.core.head(chat.session_id),
  })
  await s.core.execution.drain()
  const run = s.provider.turns[0]!,
    tools = run.sink.debugger!
  expect(tools.tools.some((t) => t.name === 'node_worktree_switch')).toBe(true)
  await expect(
    s.request('session.worktree.set', {
      session_id: chat.session_id,
      expected_target: s.target,
      target: destination,
    })
  ).rejects.toThrow('resource_busy')
  await expect(
    tools.call('node_worktree_switch', { target: destination, session_id: 'spoof' })
  ).rejects.toThrow('invalid_params')
  expect(await tools.call('node_worktree_switch', { target: destination })).toEqual({
    state: 'pending',
    target: destination,
  })
  expect((await s.request('session.worktree.get', { session_id: chat.session_id })).target).toEqual(
    s.target
  )
  expect(
    s.core.read(chat.session_id, 0).filter((e) => e.type === 'session.worktree.changed')
  ).toHaveLength(0)
  run.complete()
  await expect
    .poll(
      async () => (await s.request('session.worktree.get', { session_id: chat.session_id })).target
    )
    .toEqual(destination)
  await expect(tools.call('node_worktree_switch', { target: s.target })).rejects.toThrow(
    'stale_run'
  )
  const events = s.core
    .read(chat.session_id, 0)
    .filter((e) => e.type === 'session.worktree.changed')
  expect(events).toHaveLength(1)
  expect(events[0]!.data).toMatchObject({ from: s.target, to: destination, by: 'agent' })
  await s.request('session.send', {
    session_id: chat.session_id,
    text: 'after switch',
    observed_seq: s.core.head(chat.session_id),
  })
  await s.core.execution.drain()
  expect(s.provider.turns[1]!.context.cwd).toBe(external)
  s.provider.turns[1]!.complete()
})
it('refuses a send after the displayed worktree was switched, without ever starting the provider', async () => {
  const s = await setup(true)
  s.git('worktree', 'add', '-b', 'side', join(s.dir, 'external'))
  await s.request('project.trust', { project_id: s.project.project_id, trust: 'trusted' })
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: true,
  })
  const destination = {
    kind: 'worktree',
    worktree_id: (
      await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
    ).entries.find((e: any) => e.kind === 'external').worktree_id,
  }
  for (const target of [s.target, destination])
    await s.request('project.execution', {
      project_id: s.project.project_id,
      target,
      enabled: true,
    })
  const chat = await s.request('session.create', { provider: 'claude', target: s.target })
  const displayed = await s.request('session.worktree.get', {
    session_id: chat.session_id,
    include_incarnation: true,
  })
  const expected_target = { target: displayed.target, incarnation: displayed.incarnation }
  await s.request('session.worktree.set', {
    session_id: chat.session_id,
    expected_target: displayed.target,
    target: destination,
  })
  const current = await s.request('session.worktree.get', {
    session_id: chat.session_id,
    include_incarnation: true,
  })
  expect(
    await s.request('session.send', {
      session_id: chat.session_id,
      text: 'only in the displayed target',
      observed_seq: 0,
      expected_target,
    })
  ).toEqual({
    code: 'target_changed',
    current_target: { target: current.target, incarnation: current.incarnation },
  })
  await s.core.execution.drain()
  expect(s.provider.turns).toHaveLength(0)
  expect(s.core.db.prepare('SELECT count(*) AS n FROM inputs').get()).toEqual({ n: 0 })
})
it('owner switching is expected-target guarded and refuses unsupported native continuation visibly', async () => {
  const s = await setup(true),
    external = join(s.dir, 'external')
  s.git('worktree', 'add', '-b', 'side', external)
  await s.request('project.trust', { project_id: s.project.project_id, trust: 'trusted' })
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: true,
  })
  const destination = {
    kind: 'worktree',
    worktree_id: (
      await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
    ).entries.find((e: any) => e.kind === 'external').worktree_id,
  }
  for (const target of [s.target, destination])
    await s.request('project.execution', {
      project_id: s.project.project_id,
      target,
      enabled: true,
    })
  const chat = await s.request('session.create', { provider: 'claude', target: s.target })
  await expect(
    s.request('session.worktree.set', {
      session_id: chat.session_id,
      expected_target: destination,
      target: destination,
    })
  ).rejects.toThrow('stale_revision')
  const params = { session_id: chat.session_id, expected_target: s.target, target: destination }
  expect(await s.request('session.worktree.set', params, 'switch-one')).toEqual({
    session_id: chat.session_id,
    target: destination,
  })
  expect(await s.request('session.worktree.set', params, 'switch-one')).toEqual({
    session_id: chat.session_id,
    target: destination,
  })
  expect(
    s.core.read(chat.session_id, 0).filter((e) => e.type === 'session.worktree.changed')
  ).toHaveLength(1)
  s.core.db
    .prepare('UPDATE sessions SET body=? WHERE session_id=?')
    .run(
      JSON.stringify({ ...chat, native_session_id: '11111111-1111-4111-8111-111111111111' }),
      chat.session_id
    )
  await expect(
    s.request('session.worktree.set', {
      session_id: chat.session_id,
      expected_target: destination,
      target: s.target,
    })
  ).rejects.toThrow('provider_target_continuation_unsupported')
})
it('serializes fake-provider target runs and releases their leases on interruption', async () => {
  const s = await setup()
  await s.request('project.trust', { project_id: s.project.project_id, trust: 'trusted' })
  await s.request('project.execution', {
    project_id: s.project.project_id,
    target: s.target,
    enabled: true,
  })
  const chats = await Promise.all(
    [1, 2].map(() => s.request('session.create', { provider: 'fake', target: s.target }))
  )
  for (const chat of chats)
    await s.request('session.send', {
      session_id: chat.session_id,
      observed_seq: s.core.head(chat.session_id),
      text: 'fixture',
      script: [{ kind: 'hang' }],
    })
  s.core.tick()
  expect(s.core.db.prepare('SELECT count(*) AS n FROM execution_target_leases').get()).toEqual({
    n: 1,
  })
  const run = s.core.read(chats[0].session_id, 0).find((e) => e.type === 'run.started')!.data as {
    run_id: string
  }
  await s.request('session.interrupt', { session_id: chats[0].session_id, run_id: run.run_id })
  expect(s.core.db.prepare('SELECT count(*) AS n FROM execution_target_leases').get()).toEqual({
    n: 0,
  })
  s.core.tick()
  expect(s.core.read(chats[1].session_id, 0).some((e) => e.type === 'run.started')).toBe(true)
})
it('does not release a target lease when worker cleanup is unconfirmed', async () => {
  const s = await setup()
  await s.request('project.trust', { project_id: s.project.project_id, trust: 'trusted' })
  await s.request('project.execution', {
    project_id: s.project.project_id,
    target: s.target,
    enabled: true,
  })
  const chat = await s.request('session.create', { provider: 'claude', target: s.target })
  await s.request('session.send', {
    session_id: chat.session_id,
    text: 'fixture',
    observed_seq: s.core.head(chat.session_id),
  })
  await s.core.execution.drain()
  s.provider.turns[0]!.complete('process_cleanup_unconfirmed')
  await expect
    .poll(() => s.core.read(chat.session_id, 0).some((e) => e.type === 'run.interrupted'))
    .toBe(true)
  expect(s.core.db.prepare('SELECT count(*) AS n FROM execution_target_leases').get()).toEqual({
    n: 1,
  })
  await expect(s.request('project.remove', { project_id: s.project.project_id })).rejects.toThrow(
    'resource_busy'
  )
  await expect(
    s.request('project.trust', { project_id: s.project.project_id, trust: 'untrusted' })
  ).rejects.toThrow('resource_busy')
})
it('does not treat attachment/edit access as execution approval and refuses cross-project switching', async () => {
  const s = await setup(true),
    external = join(s.dir, 'external')
  s.git('worktree', 'add', '-b', 'side', external)
  await s.request('project.trust', { project_id: s.project.project_id, trust: 'trusted' })
  await s.request('project.execution', {
    project_id: s.project.project_id,
    target: s.target,
    enabled: true,
  })
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: true,
  })
  const entry = (
    await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  ).entries.find((e: any) => e.kind === 'external')
  const destination = { kind: 'worktree', worktree_id: entry.worktree_id }
  await s.request('project.worktree_selection', {
    project_id: s.project.project_id,
    worktree_id: entry.worktree_id,
    listed: true,
  })
  await s.request('repository.v1.editing', { worktree_id: entry.worktree_id, enabled: true })
  await expect(
    s.request('session.create', { provider: 'claude', target: destination })
  ).rejects.toThrow('unauthorized')
  const chat = await s.request('session.create', { provider: 'claude', target: s.target })
  await expect(
    s.request('session.worktree.set', {
      session_id: chat.session_id,
      expected_target: s.target,
      target: destination,
    })
  ).rejects.toThrow('unauthorized')
  const otherFolder = join(s.dir, 'other')
  mkdirSync(otherFolder)
  const otherProject = await s.request('project.register', { path: otherFolder, trust: 'trusted' })
  const otherTarget = {
    kind: 'workspace',
    workspace_id: (await s.request('workspace.list', { project_id: otherProject.project_id }))[0]
      .workspace_id,
  }
  await s.request('project.execution', {
    project_id: otherProject.project_id,
    target: otherTarget,
    enabled: true,
  })
  await expect(
    s.request('session.worktree.set', {
      session_id: chat.session_id,
      expected_target: s.target,
      target: otherTarget,
    })
  ).rejects.toThrow('unauthorized')
})
it('maps legacy managed sessions without letting new execution-time leases bypass their lifetime lease', async () => {
  const s = await setup(true)
  const created = await s.request('workspace.create', { project_id: s.project.project_id })
  await s.core.resources.jobs.drain()
  await s.request('project.trust', { project_id: s.project.project_id, trust: 'trusted' })
  const legacy = await s.request('session.create', {
    provider: 'fake',
    workspace_id: created.workspace_id,
  })
  const state = await s.request('session.worktree.get', { session_id: legacy.session_id })
  await s.request('project.execution', {
    project_id: s.project.project_id,
    target: state.target,
    enabled: true,
  })
  const modern = await s.request('session.create', { provider: 'claude', target: state.target })
  await s.request('session.send', {
    session_id: modern.session_id,
    text: 'fixture',
    observed_seq: s.core.head(modern.session_id),
  })
  await s.core.execution.drain()
  expect(s.provider.turns).toHaveLength(0)
  await s.request('session.detach', { session_id: legacy.session_id })
  await s.core.execution.drain()
  expect(s.provider.turns).toHaveLength(1)
  s.provider.turns[0]!.complete()
})
it.fails(
  'BUG: native-session continuation across a target switch still requires provider-specific rebinding',
  async () => {
    const s = await setup(true),
      external = join(s.dir, 'external')
    s.git('worktree', 'add', '-b', 'side', external)
    await s.request('project.trust', { project_id: s.project.project_id, trust: 'trusted' })
    await s.request('project.repository_settings', {
      project_id: s.project.project_id,
      external_read: true,
    })
    const destination = {
      kind: 'worktree',
      worktree_id: (
        await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
      ).entries.find((e: any) => e.kind === 'external').worktree_id,
    }
    for (const target of [s.target, destination])
      await s.request('project.execution', {
        project_id: s.project.project_id,
        target,
        enabled: true,
      })
    const chat = await s.request('session.create', { provider: 'claude', target: s.target })
    s.core.db
      .prepare('UPDATE sessions SET body=? WHERE session_id=?')
      .run(
        JSON.stringify({ ...chat, native_session_id: '11111111-1111-4111-8111-111111111111' }),
        chat.session_id
      )
    expect(
      await s.request('session.worktree.set', {
        session_id: chat.session_id,
        expected_target: s.target,
        target: destination,
      })
    ).toEqual({ session_id: chat.session_id, target: destination })
  }
)
