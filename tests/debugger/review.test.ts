import { describe, expect, it } from 'vitest'
import { FakeAdapter, frame } from './fake-adapter.js'
import { target, withCore } from './helpers.js'

const response = (request: number, ids: number[]) =>
  frame({
    type: 'response',
    command: 'threads',
    request_seq: request,
    success: true,
    body: { threads: ids.map((id) => ({ id, name: `thread-${id}` })) },
  })

// Each scenario was reproduced against the reviewed B1 reducer before its fix.
describe('debugger review regressions', () => {
  it('fences a threads reply against inventory changes after its request', () =>
    withCore((core) => {
      const d = core.debugger,
        s = d.create(target),
        fake = new FakeAdapter(d, s.debug_session_id, s.incarnation)
      fake.feed(response(fake.request('threads'), [1]))
      fake.feed(frame({ type: 'event', event: 'continued', body: { allThreadsContinued: true } }))
      const stale = fake.request('threads')
      fake.feed(frame({ type: 'event', event: 'thread', body: { reason: 'started', threadId: 2 } }))
      fake.feed(
        frame({
          type: 'event',
          event: 'continued',
          body: { threadId: 2, allThreadsContinued: false },
        })
      )
      fake.feed(response(stale, [1]))
      const after = d.snapshot(s.debug_session_id).snapshot
      expect(after.threads.map((t) => t.thread_id)).toEqual([1, 2])
      expect(after.thread_inventory).toBe('unknown')
      fake.feed(
        frame({
          type: 'event',
          event: 'stopped',
          body: { threadId: 1, allThreadsStopped: false, reason: 'pause' },
        })
      )
      expect(d.snapshot(s.debug_session_id).snapshot.execution).toBe('unknown')
      // A newly requested reply can confirm the current inventory. Output does
      // not make that inventory proof stale or alter either thread's status.
      const fresh = fake.request('threads')
      fake.feed(frame({ type: 'event', event: 'output', body: { output: 'fixture' } }))
      fake.feed(response(fresh, [1, 2]))
      expect(d.snapshot(s.debug_session_id).snapshot).toMatchObject({
        thread_inventory: 'complete',
        execution: 'mixed',
      })
    }, true))
  it('does not resurrect an exited thread from an older inventory reply', () =>
    withCore((core) => {
      const d = core.debugger,
        s = d.create(target),
        fake = new FakeAdapter(d, s.debug_session_id, s.incarnation)
      fake.feed(response(fake.request('threads'), [1, 2]))
      const stale = fake.request('threads')
      fake.feed(frame({ type: 'event', event: 'thread', body: { reason: 'exited', threadId: 2 } }))
      fake.feed(response(stale, [1, 2]))
      expect(d.snapshot(s.debug_session_id).snapshot.threads.map((t) => t.thread_id)).toEqual([1])
      expect(d.snapshot(s.debug_session_id).snapshot.thread_inventory).toBe('unknown')
    }, true))
  it.each(['stopped', 'continued'] as const)(
    'fences inventory replies after implicit thread discovery in %s',
    (event) =>
      withCore((core) => {
        const d = core.debugger,
          s = d.create(target),
          fake = new FakeAdapter(d, s.debug_session_id, s.incarnation)
        fake.feed(response(fake.request('threads'), [1]))
        const stale = fake.request('threads')
        fake.feed(
          frame({
            type: 'event',
            event,
            body: {
              threadId: 2,
              allThreadsStopped: false,
              allThreadsContinued: false,
              reason: 'pause',
            },
          })
        )
        fake.feed(response(stale, [1]))
        expect(d.snapshot(s.debug_session_id).snapshot.threads.map((t) => t.thread_id)).toEqual([
          1, 2,
        ])
        expect(d.snapshot(s.debug_session_id).snapshot.thread_inventory).toBe('unknown')
      }, true)
  )
  it('ignores an older out-of-order inventory reply after accepting a newer one', () =>
    withCore((core) => {
      const d = core.debugger,
        s = d.create(target),
        fake = new FakeAdapter(d, s.debug_session_id, s.incarnation)
      const older = fake.request('threads'),
        newer = fake.request('threads')
      fake.feed(response(newer, [1, 2]))
      const before = d.snapshot(s.debug_session_id).snapshot
      fake.feed(response(older, [1]))
      const after = d.snapshot(s.debug_session_id).snapshot
      expect(after.threads).toEqual(before.threads)
      expect(after.thread_inventory).toBe('complete')
      expect(after.state_revision).toBe(before.state_revision)
      expect(after.stop_epoch).toBe(before.stop_epoch)
    }, true))
  it.each([
    ['continued', false],
    ['continued', undefined],
    ['stopped', false],
    ['stopped', undefined],
  ] as const)('makes ambiguous %s (all flag %s) unknown and refuses new handles', (event, flag) =>
    withCore((core) => {
      const d = core.debugger,
        s = d.create(target),
        fake = new FakeAdapter(d, s.debug_session_id, s.incarnation)
      fake.feed(response(fake.request('threads'), [1, 2]))
      fake.feed(
        frame({
          type: 'event',
          event: 'stopped',
          body: { threadId: 1, reason: 'pause', allThreadsStopped: true },
        })
      )
      const handles = [1, 2].map((id) => d.issueHandle(s.debug_session_id, 'frame', id, id))
      if (event === 'stopped')
        fake.feed(frame({ type: 'event', event: 'continued', body: { allThreadsContinued: true } }))
      const body = {
        reason: 'pause',
        ...(flag === undefined
          ? {}
          : event === 'stopped'
            ? { allThreadsStopped: flag }
            : { allThreadsContinued: flag }),
      }
      fake.feed(frame({ type: 'event', event, body }))
      const state = d.snapshot(s.debug_session_id).snapshot
      expect(state.execution).toBe('unknown')
      expect(state.all_threads_status).toBe('unknown')
      expect(state.selected_thread_id).toBeNull()
      expect(state.threads.map((t) => ({ status: t.status, stop: t.stop }))).toEqual([
        { status: 'unknown', stop: null },
        { status: 'unknown', stop: null },
      ])
      for (const handle of handles)
        expect(() => d.resolveHandle(s.debug_session_id, handle, 'frame')).toThrow('stale_handle')
      for (const id of [1, 2])
        expect(() => d.issueHandle(s.debug_session_id, 'frame', id, id)).toThrow('not_stopped')
    }, true)
  )
  it('clears capabilities on target replacement until the new adapter reports them', () =>
    withCore((core) => {
      const d = core.debugger,
        s = d.create(target)
      d.observe(s.debug_session_id, s.incarnation, {
        kind: 'capabilities',
        capabilities: ['step', 'evaluate'],
      })
      const replaced = d.replaceTarget(s.debug_session_id, {
        ...target,
        target_id: 'new-target',
        adapter_profile: 'other-fake',
        adapter_version: 'other-version',
      })
      expect(replaced.adapter_capabilities).toEqual([])
      expect(() =>
        d.observe(s.debug_session_id, s.incarnation, {
          kind: 'capabilities',
          capabilities: ['evaluate'],
        })
      ).toThrow('stale_state')
      expect(
        d.observe(s.debug_session_id, replaced.incarnation, {
          kind: 'capabilities',
          capabilities: ['pause'],
        }).adapter_capabilities
      ).toEqual(['pause'])
    }, true))
})
