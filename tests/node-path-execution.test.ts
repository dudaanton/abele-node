import { afterEach, expect, it, vi } from 'vitest'
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
  interrupt?: () => Promise<void>
}
function adapter() {
  const turns: Turn[] = []
  let liveAvailable = false
  const fake: ProviderAdapter = {
    get liveAvailable() {
      return liveAvailable
    },
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
      const turn = { context, sink, complete } as Turn
      turns.push(turn)
      return {
        done,
        interrupt: async () => {
          await turn.interrupt?.()
          complete()
        },
      }
    },
  }
  return {
    fake,
    turns,
    setLive: (enabled: boolean) => {
      liveAvailable = enabled
    },
  }
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
it('bounds a stuck cleanup wait while admitting unrelated queued work', async () => {
  const s = await setup()
  await s.request('project.trust', { project_id: s.project.project_id, trust: 'trusted' })
  await s.request('project.execution', {
    project_id: s.project.project_id,
    target: s.target,
    enabled: true,
  })
  const first = await s.request('session.create', { provider: 'claude', target: s.target })
  await s.request('session.send', {
    session_id: first.session_id,
    text: 'first',
    observed_seq: s.core.head(first.session_id),
  })
  await s.core.execution.drain()
  const turn = s.provider.turns[0]!
  let release!: () => void
  turn.interrupt = () =>
    new Promise<void>((resolve) => {
      release = resolve
    })
  await s.request('session.interrupt', {
    session_id: first.session_id,
    run_id: turn.context.run_id,
  })
  const folder = join(s.dir, 'other')
  mkdirSync(folder)
  const project = await s.request('project.register', {
    path: folder,
    trust: 'trusted',
    exact_root: true,
  })
  const workspace = (await s.request('workspace.list', { project_id: project.project_id }))[0]
  const target = { kind: 'workspace', workspace_id: workspace.workspace_id }
  await s.request('project.execution', { project_id: project.project_id, target, enabled: true })
  const second = await s.request('session.create', { provider: 'claude', target })
  await s.request('session.send', {
    session_id: second.session_id,
    text: 'second',
    observed_seq: s.core.head(second.session_id),
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    let settled = false
    const draining = s.core.execution.drain().then(() => {
      settled = true
    })
    await vi.waitFor(() => expect(s.provider.turns).toHaveLength(2))
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(5000)
    await draining
    expect(settled).toBe(true)
    expect(s.core.resources.targets.leasedPath(s.folder)).toBe(true)
    expect(
      s.core
        .read(first.session_id, 0)
        .some((e) => e.type === 'session.error' && (e.data as any).reason === 'cleanup_timeout')
    ).toBe(true)
  } finally {
    release?.()
    turn.interrupt = undefined
    vi.useRealTimers()
  }
})
it.each(['interrupt', 'revoke'])(
  'settles asynchronous cleanup before drain returns after %s',
  async (action) => {
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
    const turn = s.provider.turns[0]!
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    turn.interrupt = () => gate
    if (action === 'interrupt')
      await s.request('session.interrupt', {
        session_id: chat.session_id,
        run_id: turn.context.run_id,
      })
    else s.core.revokeToken(s.actor.installation_id)
    const draining = s.core.execution.drain()
    const scheduled = setImmediate(release)
    try {
      await draining
      expect(
        s.core.db.prepare("SELECT count(*) AS n FROM provider_runs WHERE state='active'").get()
      ).toEqual({ n: 0 })
      expect(s.core.resources.targets.leasedPath(s.folder)).toBe(false)
    } finally {
      clearImmediate(scheduled)
      release()
    }
  }
)
it.each([false, true])(
  'fails a queued input when its execution folder has disappeared (active: %s)',
  async (active) => {
    const s = await setup()
    await s.request('project.trust', { project_id: s.project.project_id, trust: 'trusted' })
    await s.request('project.execution', {
      project_id: s.project.project_id,
      target: s.target,
      enabled: true,
    })
    const chat = await s.request('session.create', { provider: 'claude', target: s.target })
    if (active) {
      await s.request('session.send', {
        session_id: chat.session_id,
        text: 'active',
        observed_seq: s.core.head(chat.session_id),
      })
      await s.core.execution.drain()
      s.provider.turns[0]!.complete('process_cleanup_unconfirmed')
      await expect
        .poll(() => s.core.read(chat.session_id, 0).some((e) => e.type === 'run.interrupted'))
        .toBe(true)
      s.provider.fake.reconcile = async () => {
        throw new Error('injected_cleanup_failure')
      }
    }
    await s.request('session.send', {
      session_id: chat.session_id,
      text: 'fixture',
      observed_seq: s.core.head(chat.session_id),
    })
    rmSync(s.folder, { recursive: true })
    await s.core.execution.drain()
    s.provider.fake.reconcile = async () => {}
    expect(
      s.core.db
        .prepare('SELECT state FROM inputs WHERE session_id=? ORDER BY ordinal DESC LIMIT 1')
        .get(chat.session_id)
    ).toEqual({ state: 'failed' })
    expect(
      s.core
        .read(chat.session_id, 0)
        .some((e) => e.type === 'run.failed' && typeof (e.data as any).reason === 'string')
    ).toBe(true)
  }
)
it('exposes queued input identities in the journal and lets the owner cancel them', async () => {
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
  const queued = s.core.read(chat.session_id, 0).find((e) => e.type === 'input.queued')!
  expect(queued).toBeDefined()
  expect(
    await s.request('input.cancel', {
      session_id: chat.session_id,
      input_id: (queued.data as any).input_id,
    })
  ).toMatchObject({ state: 'cancelled' })
  await s.core.execution.drain()
  expect(s.provider.turns).toHaveLength(0)
})
it.each([false, true])('passes project network opt-in %s to provider turns', async (enabled) => {
  const s = await setup()
  await s.request('project.trust', { project_id: s.project.project_id, trust: 'trusted' })
  await s.request('project.execution', {
    project_id: s.project.project_id,
    target: s.target,
    enabled: true,
  })
  await s.request('project.codex_permissions', {
    project_id: s.project.project_id,
    network_enabled: enabled,
  })
  const chat = await s.request('session.create', { provider: 'claude', target: s.target })
  await s.request('session.send', {
    session_id: chat.session_id,
    text: 'fixture',
    observed_seq: s.core.head(chat.session_id),
  })
  await s.core.execution.drain()
  expect(s.provider.turns[0]!.context.codex_network_enabled).toBe(enabled)
})
it('publishes a readable chat notice when provider admission refuses a run', async () => {
  const s = await setup()
  s.provider.fake.configuration.per_action_approval = false
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
  expect(
    s.core
      .read(chat.session_id, 0)
      .some(
        (e) =>
          e.type === 'session.update' &&
          (e.data as any).update.kind === 'notice' &&
          (e.data as any).update.text.includes('Bypass')
      )
  ).toBe(true)
})
it('fails a queued live input and explains missing Bypass opt-in after startup refuses it', async () => {
  const s = await setup()
  s.provider.setLive(true)
  s.provider.fake.startSession = async () => {
    throw new Error('codex_bypass_unavailable')
  }
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
  expect(
    s.core.db.prepare('SELECT state FROM inputs WHERE session_id=?').get(chat.session_id)
  ).toEqual({ state: 'failed' })
  expect(
    s.core
      .read(chat.session_id, 0)
      .some((e) => e.type === 'session.update' && (e.data as any).update.text.includes('opt-in'))
  ).toBe(true)
  expect(s.core.resources.targets.leasedPath(s.folder)).toBe(false)
})
it('isolates an exited live process with unconfirmed cleanup from other sessions', async () => {
  const s = await setup()
  let exit!: (result: { reason?: string }) => void
  s.provider.setLive(true)
  s.provider.fake.startSession = async () => ({
    done: new Promise((resolve) => {
      exit = resolve
    }),
    send: () => {},
    interrupt: async () => {},
    control: async () => ({}),
    stop: async () => {
      exit({})
    },
  })
  await s.request('project.trust', { project_id: s.project.project_id, trust: 'trusted' })
  await s.request('project.execution', {
    project_id: s.project.project_id,
    target: s.target,
    enabled: true,
  })
  const first = await s.request('session.create', { provider: 'claude', target: s.target })
  await s.request('session.send', {
    session_id: first.session_id,
    text: 'fixture',
    observed_seq: s.core.head(first.session_id),
  })
  await s.core.execution.drain()
  exit({ reason: 'process_cleanup_unconfirmed' })
  await Promise.resolve()
  s.provider.fake.reconcile = async () => {
    throw new Error('injected_cleanup_failure')
  }
  // Switch subsequent sessions to the bounded fake turn adapter.
  s.provider.setLive(false)
  const folder = join(s.dir, 'other')
  mkdirSync(folder)
  const project = await s.request('project.register', {
    path: folder,
    trust: 'trusted',
    exact_root: true,
  })
  const workspace = (await s.request('workspace.list', { project_id: project.project_id }))[0]
  const target = { kind: 'workspace', workspace_id: workspace.workspace_id }
  await s.request('project.execution', { project_id: project.project_id, target, enabled: true })
  const second = await s.request('session.create', { provider: 'claude', target })
  await s.request('session.send', {
    session_id: second.session_id,
    text: 'fixture',
    observed_seq: s.core.head(second.session_id),
  })
  await s.core.execution.drain()
  expect(s.provider.turns).toHaveLength(1)
  expect(s.core.resources.targets.leasedPath(s.folder)).toBe(true)
  s.provider.fake.reconcile = async () => {}
  await Promise.resolve()
  await s.core.execution.drain()
  await expect.poll(() => s.core.resources.targets.leasedPath(s.folder)).toBe(false)
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
  // Recovery must not leave the entire scheduler permanently paused.
  await s.core.execution.drain()
  const next = await s.request('session.create', { provider: 'claude', target: s.target })
  await s.request('session.send', {
    session_id: next.session_id,
    text: 'fixture',
    observed_seq: s.core.head(next.session_id),
  })
  await s.core.execution.drain()
  expect(s.provider.turns).toHaveLength(2)
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
it('shares ordinary managed lifetime bindings while serializing provider execution', async () => {
  const s = await setup(true)
  const created = await s.request('workspace.create', { project_id: s.project.project_id })
  await s.core.resources.jobs.drain()
  await s.request('project.trust', { project_id: s.project.project_id, trust: 'trusted' })
  const chats = []
  for (const title of ['one', 'two']) {
    const chat = await s.request('session.create', {
      provider: 'claude',
      workspace_id: created.workspace_id,
      title,
    })
    chats.push(chat)
    await s.request('session.send', {
      session_id: chat.session_id,
      text: 'fixture',
      observed_seq: s.core.head(chat.session_id),
    })
  }
  await s.core.execution.drain()
  expect(s.provider.turns).toHaveLength(1)
  s.provider.turns[0]!.complete()
  await expect
    .poll(() => s.core.db.prepare('SELECT count(*) AS n FROM execution_target_leases').get())
    .toEqual({ n: 0 })
  await s.core.execution.drain()
  expect(s.provider.turns).toHaveLength(2)
  expect(s.provider.turns.map((turn) => turn.context.session_id).sort()).toEqual(
    chats.map((chat) => chat.session_id).sort()
  )
  s.provider.turns[1]!.complete()
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
