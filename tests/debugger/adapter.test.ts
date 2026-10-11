import { describe, expect, it } from 'vitest'
import { FakeAdapter, frame } from './fake-adapter.js'
import { target, withCore } from './helpers.js'

describe('DAP-shaped fake adapter seam', () => {
  it('reduces byte-fragmented UTF-8 frames and multiple events in a frame batch', () =>
    withCore((core) => {
      const d = core.debugger,
        s = d.create(target),
        fake = new FakeAdapter(d, s.debug_session_id, s.incarnation)
      const cursor = d.snapshot(s.debug_session_id).cursor
      const stream = Buffer.concat([
        frame({
          seq: 1,
          type: 'event',
          event: 'stopped',
          body: {
            threadId: 1,
            reason: 'breakpoint',
            allThreadsStopped: false,
            hitBreakpointIds: [7],
          },
        }),
        frame({
          seq: 2,
          type: 'event',
          event: 'output',
          body: { output: 'héllo 🌲', category: 'stdout' },
        }),
      ])
      for (const byte of stream) fake.feed(Uint8Array.of(byte))
      const result = d.replay(cursor)
      expect(result.kind).toBe('events')
      if (result.kind === 'events')
        expect(result.events[1]?.data).toMatchObject({ text: 'héllo 🌲', truncated: false })
      expect(d.snapshot(s.debug_session_id).snapshot.threads[0]?.stop?.hit_breakpoint_ids).toEqual([
        '7',
      ])
    }, true))
  it('correlates out-of-order responses and ignores superseded breakpoint results', () =>
    withCore((core) => {
      const d = core.debugger,
        s = d.create(target),
        fake = new FakeAdapter(d, s.debug_session_id, s.incarnation)
      d.patchBreakpoints(
        s.debug_session_id,
        0,
        [{ breakpoint_id: 'bp', source_id: 'source', line: 4 }],
        []
      )
      const first = fake.request('setBreakpoints', { revision: 1, ids: ['bp'] })
      d.patchBreakpoints(
        s.debug_session_id,
        1,
        [{ breakpoint_id: 'bp', source_id: 'source', line: 9 }],
        []
      )
      const second = fake.request('setBreakpoints', { revision: 2, ids: ['bp'] })
      const threads = fake.request('threads')
      fake.feed(
        Buffer.concat([
          frame({
            seq: 9,
            type: 'response',
            request_seq: threads,
            command: 'threads',
            success: true,
            body: {
              threads: [
                { id: 1, name: 'one' },
                { id: 2, name: 'two' },
              ],
            },
          }),
          frame({
            seq: 10,
            type: 'response',
            request_seq: second,
            command: 'setBreakpoints',
            success: true,
            body: { breakpoints: [{ verified: true, line: 9 }] },
          }),
          frame({
            seq: 11,
            type: 'response',
            request_seq: first,
            command: 'setBreakpoints',
            success: true,
            body: { breakpoints: [{ verified: true, line: 5 }] },
          }),
          frame({
            seq: 12,
            type: 'event',
            event: 'continued',
            body: { allThreadsContinued: true },
          }),
          frame({
            seq: 13,
            type: 'event',
            event: 'stopped',
            body: { threadId: 2, allThreadsStopped: false, reason: 'pause' },
          }),
        ])
      )
      const state = d.snapshot(s.debug_session_id).snapshot
      expect(state.execution).toBe('mixed')
      expect(state.breakpoints[0]).toMatchObject({ status: 'verified', line: 9, resolved_line: 9 })
      const handle = d.issueHandle(s.debug_session_id, 'frame', 99, 2)
      fake.feed(frame({ seq: 14, type: 'event', event: 'invalidated' }))
      expect(() => d.resolveHandle(s.debug_session_id, handle, 'frame')).toThrow('stale_handle')
    }, true))
  it('bounds floods without corrupting the execution revision or another session', () =>
    withCore((core) => {
      const d = core.debugger,
        s = d.create(target),
        isolated = d.create(target),
        fake = new FakeAdapter(d, s.debug_session_id, s.incarnation)
      fake.feed(frame({ type: 'event', event: 'stopped', body: { threadId: 1, reason: 'pause' } }))
      const stopped = d.snapshot(s.debug_session_id)
      for (let i = 0; i < 150; i++)
        fake.feed(frame({ type: 'event', event: 'output', body: { output: '🌲'.repeat(10000) } }))
      expect(d.replay(stopped.cursor).kind).toBe('fresh_snapshot_required')
      expect(d.snapshot(s.debug_session_id).snapshot.state_revision).toBe(
        stopped.snapshot.state_revision
      )
      expect(d.snapshot(isolated.debug_session_id).snapshot).toEqual(isolated)
      const latest = d.replay({
        ...stopped.cursor,
        event_seq: d.snapshot(s.debug_session_id).snapshot.event_seq - 1,
      })
      if (latest.kind === 'events') expect(JSON.stringify(latest.events)).not.toContain('�')
    }, true))
  it.each([
    ['invalid header', Buffer.from('Content-Length: nope\r\n\r\n'), 'fake_invalid_header'],
    ['oversized frame', Buffer.from('Content-Length: 999999\r\n\r\n'), 'fake_frame_limit'],
    [
      'reverse request',
      frame({ type: 'request', command: 'runInTerminal' }),
      'fake_reverse_request_denied',
    ],
    [
      'uncorrelated response',
      frame({ type: 'response', request_seq: 999, command: 'threads' }),
      'fake_uncorrelated_response',
    ],
    ['malformed JSON', Buffer.from('Content-Length: 1\r\n\r\n{'), 'JSON'],
  ])('rejects %s without changing node state', (_, bytes, error) =>
    withCore((core) => {
      const s = core.debugger.create(target),
        fake = new FakeAdapter(core.debugger, s.debug_session_id, s.incarnation)
      expect(() => fake.feed(bytes)).toThrow(error)
      expect(core.debugger.snapshot(s.debug_session_id).snapshot).toEqual(s)
    }, true)
  )
})
