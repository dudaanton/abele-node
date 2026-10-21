import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { NodeCore } from '@abele/node-core'
import { target, withCore } from './helpers.js'

const partialStop = {
  kind: 'stopped' as const,
  thread_id: 1,
  all_threads_stopped: false,
  reason: 'pause',
  hit_breakpoint_ids: [],
}

describe('debugger conservative state and migration regressions', () => {
  it('does not call one discovered stopped thread a globally stopped program', () =>
    withCore((core) => {
      const d = core.debugger,
        s = d.create(target)
      expect(d.observe(s.debug_session_id, s.incarnation, partialStop).execution).toBe('unknown')
      expect(d.snapshot(s.debug_session_id).snapshot.threads[0]?.status).toBe('stopped')
      expect(
        d.observe(s.debug_session_id, s.incarnation, { ...partialStop, all_threads_stopped: true })
          .execution
      ).toBe('stopped')
    }, true))
  it('uses explicit all-thread observations for threads discovered afterwards', () =>
    withCore((core) => {
      const d = core.debugger,
        s = d.create(target)
      expect(
        d.observe(s.debug_session_id, s.incarnation, {
          kind: 'continued',
          all_threads_continued: true,
        }).execution
      ).toBe('running')
      const state = d.observe(s.debug_session_id, s.incarnation, {
        kind: 'threads',
        inventory_revision: d.snapshot(s.debug_session_id).snapshot.thread_inventory_revision,
        threads: [
          { id: 1, name: 'one' },
          { id: 2, name: 'two' },
        ],
      })
      expect(state.threads.map((t) => t.status)).toEqual(['running', 'running'])
      expect(d.observe(s.debug_session_id, s.incarnation, partialStop).execution).toBe('mixed')
      const stop = d.observe(s.debug_session_id, s.incarnation, {
        ...partialStop,
        all_threads_stopped: true,
      })
      expect(stop.threads[1]?.stop).toBeNull()
      expect(stop.execution).toBe('stopped')
    }, true))
  it('rejects malformed normalized records without poisoning storage', () =>
    withCore((core) => {
      const d = core.debugger,
        s = d.create(target)
      expect(() =>
        d.observe(s.debug_session_id, s.incarnation, {
          kind: 'continued',
          all_threads_continued: 'yes',
        } as any)
      ).toThrow('invalid_params')
      expect(() =>
        d.observe(s.debug_session_id, s.incarnation, { kind: 'custom_request' } as any)
      ).toThrow('invalid_params')
      expect(d.snapshot(s.debug_session_id).snapshot).toEqual(s)
      expect(d.observe(s.debug_session_id, s.incarnation, partialStop).threads[0]?.status).toBe(
        'stopped'
      )
    }, true))
  it('does not revive a terminal target on a late stop event', () =>
    withCore((core) => {
      const d = core.debugger,
        s = d.create(target)
      d.observe(s.debug_session_id, s.incarnation, { kind: 'lifecycle', lifecycle: 'terminated' })
      expect(() => d.observe(s.debug_session_id, s.incarnation, partialStop)).toThrow(
        'session_not_live'
      )
      expect(d.snapshot(s.debug_session_id).snapshot.lifecycle).toBe('terminated')
    }, true))
  it('replaces targets with a new incarnation and invalidates old handles and replies', () =>
    withCore((core) => {
      const d = core.debugger,
        s = d.create(target)
      d.observe(s.debug_session_id, s.incarnation, partialStop)
      const handle = d.issueHandle(s.debug_session_id, 'frame', 1, 1),
        old = d.snapshot(s.debug_session_id)
      const replaced = d.replaceTarget(s.debug_session_id, { ...target, target_id: 'replacement' })
      expect(replaced.incarnation).not.toBe(s.incarnation)
      expect(replaced.target.target_id).toBe('replacement')
      expect(replaced.execution).toBe('unknown')
      expect(replaced.threads).toEqual([])
      expect(() => d.resolveHandle(s.debug_session_id, handle, 'frame')).toThrow('stale_handle')
      expect(() => d.observe(s.debug_session_id, s.incarnation, partialStop)).toThrow('stale_state')
      expect(d.replay(old.cursor).kind).toBe('fresh_snapshot_required')
    }, true))
  it('migrates v12 additively and keeps ordinary clients and stored chat data working', () =>
    withCore((core, dir) => {
      const token = core.createToken('fixture'),
        actor = core.authority.authenticate(token.token)
      const before = core.request(actor, 'session.create', { title: 'compatibility' }, 'chat-op')
      core.close()
      const db = new DatabaseSync(`${dir}/node.sqlite`)
      db.exec(
        'DROP TABLE debug_operations; DROP TABLE debug_grants; DROP TABLE debug_policy; DROP TABLE debug_history_payloads; DROP TABLE debug_history; DROP TABLE debug_events; DROP TABLE debug_sessions; PRAGMA user_version=12;'
      )
      db.close()
      const next = new NodeCore(dir)
      try {
        expect(Number(next.db.prepare('PRAGMA user_version').get()?.user_version)).toBe(19)
        expect(
          next.request(actor, 'session.create', { title: 'compatibility' }, 'chat-op')
        ).toEqual(before)
        expect(next.capabilities().capabilities).not.toHaveProperty('debugger_v1')
        expect(next.db.prepare('SELECT count(*) AS n FROM debug_sessions').get()?.n).toBe(0)
      } finally {
        next.close()
      }
    }))
  it('preserves terminal lifecycle and requested history when restart happens with capability disabled', () =>
    withCore((core, dir) => {
      const d = core.debugger,
        s = d.create(target)
      d.observe(s.debug_session_id, s.incarnation, { kind: 'lifecycle', lifecycle: 'detached' })
      d.recordHistory(s.debug_session_id, {
        actor: { kind: 'node' },
        operation_id: null,
        operation: 'detach',
        outcome: 'completed',
        requested_data: { source_id: 'source', content_id: 'content' },
      })
      core.close()
      const next = new NodeCore(dir)
      try {
        expect(next.debugger.snapshot(s.debug_session_id).snapshot.lifecycle).toBe('detached')
        expect(next.debugger.history(s.debug_session_id).entries[0]?.requested_data).toEqual({
          source_id: 'source',
          content_id: 'content',
        })
        expect(() => next.debugger.create(target)).toThrow('unsupported_method')
      } finally {
        next.close()
      }
    }, true))
})
