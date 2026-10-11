import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodeCore, DebuggerAgentBinding, DebuggerRunBinding } from '@abele/node-core'
import { target } from './helpers.js'
import { FrameCodec } from '@abele/channel-protocol'
import { serveChannel } from '@abele/channel-server'

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'debug-tools-'))
  const core = new NodeCore(dir, { debuggerEnabled: true })
  const owner = core.authority.authenticate(core.createToken('owner').token)
  const control = core.debuggerControl
  const initial = core.debugger.create(target)
  const id = initial.debug_session_id
  const observe = (data: any) => core.debugger.observe(id, initial.incarnation, data)
  observe({ kind: 'lifecycle', lifecycle: 'active' })
  const stop = () =>
    observe({
      kind: 'stopped',
      thread_id: 1,
      all_threads_stopped: true,
      reason: 'breakpoint',
      hit_breakpoint_ids: ['bp'],
    })
  stop()
  const grant = control.createGrant(owner, {
    installation_id: owner.installation_id,
    run_id: 'run',
    task_id: 'task',
    conversation_id: target.conversation_id,
    workspace_id: target.workspace_id,
    target_id: target.target_id,
    debug_session_id: id,
    incarnation: initial.incarnation,
    expires_at: new Date(Date.now() + 120000).toISOString(),
    actions: ['read', 'step', 'breakpoints', 'expressions'],
    mode: 'allow-all',
  })
  const principal = {
    kind: 'agent' as const,
    authority: owner,
    grant_id: grant.grant_id,
    run_id: 'run',
    task_id: 'task',
    conversation_id: target.conversation_id,
    workspace_id: target.workspace_id,
    target_id: target.target_id,
  }
  const state = () => core.debugger.snapshot(id).snapshot
  const args = () => ({
    debug_session_id: id,
    incarnation: initial.incarnation,
    expected_state_revision: state().state_revision,
  })
  const binding = new DebuggerAgentBinding(core, principal)
  const close = () => {
    binding.close()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
  return {
    core,
    control,
    owner,
    grant,
    principal,
    binding,
    id,
    dir,
    observe,
    stop,
    state,
    args,
    close,
  }
}

afterEach(() => vi.useRealTimers())
describe('debugger active-turn tools and node timers', () => {
  it('bounds node-wide timers across independent sessions', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const second = f.core.debugger.create({ ...target, target_id: 'second' })
    f.core.debugger.observe(second.debug_session_id, second.incarnation, {
      kind: 'lifecycle',
      lifecycle: 'active',
    })
    const human = { kind: 'human' as const, authority: f.owner },
      waits: Promise<any>[] = []
    try {
      for (let i = 0; i < 128; i++)
        waits.push(
          f.control.wait(human, 'sleep', {
            debug_session_id: i % 2 ? f.id : second.debug_session_id,
            duration_ms: 60000,
            wake_on: [],
          })
        )
      expect(() =>
        f.control.wait(human, 'sleep', {
          debug_session_id: second.debug_session_id,
          duration_ms: 60000,
          wake_on: [],
        })
      ).toThrow('debugger_wait_limit')
      expect(vi.getTimerCount()).toBe(128)
    } finally {
      f.control.close()
      await Promise.all(waits)
      expect(vi.getTimerCount()).toBe(0)
      f.close()
    }
  })
  it('rejects an already-aborted control call before dispatch', async () => {
    const f = fixture(),
      abort = new AbortController()
    let dispatched = false
    f.control.registerBackend(f.id, {
      supports: () => true,
      dispatch: async (_m, _p, guard) => {
        guard()
        dispatched = true
        return {}
      },
    })
    abort.abort()
    try {
      expect(
        await f.binding.call(
          'debug_step',
          { ...f.args(), thread_id: 1, kind: 'over' },
          abort.signal
        )
      ).toMatchObject({
        outcome: 'rejected',
        code: 'cancelled',
        snapshot: { execution: 'stopped' },
      })
      expect(dispatched).toBe(false)
    } finally {
      f.close()
    }
  })
  it('keeps tool admission gated even for trusted bindings and provider allow rules', async () => {
    const f = fixture(),
      disabled = new NodeCore(join(f.dir, 'disabled'))
    const binding = new DebuggerAgentBinding(disabled, f.principal)
    try {
      expect(binding.tools).toEqual([])
      expect(await binding.call('debug_status', { debug_session_id: f.id })).toMatchObject({
        code: 'unsupported_method',
        snapshot: null,
        observation: 'unknown',
      })
      const receipt = await f.binding.call('debug_step', {
        ...f.args(),
        operation_id: 'model-minted',
        thread_id: 1,
        kind: 'over',
      })
      expect(receipt).toMatchObject({ code: 'invalid_params' })
    } finally {
      binding.close()
      disabled.close()
      f.close()
    }
  })
  it('does not let unrelated cleanup failure delay controller revocation of timers', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const cleanup = vi.spyOn(f.core.resources.repository, 'revoked').mockImplementation(() => {
      throw Error('cleanup_failed')
    })
    let settled = false
    const sleep = f.binding
      .call('debug_sleep', { debug_session_id: f.id, duration_ms: 60000, wake_on: [] })
      .then((result) => {
        settled = true
        return result
      })
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(() => f.core.revokeToken(f.owner.installation_id)).toThrow('cleanup_failed')
      await vi.advanceTimersByTimeAsync(0)
      expect(settled).toBe(true)
      expect(await sleep).toMatchObject({ reason: 'cancelled', snapshot: null })
    } finally {
      cleanup.mockRestore()
      f.close()
    }
  })
  it('settles sleepers immediately when the authenticating controller is revoked', async () => {
    vi.useFakeTimers()
    const f = fixture()
    try {
      const sleep = f.binding.call('debug_sleep', {
        debug_session_id: f.id,
        duration_ms: 60000,
        wake_on: [],
      })
      await vi.advanceTimersByTimeAsync(0)
      f.core.revokeToken(f.owner.installation_id)
      expect(await sleep).toMatchObject({ reason: 'cancelled', snapshot: null })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      f.close()
    }
  })
  it('cancels only the caller-scoped named wait and expires state on node loss', async () => {
    vi.useFakeTimers()
    const f = fixture()
    try {
      const args = {
        debug_session_id: f.id,
        duration_ms: 60000,
        wake_on: [],
        wait_id: 'known-wait',
      }
      const sleep = f.binding.call('debug_sleep', args)
      await vi.advanceTimersByTimeAsync(0)
      expect(() =>
        f.control.waits.cancel(
          { kind: 'human', authority: f.owner },
          { debug_session_id: f.id, wait_id: 'known-wait' }
        )
      ).toThrow('not_found')
      expect(
        await f.binding.call('debug_cancelWait', { debug_session_id: f.id, wait_id: 'known-wait' })
      ).toMatchObject({ cancelled: true, snapshot: { execution: 'stopped' } })
      expect(await sleep).toMatchObject({ reason: 'cancelled', snapshot: { execution: 'stopped' } })
      const pending = f.control.wait(f.principal, 'sleep', { ...args, wait_id: 'node-loss' })
      f.control.close()
      expect(await pending).toMatchObject({ reason: 'connection_lost', snapshot: null })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      f.close()
    }
  })
  it('channel timer requests do not block later input and disconnect cancels them', async () => {
    vi.useFakeTimers()
    const f = fixture(),
      frames: Uint8Array[] = [],
      received: any[] = []
    let ended = false,
      wake = () => {}
    const push = (frame: unknown) => {
      frames.push(FrameCodec.encode(frame))
      wake()
    }
    const transport = {
      async send(bytes: Uint8Array) {
        received.push(FrameCodec.decode(bytes))
      },
      async *receive() {
        while (!ended) {
          if (frames.length) yield frames.shift()!
          else
            await new Promise<void>((resolve) => {
              wake = resolve
            })
        }
      },
      async close() {
        ended = true
        wake()
      },
    }
    const channel = serveChannel(transport, f.core, f.owner)
    try {
      push({ kind: 'hello', version: { major: 0, minor: 0 } })
      await vi.advanceTimersByTimeAsync(0)
      push({
        kind: 'request',
        request_id: 'sleep',
        method: 'debugger.v1.sleep',
        params: { debug_session_id: f.id, duration_ms: 60000, wake_on: [] },
      })
      push({ kind: 'request', request_id: 'next', method: 'debugger.v1.policy.get', params: {} })
      await vi.advanceTimersByTimeAsync(0)
      expect(received.some((r) => r.request_id === 'next')).toBe(true)
      await transport.close()
      await vi.advanceTimersByTimeAsync(0)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await transport.close()
      await vi.advanceTimersByTimeAsync(60000)
      await channel
      f.close()
    }
  })
  it('binds the actual provider run rather than model run labels and settles unused grants', async () => {
    vi.useFakeTimers()
    const f = fixture()
    let active = true
    const run = new DebuggerRunBinding(f.core, {
      authority: f.owner,
      run_id: 'run',
      conversation_id: target.conversation_id,
      workspace_id: target.workspace_id,
      active: () => active,
    })
    try {
      expect(
        await run.call('debug_status', { debug_session_id: f.id, run_id: 'other' })
      ).toMatchObject({ code: 'invalid_params' })
      expect(await run.call('debug_status', { debug_session_id: f.id })).toMatchObject({
        snapshot: { execution: 'stopped' },
      })
      const sleep = run.call('debug_sleep', {
        debug_session_id: f.id,
        duration_ms: 60000,
        wake_on: [],
      })
      await vi.advanceTimersByTimeAsync(0)
      active = false
      run.close()
      expect(await sleep).toMatchObject({ reason: 'cancelled', snapshot: null })
      expect(f.control.permissions.grant(f.grant.grant_id).revoked).toBe(true)
      expect(await run.call('debug_status', { debug_session_id: f.id })).toMatchObject({
        snapshot: null,
      })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      run.close()
      f.close()
    }
  })
  it('replays already-matching events, registers atomically and reports gaps', async () => {
    vi.useFakeTimers()
    const f = fixture()
    try {
      const cursor = f.state().event_seq
      f.stop()
      const found = await f.binding.call('debug_wait', {
        debug_session_id: f.id,
        after_event_seq: cursor,
        kinds: ['stopped'],
        timeout_ms: 1000,
      })
      expect(found).toMatchObject({
        reason: 'event',
        event: { kind: 'stopped' },
        snapshot: { execution: 'stopped' },
      })
      const wait = f.binding.call('debug_wait', {
        debug_session_id: f.id,
        after_event_seq: f.state().event_seq,
        kinds: ['continued'],
        timeout_ms: 1000,
      })
      await vi.advanceTimersByTimeAsync(0)
      f.observe({ kind: 'continued', thread_id: 1, all_threads_continued: true })
      expect(await wait).toMatchObject({ reason: 'event', snapshot: { execution: 'running' } })
      for (let i = 0; i < 130; i++)
        f.observe({ kind: 'output', category: 'console', text: 'bounded' })
      expect(
        await f.binding.call('debug_wait', {
          debug_session_id: f.id,
          after_event_seq: cursor,
          kinds: ['stopped'],
          timeout_ms: 1000,
        })
      ).toMatchObject({ code: 'fresh_snapshot_required', snapshot: { execution: 'running' } })
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      f.close()
    }
  })
  it('sleep wakes on state but not output; pure timers do not lock out human steps', async () => {
    vi.useFakeTimers()
    const f = fixture()
    try {
      let effects = 0
      f.control.registerBackend(f.id, {
        supports: () => true,
        dispatch: async (_m, _p, guard) => {
          guard()
          effects++
          f.stop()
          return {}
        },
      })
      const sleep = f.binding.call('debug_sleep', { debug_session_id: f.id, duration_ms: 60000 })
      await vi.advanceTimersByTimeAsync(10)
      f.observe({ kind: 'output', category: 'console', text: 'no wake' })
      await vi.advanceTimersByTimeAsync(10)
      await f.control.command({ kind: 'human', authority: f.owner }, 'step', {
        ...f.args(),
        operation_id: 'human',
        thread_id: 1,
        kind: 'over',
      })
      expect(await sleep).toMatchObject({
        reason: 'event',
        elapsed_ms: 20,
        snapshot: { threads: [{ stop: { hit_breakpoint_ids: ['bp'] } }] },
      })
      const pure = f.binding.call('debug_sleep', {
        debug_session_id: f.id,
        duration_ms: 100,
        wake_on: [],
      })
      await vi.advanceTimersByTimeAsync(50)
      f.stop()
      await vi.advanceTimersByTimeAsync(50)
      expect(await pure).toMatchObject({ reason: 'elapsed', elapsed_ms: 100 })
      expect(effects).toBe(1)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      f.close()
    }
  })
  it.each(['revoke', 'settle', 'disconnect', 'terminate', 'abort', 'expiry'] as const)(
    'settles pure sleep on %s and removes timers',
    async (how) => {
      vi.useFakeTimers()
      const f = fixture()
      try {
        const abort = new AbortController()
        const sleep = f.binding.call(
          'debug_sleep',
          { debug_session_id: f.id, duration_ms: 60000, wake_on: [] },
          abort.signal
        )
        await vi.advanceTimersByTimeAsync(0)
        if (how === 'revoke') f.control.revokeGrant(f.owner, f.grant.grant_id)
        if (how === 'settle') f.binding.close()
        if (how === 'disconnect') f.observe({ kind: 'lifecycle', lifecycle: 'connection-lost' })
        if (how === 'terminate') f.observe({ kind: 'lifecycle', lifecycle: 'terminated' })
        if (how === 'abort') abort.abort()
        if (how === 'expiry') {
          f.control.permissions.setPolicy(f.owner, { max_grant_ms: 1 })
          f.core.db
            .prepare(
              "UPDATE debug_grants SET body=json_set(body,'$.expires_at',?) WHERE grant_id=?"
            )
            .run(new Date(Date.now() + 5).toISOString(), f.grant.grant_id)
          f.control.notifyPermissions()
          await vi.advanceTimersByTimeAsync(5)
        }
        const result = await sleep
        expect(result.reason).toBe(how === 'disconnect' ? 'connection_lost' : 'cancelled')
        if (['revoke', 'settle', 'expiry'].includes(how)) expect(result.snapshot).toBeNull()
        expect(vi.getTimerCount()).toBe(0)
      } finally {
        f.close()
      }
    }
  )
  it('enforces owner-only timer policy, bounds duration and rejects model authority', async () => {
    vi.useFakeTimers()
    const f = fixture()
    try {
      expect(
        await f.binding.call('debug_sleep', { debug_session_id: f.id, duration_ms: 60001 })
      ).toMatchObject({ code: 'invalid_params', snapshot: { execution: 'stopped' } })
      expect(
        await f.binding.call('debug_sleep', {
          debug_session_id: f.id,
          duration_ms: 1,
          grant_id: f.grant.grant_id,
        })
      ).toMatchObject({ code: 'invalid_params' })
      f.control.request(f.owner, 'debugger.v1.policy.set', { sleep_max_ms: 10, sleep_wake_on: [] })
      expect(
        await f.binding.call('debug_sleep', { debug_session_id: f.id, duration_ms: 11 })
      ).toMatchObject({ code: 'sleep_duration_limit' })
      expect(await f.binding.call('debug_policy_set', { sleep_max_ms: 60000 })).toMatchObject({
        code: 'unsupported_method',
        snapshot: null,
      })
      f.control.revokeGrant(f.owner, f.grant.grant_id)
      expect(await f.binding.call('debug_status', { debug_session_id: f.id })).toMatchObject({
        code: 'unauthorized',
        snapshot: null,
      })
    } finally {
      f.close()
    }
  })
  it('scripted agent investigates with fresh state and exact object approval while humans interleave', async () => {
    vi.useFakeTimers()
    const f = fixture()
    try {
      const seen: any[] = []
      f.control.registerBackend(f.id, {
        supports: () => true,
        dispatch: async (m, p, guard) => {
          guard()
          seen.push({ m, p })
          if (m === 'breakpoints.patch')
            f.core.debugger.patchBreakpoints(
              f.id,
              p.expected_breakpoint_revision,
              p.upsert,
              p.remove
            )
          if (m === 'variables')
            return {
              variables: [{ name: 'answer', value: '42' }],
              start: p.start,
              count: p.count,
              depth: p.depth,
            }
          return {}
        },
      })
      const bp = await f.binding.call('debug_breakpoints_patch', {
        ...f.args(),
        expected_breakpoint_revision: 0,
        upsert: [{ breakpoint_id: 'bp', source_id: 'source', line: 2 }],
        remove: [],
      })
      expect(bp.snapshot.breakpoints[0]).toMatchObject({ breakpoint_id: 'bp', status: 'requested' })
      const old = f.args()
      f.stop()
      const stale = await f.binding.call('debug_step', { ...old, thread_id: 1, kind: 'over' })
      expect(stale).toMatchObject({
        outcome: 'rejected',
        code: 'stale_state',
        snapshot: { execution: 'stopped' },
      })
      f.control.setGrantMode(f.owner, f.grant.grant_id, 'ask')
      const handle = f.core.debugger.issueHandle(f.id, 'object', 1, 1)
      const object = await f.binding.call('debug_variables', {
        ...f.args(),
        handle,
        start: 5,
        count: 2,
        depth: 0,
        max_bytes: 100,
      })
      expect(object.outcome).toBe('pending')
      expect(seen.some((s) => s.m === 'variables')).toBe(false)
      await f.control.approve(f.owner, {
        principal_key: f.control.principalKey(f.principal),
        operation_id: object.operation_id,
        proposal_hash: object.proposal_hash,
        decision: 'approve',
      })
      const receipt = await f.binding.call('debug_commandResult', {
        debug_session_id: f.id,
        operation_id: object.operation_id,
      })
      expect(receipt).toMatchObject({
        outcome: 'completed',
        snapshot: { execution: 'stopped' },
        requested: {
          data: { variables: [{ name: 'answer', value: '42' }] },
          payload_status: 'retained',
        },
      })
      const history = await f.binding.call('debug_history', { debug_session_id: f.id })
      expect(
        history.entries.some((e: any) => e.requested_data?.variables?.[0]?.value === '42')
      ).toBe(true)
      expect(seen.find((s) => s.m === 'variables').p).toMatchObject({
        start: 5,
        count: 2,
        depth: 0,
        max_bytes: 100,
      })
      expect(f.binding.current(f.id)?.event_seq).toBe(f.state().event_seq)
    } finally {
      f.close()
    }
  })
})
