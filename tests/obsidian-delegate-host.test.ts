import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((fn) => fn()))
function fixture() {
  const dir = mkdtempSync(resolve('.scratch/obsidian-delegate-'))
  let core = new NodeCore(dir)
  const actor = core.authority.authenticate(core.createToken('owner').token)
  const session = core.request(
    actor,
    'session.create',
    { provider: 'fake', title: 'Delegate' },
    'session'
  ) as any
  const request = (method: string, p: any) =>
    core.request(
      actor,
      'obsidian.tools.v1.' + method,
      p,
      undefined,
      new AbortController().signal
    ) as any
  const config = {
    session_id: session.session_id,
    vault_id: 'vault',
    agent_id: 'parent',
    revision: 'r1',
    max_delegate_depth: 3,
    conversation: {
      scope: ['Parent/'],
      permissionMode: 'confirm-all',
      skillCeiling: ['skill-one'],
    },
    tools: [
      { name: 'delegate', description: 'Delegate', inputSchema: {}, mode: 'auto' },
      { name: 'write', description: 'Write', inputSchema: {}, mode: 'ask' },
    ],
  }
  request('configure', config)
  const advertise = () =>
    request('advertise', {
      client_id: 'desktop',
      vault_id: 'vault',
      platform: 'desktop',
      revisions: { parent: 'r1' },
    })
  advertise()
  const target = {
    vault_id: 'vault',
    agent_id: 'target',
    revision: 'target-r1',
    max_delegate_depth: 3,
    conversation: { scope: [] },
    tools: config.tools.map((t) => ({ ...t, mode: 'auto' })),
  }
  const invoke = (key: string, items: string[] = [], agent = 'Target') => {
    const call = core.obsidianTools.invoke(actor, session.session_id, 'run', key, 'delegate', {
      agent,
      task: 'Do the work',
      items,
      batch_size: 30,
    })
    request('poll', { client_id: 'desktop' })
    const executor = { invocation_id: call.invocation_id, client_id: 'desktop', revision: 'r1' }
    request('prepare', { ...executor, preview: {} })
    request('claim', executor)
    return executor
  }
  const executor = invoke('call')
  const begin = (extra: any = {}, e = executor) =>
    request('delegate.begin', { ...e, call_id: 'outer', agent_name: 'Target', target, ...extra })
  cleanup.push(() => {
    core.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return {
    get core() {
      return core
    },
    actor,
    request,
    config,
    target,
    executor,
    invoke,
    begin,
    restart() {
      core.close()
      core = new NodeCore(dir)
      advertise()
    },
  }
}

it('reserves ordinary depth/budget metadata once, bounds permissions and keeps fresh branch contexts', () => {
  const f = fixture()
  const run = f.begin()
  expect(run).toMatchObject({
    root_id: f.config.session_id,
    depth: 1,
    depth_limit: 3,
    batch_size: 10,
    used_runs: 1,
  })
  expect(run).toMatchObject({
    task: 'Do the work',
    fan_out: false,
    parent_context: f.config.conversation,
  })
  expect(run.branches[0]).toMatchObject({ state: 'queued' })
  expect(run.configuration.tools.find((t: any) => t.name === 'write').mode).toBe('ask')
  expect(f.begin().run_id).toBe(run.run_id)
  expect(() => f.begin({ target: { ...f.target, revision: 'changed' } })).toThrow(
    'operation_conflict'
  )
  const branch = run.branches[0]
  expect(f.request('delegate.claim', { ...f.executor, branch_id: branch.branch_id }).execute).toBe(
    true
  )
  expect(f.request('delegate.claim', { ...f.executor, branch_id: branch.branch_id }).execute).toBe(
    false
  )
  const nested = f.begin({
    call_id: 'nested',
    parent_branch_id: branch.branch_id,
    arguments: { agent: 'Target', task: 'Nested', items: ['one', 'two'] },
  })
  expect(nested).toMatchObject({ depth: 2, used_runs: 3, batch_size: 5 })
  expect(
    nested.branches.map(
      (b: any) =>
        f.request('delegate.branch', {
          invocation_id: f.executor.invocation_id,
          branch_id: b.branch_id,
        }).task
    )
  ).toEqual(['Nested\n\none', 'Nested\n\ntwo'])
  expect(nested.branches[0].branch_id).not.toBe(nested.branches[1].branch_id)
})

it('matches ordinary agent names with the same trimming and case rules as the registry', () => {
  const f = fixture()
  const executor = f.invoke('case-name', [], '  tArGeT  ')
  expect(f.begin({}, executor).depth).toBe(1)
})

it('enforces the shared 50-run budget and 20-item bound before reserving or launching anything', () => {
  const f = fixture()
  for (let index = 0; index < 2; index++)
    f.begin(
      {},
      f.invoke(
        'batch-' + index,
        Array.from({ length: 20 }, (_, n) => String(n))
      )
    )
  f.begin(
    {},
    f.invoke(
      'nine',
      Array.from({ length: 10 }, (_, n) => String(n))
    )
  )
  expect(() => f.begin()).toThrow('delegate_budget_exceeded')
  const tooMany = f.invoke(
    'too-many',
    Array.from({ length: 21 }, (_, n) => String(n))
  )
  expect(() => f.begin({}, tooMany)).toThrow('invalid_params')
  expect(f.request('delegate.get', { invocation_id: tooMany.invocation_id }).used_runs).toBe(50)
})

it('rejects depth expansion and wrong-vault targets, including across executor restart', () => {
  const f = fixture()
  expect(() =>
    f.begin({ target: { ...f.target, vault_id: 'other' } }, f.invoke('wrong-vault'))
  ).toThrow('wrong_vault')
  let parent: string | undefined
  for (let depth = 1; depth <= 3; depth++) {
    const run = f.begin({
      call_id: 'level-' + depth,
      ...(parent
        ? { parent_branch_id: parent, arguments: { agent: 'Target', task: 'Nested' } }
        : {}),
    })
    parent = run.branches[0].branch_id
    f.request('delegate.claim', { ...f.executor, branch_id: parent })
  }
  f.restart()
  expect(() =>
    f.begin({
      call_id: 'too-deep',
      parent_branch_id: parent,
      arguments: { agent: 'Target', task: 'Nested' },
    })
  ).toThrow('delegate_depth_exceeded')
  expect(f.request('delegate.get', { invocation_id: f.executor.invocation_id }).used_runs).toBe(3)
})

it('settles rejected initial admission durably without reserving or replaying work', () => {
  const f = fixture()
  expect(() => f.begin({ target: { ...f.target, vault_id: 'other' } })).toThrow('wrong_vault')
  const failed = f.request('get', { invocation_id: f.executor.invocation_id })
  expect(failed).toMatchObject({ state: 'failed', result: { isError: true } })
  expect(JSON.stringify(failed.result)).toContain('wrong_vault')
  f.restart()
  expect(() => f.begin()).toThrow('operation_conflict')
  expect(f.request('cancel', { invocation_id: f.executor.invocation_id })).toEqual(failed)
  expect(f.request('delegate.get', { invocation_id: f.executor.invocation_id })).toMatchObject({
    used_runs: 0,
    runs: [],
  })
})

it('cancels a claimed delegate before admission and keeps it terminal on replay', () => {
  const f = fixture()
  const cancelled = f.request('cancel', { invocation_id: f.executor.invocation_id })
  expect(cancelled.state).toBe('cancelled')
  f.restart()
  expect(() => f.begin()).toThrow('cancelled')
  expect(f.request('cancel', { invocation_id: f.executor.invocation_id })).toEqual(cancelled)
  expect(f.request('delegate.get', { invocation_id: f.executor.invocation_id }).runs).toEqual([])
})

it('settles stale initial admission but never lets an unbound executor fail the call', () => {
  const f = fixture()
  expect(() => f.begin({ client_id: 'unbound' })).toThrow('wrong_executor')
  expect(f.request('get', { invocation_id: f.executor.invocation_id }).state).toBe('executing')
  expect(() => f.begin({ revision: 'old' })).toThrow('stale_revision')
  expect(f.request('get', { invocation_id: f.executor.invocation_id })).toMatchObject({
    state: 'failed',
    result: { isError: true },
  })
  expect(() => f.begin()).toThrow('operation_conflict')
})

it('keeps durable history, fences branch replay and delivers the ordinary summary as the tool result', () => {
  const f = fixture()
  const run = f.begin()
  const branch = run.branches[0]
  f.request('delegate.claim', { ...f.executor, branch_id: branch.branch_id })
  const record = {
    ...f.executor,
    branch_id: branch.branch_id,
    record_id: 'record-one',
    messages: [{ role: 'assistant', content: 'Answer' }],
    state: 'done',
    result: 'Answer',
  }
  f.request('delegate.record', record)
  expect(f.request('delegate.record', record)).toEqual(f.request('delegate.record', record))
  expect(() => f.request('delegate.record', { ...record, result: 'Changed' })).toThrow(
    'operation_conflict'
  )
  f.restart()
  expect(f.request('delegate.claim', { ...f.executor, branch_id: branch.branch_id }).execute).toBe(
    false
  )
  expect(
    f.request('delegate.history', {
      invocation_id: f.executor.invocation_id,
      branch_id: branch.branch_id,
    })
  ).toMatchObject({ entries: [{ seq: 1, message: { role: 'assistant', content: 'Answer' } }] })
  expect(f.request('get', { invocation_id: f.executor.invocation_id })).toMatchObject({
    state: 'succeeded',
    result: { content: [{ type: 'text', text: 'Answer' }] },
  })
})

it('prevents new sub-runs after cancellation and records unknown running outcomes without replay', () => {
  const f = fixture()
  const run = f.begin()
  f.request('delegate.claim', { ...f.executor, branch_id: run.branches[0].branch_id })
  f.request('cancel', { invocation_id: f.executor.invocation_id })
  expect(() => f.begin({ call_id: 'late' })).toThrow('cancelled')
  expect(
    f.request('delegate.claim', { ...f.executor, branch_id: run.branches[0].branch_id }).execute
  ).toBe(false)
  f.request('delegate.record', {
    ...f.executor,
    branch_id: run.branches[0].branch_id,
    record_id: 'unknown',
    state: 'outcome_unknown',
    error: 'No durable provider result',
  })
  expect(f.request('get', { invocation_id: f.executor.invocation_id }).state).toBe('cancelled')
})

it('honors a target depth of zero and caps physical branch starts at the admitted batch size', () => {
  const f = fixture()
  const outer = f.begin({ target: { ...f.target, max_delegate_depth: 0 } })
  const branch = outer.branches[0]
  f.request('delegate.claim', { ...f.executor, branch_id: branch.branch_id })
  expect(() =>
    f.begin({
      call_id: 'blocked',
      parent_branch_id: branch.branch_id,
      arguments: { agent: 'Target', task: 'Nested' },
    })
  ).toThrow('delegate_depth_exceeded')
  const executor = f.invoke(
    'batch',
    Array.from({ length: 20 }, (_, n) => String(n))
  )
  const batch = f.begin({}, executor)
  for (const branch of batch.branches.slice(0, 10))
    f.request('delegate.claim', { ...executor, branch_id: branch.branch_id })
  expect(() =>
    f.request('delegate.claim', { ...executor, branch_id: batch.branches[10].branch_id })
  ).toThrow('delegate_batch_limit')
  expect(() => f.request('complete', { ...executor, state: 'succeeded', result: {} })).toThrow(
    'hosted_invocation'
  )
})

it.each(['off', 'ask'])('does not let a hosted sub-run delegate with mode %s', (mode) => {
  const f = fixture()
  const run = f.begin({
    target: {
      ...f.target,
      tools: f.target.tools.map((t) => (t.name === 'delegate' ? { ...t, mode } : t)),
    },
  })
  const branch = run.branches[0]
  f.request('delegate.claim', { ...f.executor, branch_id: branch.branch_id })
  expect(() =>
    f.begin({
      call_id: 'not-authorized',
      parent_branch_id: branch.branch_id,
      arguments: { agent: 'Target', task: 'Nested' },
    })
  ).toThrow(mode === 'off' ? 'tool_disabled' : 'delegate_approval_required')
  expect(f.request('delegate.get', { invocation_id: f.executor.invocation_id }).used_runs).toBe(1)
})

it('appends history idempotently in bounded pages and cannot finish ahead of nested work', () => {
  const f = fixture()
  const outer = f.begin()
  const branch = outer.branches[0]
  f.request('delegate.claim', { ...f.executor, branch_id: branch.branch_id })
  f.begin({
    call_id: 'nested',
    parent_branch_id: branch.branch_id,
    arguments: { agent: 'Target', task: 'Nested' },
  })
  expect(() =>
    f.request('delegate.record', {
      ...f.executor,
      branch_id: branch.branch_id,
      record_id: 'premature',
      state: 'done',
      messages: [{ text: 'must roll back' }],
    })
  ).toThrow('delegate_children_running')
  expect(
    f.request('delegate.history', {
      invocation_id: f.executor.invocation_id,
      branch_id: branch.branch_id,
    }).entries
  ).toEqual([])
  for (let index = 0; index < 3; index++)
    f.request('delegate.record', {
      ...f.executor,
      branch_id: branch.branch_id,
      record_id: 'page-' + index,
      messages: [{ text: 'x'.repeat(60000) }],
    })
  const page = f.request('delegate.history', {
    invocation_id: f.executor.invocation_id,
    branch_id: branch.branch_id,
    limit: 1,
  })
  expect(page.entries).toHaveLength(1)
  expect(page.has_more).toBe(true)
  expect(
    f
      .request('delegate.history', {
        invocation_id: f.executor.invocation_id,
        branch_id: branch.branch_id,
        after_seq: page.next_seq,
      })
      .entries.map((e: any) => e.seq)
  ).toEqual([2, 3])
})

it('keeps oversized batch failures in history while delivering a bounded result with run references', () => {
  const f = fixture()
  const executor = f.invoke(
    'large-errors',
    Array.from({ length: 20 }, (_, n) => String(n))
  )
  const run = f.begin({}, executor)
  const error = '界'.repeat(4096)
  for (const branch of run.branches) {
    f.request('delegate.claim', { ...executor, branch_id: branch.branch_id })
    f.request('delegate.record', {
      ...executor,
      branch_id: branch.branch_id,
      record_id: 'failed',
      state: 'error',
      error,
    })
  }
  const final = f.request('get', { invocation_id: executor.invocation_id })
  expect(final.result.content[0].text).toContain('exceeds')
  expect(final.result.delegate.branch_ids).toHaveLength(20)
  expect(
    f.request('delegate.branch', {
      invocation_id: executor.invocation_id,
      branch_id: run.branches[0].branch_id,
    }).error
  ).toBe(error)
  expect(Buffer.byteLength(JSON.stringify(final))).toBeLessThan(240 * 1024)
})
