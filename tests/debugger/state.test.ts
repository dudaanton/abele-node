import { describe, expect, it } from 'vitest'
import { NodeCore } from '@abele/node-core'
import { DEBUGGER_LIMITS } from '@abele/node-protocol'
import { target, withCore } from './helpers.js'

const threads = {
  kind: 'threads' as const,
  inventory_revision: 0,
  threads: [
    { id: 1, name: 'one' },
    { id: 2, name: 'two' },
  ],
}
const stopped = {
  kind: 'stopped' as const,
  thread_id: 1,
  all_threads_stopped: false,
  reason: 'breakpoint',
  hit_breakpoint_ids: ['bp'],
}

describe('debugger reducer, handles, replay and persistence', () => {
  it('tracks partial stops, execution revision and independent output sequence', () =>
    withCore((core) => {
      const service = core.debugger
      const s = service.create(target)
      service.observe(s.debug_session_id, s.incarnation, threads)
      service.observe(s.debug_session_id, s.incarnation, {
        kind: 'continued',
        all_threads_continued: true,
      })
      const stop = service.observe(s.debug_session_id, s.incarnation, stopped)
      expect(stop.execution).toBe('mixed')
      expect(stop.threads.map((t) => t.status)).toEqual(['stopped', 'running'])
      expect(stop.threads[0]?.stop?.hit_breakpoint_ids).toEqual(['bp'])
      const output = service.observe(s.debug_session_id, s.incarnation, {
        kind: 'output',
        category: 'stdout',
        text: 'hello',
      })
      expect(output.state_revision).toBe(stop.state_revision)
      expect(output.event_seq).toBe(stop.event_seq + 1)
      expect(output.breakpoint_revision).toBe(0)
    }, true))
  it('certifies a stop on a known thread by a list of the same threads, leaving the stop as it was', () =>
    withCore((core) => {
      const d = core.debugger
      const s = d.create(target)
      d.observe(s.debug_session_id, s.incarnation, {
        kind: 'thread',
        thread_id: 7,
        reason: 'started',
      })
      const stop = d.observe(s.debug_session_id, s.incarnation, {
        ...stopped,
        thread_id: 7,
        hit_breakpoint_ids: [],
      })
      expect(stop.execution).toBe('unknown')
      const listed = d.observe(s.debug_session_id, s.incarnation, {
        kind: 'threads',
        inventory_revision: stop.thread_inventory_revision,
        threads: [{ id: 7, name: 'Main Thread' }],
      })
      expect(listed.execution).toBe('stopped')
      expect(listed.thread_inventory).toBe('complete')
      expect(listed.threads[0]?.name).toBe('Main Thread')
      expect(listed.stop_epoch).toBe(stop.stop_epoch)
      expect(listed.state_revision).toBe(stop.state_revision)
      // A list that differs is a change of what runs, as before.
      const more = d.observe(s.debug_session_id, s.incarnation, {
        kind: 'threads',
        inventory_revision: listed.thread_inventory_revision,
        threads: [
          { id: 7, name: 'Main Thread' },
          { id: 8, name: 'worker' },
        ],
      })
      expect(more.stop_epoch).toBeGreaterThan(listed.stop_epoch)
    }, true))
  it('treats missing/unknown threads conservatively and clears resumed stop metadata', () =>
    withCore((core) => {
      const d = core.debugger
      const s = d.create(target)
      d.observe(s.debug_session_id, s.incarnation, threads)
      expect(d.observe(s.debug_session_id, s.incarnation, stopped).execution).toBe('unknown')
      const continued = d.observe(s.debug_session_id, s.incarnation, {
        kind: 'continued',
        thread_id: 1,
        all_threads_continued: false,
      })
      expect(continued.threads[0]?.stop).toBeNull()
      expect(continued.selected_thread_id).toBeNull()
    }, true))
  it('binds opaque handles to session/incarnation/stop and expires on resume or step', () =>
    withCore((core) => {
      const d = core.debugger
      const s = d.create(target)
      const other = d.create(target)
      d.observe(s.debug_session_id, s.incarnation, stopped)
      const handle = d.issueHandle(s.debug_session_id, 'frame', 42, 1)
      expect(handle).not.toContain('42')
      expect(d.resolveHandle(s.debug_session_id, handle, 'frame')).toBe(42)
      expect(() => d.resolveHandle(other.debug_session_id, handle, 'frame')).toThrow('stale_handle')
      expect(() => d.resolveHandle(s.debug_session_id, handle, 'object')).toThrow('stale_handle')
      d.executionIntent(
        s.debug_session_id,
        s.incarnation,
        d.snapshot(s.debug_session_id).snapshot.state_revision,
        'step'
      )
      expect(() => d.resolveHandle(s.debug_session_id, handle, 'frame')).toThrow('stale_handle')
      d.observe(s.debug_session_id, s.incarnation, stopped)
      const next = d.issueHandle(s.debug_session_id, 'object', 99, 1)
      d.observe(s.debug_session_id, s.incarnation, {
        kind: 'continued',
        all_threads_continued: true,
      })
      expect(() => d.resolveHandle(s.debug_session_id, next, 'object')).toThrow('stale_handle')
    }, true))
  it('rejects stale execution/incarnation explicitly without invalidating a current handle', () =>
    withCore((core) => {
      const d = core.debugger
      const s = d.create(target)
      const stop = d.observe(s.debug_session_id, s.incarnation, stopped)
      const handle = d.issueHandle(s.debug_session_id, 'frame', 1, 1)
      for (const [incarnation, revision] of [
        ['old', stop.state_revision],
        [s.incarnation, 0],
      ] as const) {
        try {
          d.executionIntent(s.debug_session_id, incarnation, revision, 'continue')
          expect.fail('accepted stale command')
        } catch (error) {
          expect(error).toMatchObject({
            code: 'stale_state',
            snapshot: { state_revision: stop.state_revision },
          })
        }
      }
      expect(d.resolveHandle(s.debug_session_id, handle, 'frame')).toBe(1)
    }, true))
  it('provides atomic snapshot/cursor and demands a fresh snapshot on gaps or overflow', () =>
    withCore((core) => {
      const d = core.debugger
      const s = d.create(target)
      const pair = d.snapshot(s.debug_session_id)
      expect(pair.cursor.event_seq).toBe(pair.snapshot.event_seq)
      d.observe(s.debug_session_id, s.incarnation, stopped)
      const replay = d.replay(pair.cursor)
      expect(replay.kind).toBe('events')
      if (replay.kind === 'events')
        expect(replay.events[0]?.event_seq).toBe(pair.cursor.event_seq + 1)
      expect(d.replay({ ...pair.cursor, event_seq: 999 }).kind).toBe('fresh_snapshot_required')
      expect(d.replay({ ...pair.cursor, incarnation: 'old' }).kind).toBe('fresh_snapshot_required')
      for (let i = 0; i < DEBUGGER_LIMITS.replay_events + 2; i++)
        d.observe(s.debug_session_id, s.incarnation, {
          kind: 'output',
          text: 'x'.repeat(20000),
          category: 'stdout',
        })
      expect(d.replay(pair.cursor).kind).toBe('fresh_snapshot_required')
      const current = d.snapshot(s.debug_session_id)
      expect(d.replay(current.cursor)).toMatchObject({ kind: 'events', events: [] })
      const count = core.db.prepare('SELECT count(*) AS n FROM debug_events').get() as { n: number }
      expect(count.n).toBeLessThanOrEqual(DEBUGGER_LIMITS.replay_events)
      const event = JSON.parse(
        String(
          core.db.prepare('SELECT body FROM debug_events ORDER BY event_seq DESC LIMIT 1').get()
            ?.body
        )
      )
      expect(event.data.truncated).toBe(true)
      expect(Buffer.byteLength(event.data.text)).toBeLessThanOrEqual(DEBUGGER_LIMITS.output_bytes)
    }, true))
  it('detects a missing event inside retained replay', () =>
    withCore((core) => {
      const d = core.debugger
      const s = d.create(target)
      const pair = d.snapshot(s.debug_session_id)
      d.observe(s.debug_session_id, s.incarnation, stopped)
      d.observe(s.debug_session_id, s.incarnation, {
        kind: 'output',
        text: 'x',
        category: 'stdout',
      })
      core.db.prepare('DELETE FROM debug_events WHERE event_seq=?').run(pair.cursor.event_seq + 1)
      expect(d.replay(pair.cursor).kind).toBe('fresh_snapshot_required')
    }, true))
  it('stores requested/verified/relocated/rejected/pending intent and ignores superseded replies', () =>
    withCore((core) => {
      const d = core.debugger
      const s = d.create(target)
      const first = d.patchBreakpoints(
        s.debug_session_id,
        0,
        [{ breakpoint_id: 'bp', source_id: 'source', line: 4 }],
        []
      )
      expect(first.breakpoints[0]?.status).toBe('requested')
      d.observe(s.debug_session_id, s.incarnation, { kind: 'breakpoints_pending', revision: 1 })
      expect(d.snapshot(s.debug_session_id).snapshot.breakpoints[0]?.status).toBe('pending')
      d.observe(s.debug_session_id, s.incarnation, {
        kind: 'breakpoints_result',
        revision: 1,
        results: [{ breakpoint_id: 'bp', verified: true, line: 5 }],
      })
      expect(d.snapshot(s.debug_session_id).snapshot.breakpoints[0]).toMatchObject({
        status: 'relocated',
        line: 4,
        resolved_line: 5,
      })
      const second = d.patchBreakpoints(
        s.debug_session_id,
        1,
        [{ breakpoint_id: 'bp', source_id: 'source', line: 6 }],
        []
      )
      expect(second.state_revision).toBe(first.state_revision)
      d.observe(s.debug_session_id, s.incarnation, {
        kind: 'breakpoints_result',
        revision: 1,
        results: [{ breakpoint_id: 'bp', verified: true, line: 5 }],
      })
      expect(d.snapshot(s.debug_session_id).snapshot.breakpoints[0]?.status).toBe('requested')
      d.observe(s.debug_session_id, s.incarnation, {
        kind: 'breakpoints_result',
        revision: 2,
        results: [{ breakpoint_id: 'bp', verified: false, message: 'unavailable' }],
      })
      expect(d.snapshot(s.debug_session_id).snapshot.breakpoints[0]?.status).toBe('rejected')
      d.observe(s.debug_session_id, s.incarnation, {
        kind: 'breakpoints_result',
        revision: 2,
        results: [{ breakpoint_id: 'bp', verified: true, line: 6 }],
      })
      expect(d.snapshot(s.debug_session_id).snapshot.breakpoints[0]?.status).toBe('verified')
      expect(() => d.patchBreakpoints(s.debug_session_id, 1, [], ['bp'])).toThrow(
        'stale_breakpoints'
      )
    }, true))
  it('recovers history but never restores a cached stop as live or reuses handles', () =>
    withCore((core, dir) => {
      const d = core.debugger
      const s = d.create(target)
      d.observe(s.debug_session_id, s.incarnation, stopped)
      const handle = d.issueHandle(s.debug_session_id, 'frame', 42, 1)
      const cursor = d.snapshot(s.debug_session_id).cursor
      d.recordHistory(s.debug_session_id, {
        actor: { kind: 'human', principal_id: 'owner' },
        operation_id: 'op',
        operation: 'variables',
        outcome: 'completed',
        requested_data: { value: 2 },
      })
      core.close()
      const next = new NodeCore(dir, { debuggerEnabled: true })
      try {
        const state = next.debugger.snapshot(s.debug_session_id).snapshot
        expect(state.lifecycle).toBe('connection-lost')
        expect(state.execution).toBe('unknown')
        expect(state.threads.every((t) => t.status === 'unknown' && t.stop === null)).toBe(true)
        expect(state.incarnation).not.toBe(s.incarnation)
        expect(next.debugger.replay(cursor).kind).toBe('fresh_snapshot_required')
        expect(() => next.debugger.resolveHandle(s.debug_session_id, handle, 'frame')).toThrow(
          'stale_handle'
        )
        expect(next.debugger.history(s.debug_session_id).entries[0]?.operation_id).toBe('op')
        expect(() => next.debugger.observe(s.debug_session_id, s.incarnation, stopped)).toThrow(
          'stale_state'
        )
      } finally {
        next.close()
      }
    }, true))
  it('bounds history metadata and requested data independently with explicit payload expiry', () =>
    withCore((core) => {
      const d = core.debugger
      const s = d.create(target)
      const record = () =>
        d.recordHistory(s.debug_session_id, {
          actor: { kind: 'agent', principal_id: 'agent', run_id: 'run' },
          operation_id: 'op',
          operation: 'variables',
          outcome: 'completed',
          requested_data: 'é'.repeat(20000),
        })
      const first = record()
      expect(first.payload_status).toBe('truncated')
      expect(Buffer.byteLength(JSON.stringify(first.requested_data))).toBeLessThanOrEqual(
        DEBUGGER_LIMITS.payload_bytes
      )
      for (let i = 0; i < DEBUGGER_LIMITS.history_payloads; i++) record()
      const page = d.history(s.debug_session_id)
      expect(page.entries.find((e) => e.history_seq === first.history_seq)?.payload_status).toBe(
        'expired'
      )
      for (let i = 0; i < DEBUGGER_LIMITS.history_entries; i++) record()
      expect(d.history(s.debug_session_id).entries.length).toBe(DEBUGGER_LIMITS.history_entries)
      expect(d.history(s.debug_session_id, 0).truncated_before).toBeGreaterThan(0)
    }, true))
  it('rolls back snapshot and event together on audit failure', () =>
    withCore((core) => {
      const d = core.debugger
      const s = d.create(target)
      core.db.exec(
        "CREATE TRIGGER debug_failure BEFORE INSERT ON debug_events BEGIN SELECT RAISE(FAIL, 'fixture_storage_failure'); END;"
      )
      expect(() => d.observe(s.debug_session_id, s.incarnation, stopped)).toThrow(
        'fixture_storage_failure'
      )
      expect(d.snapshot(s.debug_session_id).snapshot).toEqual(s)
      expect(() =>
        d.executionIntent(s.debug_session_id, s.incarnation, s.state_revision, 'step')
      ).toThrow('storage_unavailable')
    }, true))
})
