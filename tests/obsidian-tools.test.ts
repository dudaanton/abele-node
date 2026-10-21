import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { ObsidianTools } from '../packages/node-core/src/obsidian-tools.js'

const databases: DatabaseSync[] = []
afterEach(() => {
  vi.useRealTimers()
  databases.splice(0).forEach((db) => db.close())
})
function fixture(db = new DatabaseSync(':memory:'), mode = 'ask') {
  if (!databases.includes(db)) databases.push(db)
  const events: any[] = []
  const core: any = {
    db,
    authority: { check() {} },
    session: () => ({ session_id: 'session' }),
    checkExecution() {},
    append: (...args: any[]) => events.push(args),
    transaction: (fn: () => any) => fn(),
    prompt: (id: string) =>
      JSON.parse(String(db.prepare('SELECT body FROM prompts WHERE prompt_id=?').get(id)!.body)),
    resolvePrompt: (p: any, state: string, choice: string) =>
      db
        .prepare('UPDATE prompts SET body=? WHERE prompt_id=?')
        .run(JSON.stringify({ ...p, state, choice }), p.prompt_id),
    live: { effective: () => ({ permission_mode: 'manual' }) },
  }
  db.exec(
    'CREATE TABLE IF NOT EXISTS prompts(prompt_id TEXT PRIMARY KEY, session_id TEXT, run_id TEXT, body TEXT)'
  )
  const service = new ObsidianTools(core)
  const actor = { installation_id: 'owner' }
  const signal = new AbortController()
  const request = (method: string, params: any, s = signal.signal) =>
    service.request(actor, 'obsidian.tools.v1.' + method, params, s) as any
  const config = {
    session_id: 'session',
    vault_id: 'vault',
    agent_id: 'agent',
    revision: 'r1',
    tools: [{ name: 'create', description: 'Create note', inputSchema: { type: 'object' }, mode }],
  }
  request('configure', config)
  const advertise = (client_id = 'desktop', platform = 'desktop', vault_id = 'vault') =>
    request('advertise', { client_id, platform, vault_id, revisions: { agent: 'r1' } })
  const invoke = () => service.invoke(actor, 'session', 'run', 'call', 'create', { path: 'note' })
  return { db, service, events, request, config, advertise, invoke, signal, core }
}

it('persists without a client, ignores another vault, prefers desktop and binds one executor', () => {
  const f = fixture()
  const call = f.invoke()
  expect(call.state).toBe('awaiting_client')
  f.advertise('other', 'desktop', 'other-vault')
  expect(f.request('get', { invocation_id: call.invocation_id }).executor).toBeNull()
  f.request(
    'advertise',
    { client_id: 'phone', platform: 'mobile', vault_id: 'vault', revisions: { agent: 'r1' } },
    new AbortController().signal
  )
  f.advertise()
  const work = f.request('poll', { client_id: 'desktop' })
  expect(work[0].invocation_id).toBe(call.invocation_id)
  expect(work[0].executor.client_id).toBe('desktop')
  expect(f.request('poll', { client_id: 'phone' })).toEqual([])
  expect(f.invoke().invocation_id).toBe(call.invocation_id)
})

it('uses mobile when no desktop is connected and allows receipt reconciliation after cancel', () => {
  const f = fixture(undefined, 'auto')
  f.advertise('phone', 'mobile')
  const call = f.invoke()
  const ref = { invocation_id: call.invocation_id }
  const executor = { ...ref, client_id: 'phone', revision: 'r1' }
  expect(f.request('poll', { client_id: 'phone' })[0].executor.client_id).toBe('phone')
  f.request('prepare', { ...executor, preview: {} })
  f.request('claim', executor)
  expect(f.request('cancel', ref)).toMatchObject({ state: 'executing', cancel_requested: true })
  expect(f.request('poll', { client_id: 'phone' })[0].action).toBe('cancel')
  expect(
    f.request('complete', {
      ...executor,
      state: 'outcome_unknown',
      result: { reason: 'receipt unavailable' },
    }).state
  ).toBe('outcome_unknown')
  expect(f.request('claim', executor).execute).toBe(false)
})

it('can select a connected replacement before claim and invalidates the old preview approval', () => {
  const f = fixture()
  f.advertise()
  const call = f.invoke()
  f.request('poll', { client_id: 'desktop' })
  const prepared = f.request('prepare', {
    invocation_id: call.invocation_id,
    client_id: 'desktop',
    revision: 'r1',
    preview: {},
  })
  f.signal.abort()
  f.request(
    'advertise',
    { client_id: 'phone', platform: 'mobile', vault_id: 'vault', revisions: { agent: 'r1' } },
    new AbortController().signal
  )
  expect(f.request('poll', { client_id: 'phone' })[0]).toMatchObject({
    state: 'preparing',
    executor: { client_id: 'phone' },
  })
  expect(f.core.prompt(prepared.prompt_id).state).toBe('invalidated')
})

it('keeps an owner wait pending for days and cancels it when its trusted run closes', async () => {
  vi.useFakeTimers()
  const f = fixture()
  const bridge = f.service.bridge({ installation_id: 'owner' }, 'session', 'run', () => true)
  expect(bridge.tools).toEqual([
    { name: 'obsidian_create', description: 'Create note', inputSchema: { type: 'object' } },
  ])
  const promise = bridge.call('obsidian_create', { path: 'note' })
  const rejection = expect(promise).rejects.toThrow('cancelled')
  f.advertise()
  const call = f.request('poll', { client_id: 'desktop' })[0]
  f.request('prepare', {
    invocation_id: call.invocation_id,
    client_id: 'desktop',
    revision: 'r1',
    preview: {},
  })
  vi.setSystemTime(Date.now() + 3 * 86400000)
  await vi.advanceTimersByTimeAsync(250)
  expect(f.request('get', { invocation_id: call.invocation_id }).state).toBe('awaiting_approval')
  bridge.close()
  await rejection
  expect(f.request('get', { invocation_id: call.invocation_id }).state).toBe('cancelled')
  expect(vi.getTimerCount()).toBe(0)
})

it('bypass skips asks, including the plugin path ask, while disabled tools stay unavailable', () => {
  const f = fixture()
  f.core.claude = { live: { effective: () => ({ permission_mode: 'bypassPermissions' }) } }
  f.advertise()
  const call = f.invoke()
  f.request('poll', { client_id: 'desktop' })
  const executor = { invocation_id: call.invocation_id, client_id: 'desktop', revision: 'r1' }
  expect(f.request('prepare', { ...executor, preview: {}, needs_approval: true }).state).toBe(
    'ready'
  )
  expect(f.request('claim', executor)).toMatchObject({ execute: true, bypass: true })
  f.request('configure', {
    ...f.config,
    expected_revision: 'r1',
    revision: 'r2',
    tools: [{ ...f.config.tools[0], mode: 'off' }],
  })
  expect(() => f.invoke()).toThrow('tool_disabled')
})

it('rechecks bypass at claim rather than executing an unattended approval after a mode change', () => {
  const f = fixture()
  f.core.claude = { live: { effective: () => ({ permission_mode: 'bypassPermissions' }) } }
  f.advertise()
  const call = f.invoke()
  f.request('poll', { client_id: 'desktop' })
  const executor = { invocation_id: call.invocation_id, client_id: 'desktop', revision: 'r1' }
  f.request('prepare', { ...executor, preview: {} })
  f.core.claude.live.effective = () => ({ permission_mode: 'manual' })
  expect(f.request('claim', executor).execute).toBe(false)
  expect(f.request('prepare', { ...executor, preview: {} }).state).toBe('awaiting_approval')
})

it('preserves a pending invocation on node detach and reattaches by the provider call ID', async () => {
  const f = fixture()
  const bridge = f.service.bridge({ installation_id: 'owner' }, 'session', 'run', () => true)
  const pending = bridge.call('obsidian_create', { path: 'note' }, undefined, 'pi:call')
  const rejected = expect(pending).rejects.toThrow('cancelled')
  f.advertise()
  const call = f.request('poll', { client_id: 'desktop' })[0]
  f.request('prepare', {
    invocation_id: call.invocation_id,
    client_id: 'desktop',
    revision: 'r1',
    preview: {},
  })
  f.service.suspendRun('run')
  bridge.close()
  await rejected
  expect(f.request('get', { invocation_id: call.invocation_id }).state).toBe('awaiting_approval')
  const replacement = new ObsidianTools(f.core)
  const next = replacement.bridge({ installation_id: 'owner' }, 'session', 'run', () => true)
  const resumed = next.call('obsidian_create', { path: 'note' }, undefined, 'pi:call')
  const resumedRejection = expect(resumed).rejects.toThrow('cancelled')
  expect(f.db.prepare('SELECT count(*) AS n FROM obsidian_tool_invocations').get()!.n).toBe(1)
  next.close()
  await resumedRejection
})

it('claims once, reconciles after disconnect and never dispatches on another device', () => {
  const f = fixture(undefined, 'auto')
  f.advertise()
  const call = f.invoke()
  f.request('poll', { client_id: 'desktop' })
  const p = { invocation_id: call.invocation_id, client_id: 'desktop', revision: 'r1', preview: {} }
  f.request('prepare', p)
  const { preview: _, ...claim } = p
  expect(f.request('claim', claim).execute).toBe(true)
  expect(f.request('claim', claim).execute).toBe(false)
  f.signal.abort()
  f.request(
    'advertise',
    { client_id: 'phone', platform: 'mobile', vault_id: 'vault', revisions: { agent: 'r1' } },
    new AbortController().signal
  )
  expect(f.request('poll', { client_id: 'phone' })).toEqual([])
  f.request(
    'advertise',
    { client_id: 'desktop', platform: 'desktop', vault_id: 'vault', revisions: { agent: 'r1' } },
    new AbortController().signal
  )
  expect(f.request('poll', { client_id: 'desktop' })[0].action).toBe('reconcile')
})

it('retains exact approval through restart, rejects stale revisions and supports cancellation', () => {
  const f = fixture()
  f.advertise()
  const call = f.invoke()
  f.request('poll', { client_id: 'desktop' })
  const p = {
    invocation_id: call.invocation_id,
    client_id: 'desktop',
    revision: 'r1',
    preview: { text: 'note' },
  }
  f.request('prepare', p)
  const reference = { invocation_id: call.invocation_id }
  expect(f.request('get', reference).state).toBe('awaiting_approval')
  const restarted = new ObsidianTools(f.core)
  expect(
    (restarted.request({ installation_id: 'owner' }, 'obsidian.tools.v1.get', reference) as any)
      .state
  ).toBe('awaiting_approval')
  const { preview: _, ...claim } = p
  expect(() => f.request('claim', { ...claim, revision: 'old' })).toThrow('stale_revision')
  expect(f.request('cancel', reference).state).toBe('cancelled')
  expect(f.request('claim', claim).execute).toBe(false)
})

it('requires a fresh permission snapshot before executing and refuses disabled tools', () => {
  const f = fixture()
  const call = f.invoke()
  f.advertise()
  f.request('poll', { client_id: 'desktop' })
  f.request('configure', {
    ...f.config,
    expected_revision: 'r1',
    revision: 'r2',
    tools: [{ ...f.config.tools[0], mode: 'off' }],
  })
  expect(() =>
    f.request('prepare', {
      invocation_id: call.invocation_id,
      client_id: 'desktop',
      revision: 'r1',
      preview: {},
    })
  ).toThrow('stale_revision')
  expect(() => f.invoke()).toThrow('tool_disabled')
})
