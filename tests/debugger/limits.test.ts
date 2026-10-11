import { describe, expect, it } from 'vitest'
import { DEBUGGER_LIMITS, DebuggerSnapshotResultSchema } from '@abele/node-protocol'
import { target, withCore } from './helpers.js'

const stop = {
  kind: 'stopped' as const,
  thread_id: 1,
  all_threads_stopped: true,
  reason: 'pause',
  hit_breakpoint_ids: [],
}

describe('debugger bounds and snapshot invariants', () => {
  it('rejects a mismatched snapshot/replay cursor contract', () =>
    withCore((core) => {
      const s = core.debugger.create(target),
        pair = core.debugger.snapshot(s.debug_session_id)
      expect(DebuggerSnapshotResultSchema.safeParse(pair).success).toBe(true)
      expect(
        DebuggerSnapshotResultSchema.safeParse({
          ...pair,
          cursor: { ...pair.cursor, event_seq: 1 },
        }).success
      ).toBe(false)
      expect(
        DebuggerSnapshotResultSchema.safeParse({
          ...pair,
          cursor: { ...pair.cursor, incarnation: 'old' },
        }).success
      ).toBe(false)
    }, true))
  it('makes incomplete retained metadata require a fresh snapshot', () =>
    withCore((core) => {
      const d = core.debugger,
        s = d.create(target),
        pair = d.snapshot(s.debug_session_id)
      d.observe(s.debug_session_id, s.incarnation, {
        kind: 'threads',
        inventory_revision: d.snapshot(s.debug_session_id).snapshot.thread_inventory_revision,
        threads: Array.from({ length: 256 }, (_, i) => ({ id: i + 1, name: 'x'.repeat(256) })),
      })
      const row = core.db
        .prepare('SELECT body FROM debug_events WHERE debug_session_id=?')
        .get(s.debug_session_id)
      expect(JSON.parse(String(row?.body)).truncated).toBe(true)
      expect(Buffer.byteLength(String(row?.body))).toBeLessThanOrEqual(DEBUGGER_LIMITS.event_bytes)
      expect(d.replay(pair.cursor)).toMatchObject({
        kind: 'fresh_snapshot_required',
        reason: 'gap',
      })
      expect(d.snapshot(s.debug_session_id).snapshot.threads).toHaveLength(256)
    }, true))
  it('caps handles and releases their budget on resume', () =>
    withCore((core) => {
      const d = core.debugger,
        s = d.create(target)
      d.observe(s.debug_session_id, s.incarnation, stop)
      for (let i = 0; i < DEBUGGER_LIMITS.handles; i++)
        d.issueHandle(s.debug_session_id, 'frame', i, 1)
      expect(() => d.issueHandle(s.debug_session_id, 'frame', 2048, 1)).toThrow(
        'debugger_handle_limit'
      )
      d.observe(s.debug_session_id, s.incarnation, {
        kind: 'continued',
        all_threads_continued: true,
      })
      expect(() => d.issueHandle(s.debug_session_id, 'frame', 1, 1)).toThrow('not_stopped')
      d.observe(s.debug_session_id, s.incarnation, stop)
      expect(d.issueHandle(s.debug_session_id, 'frame', 1, 1)).toMatch(/^[a-p]{48}$/)
    }, true))
  it('retains bounded inert requested-data previews with stop metadata and citation sequence', () =>
    withCore((core) => {
      const d = core.debugger,
        s = d.create(target),
        stopped = d.observe(s.debug_session_id, s.incarnation, stop)
      const entry = d.recordHistory(s.debug_session_id, {
        actor: { kind: 'human', principal_id: 'human' },
        operation_id: 'op',
        operation: 'variables',
        outcome: 'completed',
        requested_data: {
          source_id: 'source',
          content_id: 'content',
          value: '\u0000'.repeat(100000),
        },
      })
      expect(entry).toMatchObject({
        event_seq: stopped.event_seq,
        stop_epoch: stopped.stop_epoch,
        stop: { reason: 'pause' },
        payload_status: 'truncated',
      })
      expect(Buffer.byteLength(JSON.stringify(entry.requested_data))).toBeLessThanOrEqual(
        DEBUGGER_LIMITS.payload_bytes
      )
      expect(d.history(s.debug_session_id).entries[0]).toEqual(entry)
    }, true))
  it('validates over-limit and duplicate inputs before committing or fencing storage', () =>
    withCore((core) => {
      const d = core.debugger,
        s = d.create(target)
      expect(() =>
        d.observe(s.debug_session_id, s.incarnation, {
          kind: 'threads',
          inventory_revision: d.snapshot(s.debug_session_id).snapshot.thread_inventory_revision,
          threads: [
            { id: 1, name: 'one' },
            { id: 1, name: 'duplicate' },
          ],
        })
      ).toThrow('debugger_duplicate_thread')
      expect(() =>
        d.patchBreakpoints(
          s.debug_session_id,
          0,
          [
            { breakpoint_id: 'bp', source_id: 'source', line: 1 },
            { breakpoint_id: 'bp', source_id: 'source', line: 2 },
          ],
          []
        )
      ).toThrow('invalid_params')
      expect(d.snapshot(s.debug_session_id).snapshot).toEqual(s)
      expect(d.observe(s.debug_session_id, s.incarnation, stop).execution).toBe('stopped')
    }, true))
})
