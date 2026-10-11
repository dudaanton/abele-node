import { ChannelError } from '@abele/channel-protocol'
import {
  DEBUGGER_LIMITS,
  DebuggerHistoryInputSchema,
  DebuggerHistoryEntrySchema,
  type DebuggerSnapshot,
  type DebuggerHistoryInput,
  type DebuggerHistoryEntry,
} from '@abele/node-protocol'
import type { NodeCore } from '../index.js'
import { nextSequence } from './reducer.js'
import { boundedPayload } from './storage.js'

/** Metadata retention and requested-value retention have separate budgets.
 * No automatic variable capture, raw traffic, receipts or authority live here. */
export class DebuggerHistoryStore {
  constructor(private readonly core: NodeCore) {}
  append(state: DebuggerSnapshot, raw: DebuggerHistoryInput): DebuggerHistoryEntry {
    const input = DebuggerHistoryInputSchema.parse(raw)
    const payload = boundedPayload(input.requested_data, DEBUGGER_LIMITS.payload_bytes)
    const { requested_data: _, ...metadata } = input
    const session = state.debug_session_id
    return this.core.transaction(() => {
      const row = this.core.db
        .prepare('SELECT history_seq FROM debug_sessions WHERE debug_session_id=?')
        .get(session)!
      const seq = nextSequence(Number(row.history_seq))
      const entry = DebuggerHistoryEntrySchema.parse({
        ...metadata,
        debug_session_id: session,
        history_seq: seq,
        event_seq: state.event_seq,
        stop: state.threads.find((t) => t.thread_id === state.selected_thread_id)?.stop ?? null,
        observed_at: new Date().toISOString(),
        incarnation: state.incarnation,
        stop_epoch: state.stop_epoch,
        state_revision: state.state_revision,
        target_id: state.target.target_id,
        build_identity: state.target.build_identity,
        payload_status:
          payload.json === undefined ? 'absent' : payload.truncated ? 'truncated' : 'retained',
      })
      this.core.db
        .prepare('UPDATE debug_sessions SET history_seq=? WHERE debug_session_id=?')
        .run(seq, session)
      this.core.db
        .prepare('INSERT INTO debug_history VALUES(?,?,?)')
        .run(session, seq, JSON.stringify(entry))
      if (payload.json !== undefined)
        this.core.db
          .prepare('INSERT INTO debug_history_payloads VALUES(?,?,?)')
          .run(session, seq, payload.json)
      const evicted = this.core.db
        .prepare(
          'SELECT history_seq FROM debug_history_payloads WHERE debug_session_id=? ORDER BY history_seq DESC LIMIT -1 OFFSET ?'
        )
        .all(session, DEBUGGER_LIMITS.history_payloads)
      for (const row of evicted) {
        this.core.db
          .prepare(
            "UPDATE debug_history SET body=json_set(body,'$.payload_status','expired') WHERE debug_session_id=? AND history_seq=?"
          )
          .run(session, Number(row.history_seq))
        this.core.db
          .prepare('DELETE FROM debug_history_payloads WHERE debug_session_id=? AND history_seq=?')
          .run(session, Number(row.history_seq))
      }
      this.core.db
        .prepare('DELETE FROM debug_history WHERE debug_session_id=? AND history_seq<=?')
        .run(session, seq - DEBUGGER_LIMITS.history_entries)
      return {
        ...entry,
        ...(payload.json === undefined ? {} : { requested_data: JSON.parse(payload.json) }),
      }
    })
  }
  read(session: string, after = 0): { entries: DebuggerHistoryEntry[]; truncated_before: number } {
    if (!Number.isSafeInteger(after) || after < 0) throw new ChannelError('invalid_params')
    const first = this.core.db
      .prepare('SELECT min(history_seq) AS seq FROM debug_history WHERE debug_session_id=?')
      .get(session)
    const entries = this.core.db
      .prepare(
        'SELECT h.body,p.body AS payload FROM debug_history h LEFT JOIN debug_history_payloads p USING(debug_session_id,history_seq) WHERE h.debug_session_id=? AND h.history_seq>? ORDER BY h.history_seq'
      )
      .all(session, after)
      .map((row) =>
        DebuggerHistoryEntrySchema.parse({
          ...JSON.parse(String(row.body)),
          ...(row.payload === null ? {} : { requested_data: JSON.parse(String(row.payload)) }),
        })
      )
    return {
      entries,
      truncated_before: first?.seq === null ? 0 : Math.max(0, Number(first?.seq) - 1),
    }
  }
}
