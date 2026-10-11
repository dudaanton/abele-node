import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodeCore } from '@abele/node-core'
import { DebuggerClient } from '@abele/node-client'
import { target } from './helpers.js'

afterEach(() => vi.useRealTimers())
describe('typed debugger client current-state reconciliation', () => {
  it('watches from an atomic cursor outside input, cancels and labels disconnected state last-known', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'debug-client-'))
    const core = new NodeCore(dir, { debuggerEnabled: true })
    const owner = core.authority.authenticate(core.createToken('owner').token)
    const initial = core.debugger.create(target),
      id = initial.debug_session_id
    core.debugger.observe(id, initial.incarnation, { kind: 'lifecycle', lifecycle: 'active' })
    const client = new DebuggerClient(async (m: string, p: unknown) => core.request(owner, m, p))
    const abort = new AbortController(),
      updates: any[] = []
    const watch = client.watch(id, (state: any) => updates.push(state), abort.signal)
    try {
      await vi.advanceTimersByTimeAsync(0)
      core.debugger.observe(id, initial.incarnation, {
        kind: 'stopped',
        thread_id: 1,
        all_threads_stopped: true,
        reason: 'breakpoint',
        hit_breakpoint_ids: ['selected-bp'],
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(updates.at(-1)).toMatchObject({
        observation: 'current',
        snapshot: {
          execution: 'stopped',
          threads: [{ stop: { hit_breakpoint_ids: ['selected-bp'] } }],
        },
      })
      core.debugger.observe(id, initial.incarnation, {
        kind: 'continued',
        thread_id: 1,
        all_threads_continued: true,
      })
      await vi.advanceTimersByTimeAsync(0)
      expect(client.current(id)).toMatchObject({
        observation: 'current',
        snapshot: { execution: 'running' },
      })
      abort.abort()
      await watch
      expect(vi.getTimerCount()).toBe(0)
      client.disconnected()
      expect(client.current(id)).toMatchObject({
        observation: 'last-known',
        snapshot: { execution: 'running' },
      })
    } finally {
      abort.abort()
      await watch
      core.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('does not roll a newer observation back to an out-of-order stop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'debug-client-order-'))
    const core = new NodeCore(dir, { debuggerEnabled: true })
    const initial = core.debugger.create(target),
      id = initial.debug_session_id
    core.debugger.observe(id, initial.incarnation, { kind: 'lifecycle', lifecycle: 'active' })
    core.debugger.observe(id, initial.incarnation, {
      kind: 'stopped',
      thread_id: 1,
      all_threads_stopped: true,
      reason: 'pause',
      hit_breakpoint_ids: [],
    })
    const old = core.debugger.snapshot(id)
    core.debugger.observe(id, initial.incarnation, {
      kind: 'continued',
      thread_id: 1,
      all_threads_continued: true,
    })
    const fresh = core.debugger.snapshot(id)
    const replies: ((result: unknown) => void)[] = []
    const client = new DebuggerClient(() => new Promise((resolve) => replies.push(resolve)))
    try {
      const first = client.status(id),
        second = client.status(id)
      replies[1]!(fresh)
      await second
      replies[0]!(old)
      await first
      expect(client.current(id)).toMatchObject({
        observation: 'current',
        snapshot: { execution: 'running' },
      })
    } finally {
      core.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('does not mark a late snapshot current after disconnect', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'debug-client-late-'))
    const core = new NodeCore(dir, { debuggerEnabled: true })
    const state = core.debugger.create(target)
    let reply!: (result: unknown) => void
    const client = new DebuggerClient(
      () =>
        new Promise((resolve) => {
          reply = resolve
        })
    )
    try {
      const pending = client.status(state.debug_session_id)
      client.disconnected()
      reply(core.debugger.snapshot(state.debug_session_id))
      await pending
      expect(client.current(state.debug_session_id)).toMatchObject({ observation: 'last-known' })
    } finally {
      core.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('labels state last-known after an uncertain command reply and never resends it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'debug-client-uncertain-'))
    const core = new NodeCore(dir, { debuggerEnabled: true })
    const state = core.debugger.create(target),
      calls: string[] = []
    const client = new DebuggerClient(async (method) => {
      calls.push(method)
      if (method === 'debugger.v1.status') return core.debugger.snapshot(state.debug_session_id)
      throw Error('reply_lost')
    })
    try {
      await expect(
        client.command('pause', {
          debug_session_id: state.debug_session_id,
          incarnation: state.incarnation,
          expected_state_revision: 0,
          operation_id: 'stable',
        })
      ).rejects.toThrow('reply_lost')
      expect(client.current(state.debug_session_id)).toMatchObject({ observation: 'last-known' })
      expect(calls).toEqual(['debugger.v1.status', 'debugger.v1.pause'])
    } finally {
      core.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('refreshes before control without silently upgrading a stale proposal or replaying an effect', async () => {
    const calls: string[] = []
    const client = new DebuggerClient(async (m: string) => {
      calls.push(m)
      throw new Error('disconnected')
    })
    await expect(
      client.command('step', {
        debug_session_id: 'selected',
        incarnation: 'known',
        expected_state_revision: 3,
        operation_id: 'stable',
        thread_id: 1,
        kind: 'over',
      })
    ).rejects.toThrow('disconnected')
    expect(calls).toEqual(['debugger.v1.status'])
    expect(client.current('selected')).toMatchObject({ observation: 'unknown', snapshot: null })
  })
})
