import { randomBytes, randomUUID } from 'node:crypto'
import { ChannelError } from '@abele/channel-protocol'
import {
  DEBUGGER_VERSION,
  DEBUGGER_LIMITS,
  DEBUGGER_V1_CAPABILITY,
  DebuggerSnapshotSchema,
  DebuggerTargetSchema,
  DebuggerCursorSchema,
  DebuggerEventSchema,
  DebuggerObservationSchema,
  DebuggerBreakpointRequestSchema,
  type DebuggerTarget,
  type DebuggerSnapshot,
  type DebuggerCursor,
  type DebuggerReplayResult,
  type DebuggerHistoryInput,
  type DebuggerHistoryEntry,
  type DebuggerBreakpointRequest,
} from '@abele/node-protocol'
import type { NodeCore } from '../index.js'
import type { DebuggerObservation } from './adapter.js'
import { reduceDebugger } from './reducer.js'
import { DebuggerHistoryStore } from './history.js'
import { boundedPayload, boundedText } from './storage.js'
export { migrateDebugger } from './storage.js'
export { reduceDebugger } from './reducer.js'
export type { DebuggerObservation, DebuggerAdapterSink } from './adapter.js'

type Handle = {
  session: string
  incarnation: string
  epoch: number
  kind: 'frame' | 'object'
  reference: number
  thread: number
}
export class DebuggerStateError extends Error {
  constructor(
    readonly code: 'stale_state' | 'stale_handle' | 'not_stopped' | 'stale_breakpoints',
    readonly snapshot: DebuggerSnapshot
  ) {
    super(code)
  }
}

/** Internal infrastructure only. These methods are NOT authorization boundaries
 * and must not be wired directly to RPC/tools; use DebuggerCoordinator.
 * One synchronous node writer commits state + replay evidence atomically. */
export class DebuggerService {
  private readonly handles = new Map<string, Handle>()
  private readonly listeners = new Map<string, Set<() => void>>()
  /** Trusted observation seam. Register synchronously BEFORE replaying a cursor.
   * Listeners see committed rows only; no queue of values is retained. */
  subscribe(session: string, listener: () => void) {
    this.requireEnabled()
    this.load(session)
    const listeners = this.listeners.get(session) ?? new Set<() => void>()
    this.listeners.set(session, listeners)
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.listeners.delete(session)
    }
  }
  private readonly historyStore: DebuggerHistoryStore
  constructor(
    private readonly core: NodeCore,
    readonly enabled = false
  ) {
    this.historyStore = new DebuggerHistoryStore(core)
    this.recover()
  }
  capabilities() {
    return this.enabled ? { debugger_v1: DEBUGGER_V1_CAPABILITY } : {}
  }
  profiles(): never[] {
    return []
  }
  private requireEnabled() {
    if (!this.enabled) throw new ChannelError('unsupported_method')
  }
  /** Internal effect admission; cleanup must not require an available journal. */
  assertEffectsAvailable() {
    this.requireEnabled()
    this.core.assertAuditStorageAvailable()
  }
  private load(session: string): DebuggerSnapshot {
    const row = this.core.db
      .prepare('SELECT body FROM debug_sessions WHERE debug_session_id=?')
      .get(session)
    if (!row) throw new ChannelError('not_found')
    return DebuggerSnapshotSchema.parse(JSON.parse(String(row.body)))
  }
  create(target: DebuggerTarget): DebuggerSnapshot {
    this.requireEnabled()
    const snapshot = DebuggerSnapshotSchema.parse({
      version: DEBUGGER_VERSION,
      debug_session_id: randomUUID(),
      incarnation: randomUUID(),
      state_revision: 0,
      breakpoint_revision: 0,
      event_seq: 0,
      stop_epoch: 0,
      observed_at: new Date().toISOString(),
      target: DebuggerTargetSchema.parse({ ...target, node_id: this.core.node_id }),
      lifecycle: 'configuring',
      execution: 'unknown',
      threads: [],
      thread_inventory: 'unknown',
      thread_inventory_revision: 0,
      all_threads_status: 'unknown',
      selected_thread_id: null,
      selected_frame_handle: null,
      breakpoints: [],
      adapter_capabilities: [],
      pending_approvals: [],
      pending_commands: [],
    })
    this.core.transaction(() =>
      this.core.db
        .prepare('INSERT INTO debug_sessions(debug_session_id,body) VALUES(?,?)')
        .run(snapshot.debug_session_id, JSON.stringify(snapshot))
    )
    return snapshot
  }
  snapshot(session: string): { snapshot: DebuggerSnapshot; cursor: DebuggerCursor } {
    const snapshot = this.load(session)
    return {
      snapshot,
      cursor: {
        debug_session_id: session,
        incarnation: snapshot.incarnation,
        event_seq: snapshot.event_seq,
      },
    }
  }
  observe(
    session: string,
    incarnation: string,
    observation: DebuggerObservation
  ): DebuggerSnapshot {
    this.requireEnabled()
    const previous = this.load(session)
    if (previous.incarnation !== incarnation) throw new DebuggerStateError('stale_state', previous)
    if (['terminated', 'detached', 'failed', 'connection-lost'].includes(previous.lifecycle))
      throw new ChannelError('session_not_live')
    // Lifecycle/target replacement/recovery/intent are node-owned signals, not
    // arbitrary public requests. Only trusted internal drivers call this seam.
    return this.transition(previous, observation)
  }
  replaceTarget(session: string, target: DebuggerTarget): DebuggerSnapshot {
    this.requireEnabled()
    return this.transition(this.load(session), {
      kind: 'target_replaced',
      incarnation: randomUUID(),
      target: DebuggerTargetSchema.parse({ ...target, node_id: this.core.node_id }),
    })
  }
  private transition(previous: DebuggerSnapshot, raw: DebuggerObservation): DebuggerSnapshot {
    const parsed = DebuggerObservationSchema.safeParse(raw)
    if (!parsed.success) throw new ChannelError('invalid_params')
    const observation = parsed.data
    const state = reduceDebugger(previous, observation, new Date().toISOString())
    // Validation and bounds precede the storage transaction: a bad adapter record
    // must not poison the core's audit-storage failure fence.
    let data: unknown = observation
    if (observation.kind === 'output')
      data = {
        category: boundedText(observation.category, 256),
        text: boundedText(observation.text, DEBUGGER_LIMITS.output_bytes),
        truncated: Buffer.byteLength(observation.text) > DEBUGGER_LIMITS.output_bytes,
      }
    const payload = boundedPayload(data, DEBUGGER_LIMITS.event_bytes - 1024)
    const event = DebuggerEventSchema.parse({
      version: DEBUGGER_VERSION,
      debug_session_id: state.debug_session_id,
      incarnation: state.incarnation,
      event_seq: state.event_seq,
      state_revision: state.state_revision,
      breakpoint_revision: state.breakpoint_revision,
      stop_epoch: state.stop_epoch,
      observed_at: state.observed_at,
      kind: observation.kind,
      data: JSON.parse(payload.json!),
      truncated: payload.truncated,
    })
    this.core.transaction(() => {
      this.core.db
        .prepare('UPDATE debug_sessions SET body=? WHERE debug_session_id=?')
        .run(JSON.stringify(state), state.debug_session_id)
      this.core.db
        .prepare('INSERT INTO debug_events VALUES(?,?,?)')
        .run(state.debug_session_id, state.event_seq, JSON.stringify(event))
      this.core.db
        .prepare('DELETE FROM debug_events WHERE debug_session_id=? AND event_seq<=?')
        .run(state.debug_session_id, state.event_seq - DEBUGGER_LIMITS.replay_events)
    })
    if (state.stop_epoch !== previous.stop_epoch || state.incarnation !== previous.incarnation)
      this.expireHandles(state.debug_session_id)
    for (const listener of [...(this.listeners.get(state.debug_session_id) ?? [])]) {
      // Observation publication cannot roll back committed evidence or prevent
      // delivery to the other independent observers.
      try {
        listener()
      } catch {}
    }
    return state
  }
  replay(raw: DebuggerCursor): DebuggerReplayResult {
    const requested = DebuggerCursorSchema.parse(raw)
    const { snapshot, cursor } = this.snapshot(requested.debug_session_id)
    const fresh = (
      reason: 'gap' | 'overflow' | 'incarnation' | 'future'
    ): DebuggerReplayResult => ({ kind: 'fresh_snapshot_required', reason, snapshot, cursor })
    if (requested.incarnation !== snapshot.incarnation) return fresh('incarnation')
    if (requested.event_seq > snapshot.event_seq) return fresh('future')
    if (snapshot.event_seq - requested.event_seq > DEBUGGER_LIMITS.replay_events)
      return fresh('overflow')
    const events = this.core.db
      .prepare(
        'SELECT body FROM debug_events WHERE debug_session_id=? AND event_seq>? AND event_seq<=? ORDER BY event_seq'
      )
      .all(requested.debug_session_id, requested.event_seq, snapshot.event_seq)
      .map((row) => DebuggerEventSchema.parse(JSON.parse(String(row.body))))
    if (
      events.length !== snapshot.event_seq - requested.event_seq ||
      events.some(
        (event, i) =>
          event.event_seq !== requested.event_seq + i + 1 ||
          event.incarnation !== requested.incarnation ||
          event.truncated
      )
    )
      return fresh('gap')
    return { kind: 'events', events, cursor }
  }
  executionIntent(
    session: string,
    incarnation: string,
    revision: number,
    action: 'continue' | 'step' | 'restart' | 'evaluate'
  ): DebuggerSnapshot {
    this.requireEnabled()
    const state = this.load(session)
    if (state.incarnation !== incarnation || state.state_revision !== revision)
      throw new DebuggerStateError('stale_state', state)
    if (['terminated', 'detached', 'failed', 'connection-lost'].includes(state.lifecycle))
      throw new ChannelError('session_not_live')
    return this.transition(state, { kind: 'execution_intent', action })
  }
  patchBreakpoints(
    session: string,
    revision: number,
    upsert: DebuggerBreakpointRequest[],
    remove: string[]
  ): DebuggerSnapshot {
    this.requireEnabled()
    const state = this.load(session)
    if (revision !== state.breakpoint_revision)
      throw new DebuggerStateError('stale_breakpoints', state)
    const checked = upsert.map((bp) => DebuggerBreakpointRequestSchema.parse(bp))
    if (
      new Set(checked.map((bp) => bp.breakpoint_id)).size !== checked.length ||
      remove.length > DEBUGGER_LIMITS.breakpoints ||
      remove.some((id) => typeof id !== 'string' || !id || id.length > 128)
    )
      throw new ChannelError('invalid_params')
    const removed = new Set([...remove, ...checked.map((bp) => bp.breakpoint_id)])
    const proposed = state.breakpoints
      .filter((bp) => !removed.has(bp.breakpoint_id))
      .concat(
        checked.map((bp) => ({
          ...bp,
          status: 'requested' as const,
          resolved_line: null,
          resolved_column: null,
          message: null,
        }))
      )
    if (
      proposed.length > DEBUGGER_LIMITS.breakpoints ||
      Buffer.byteLength(JSON.stringify(proposed)) > DEBUGGER_LIMITS.breakpoint_intent_bytes
    )
      throw new ChannelError('debugger_breakpoint_limit')
    return this.transition(state, { kind: 'breakpoints_patch', revision, upsert: checked, remove })
  }
  issueHandle(session: string, kind: Handle['kind'], reference: number, thread: number): string {
    this.requireEnabled()
    const state = this.load(session)
    if (
      state.lifecycle !== 'active' ||
      state.threads.find((t) => t.thread_id === thread)?.status !== 'stopped'
    )
      throw new DebuggerStateError('not_stopped', state)
    if (!Number.isSafeInteger(reference) || reference < 0) throw new ChannelError('invalid_params')
    if (
      [...this.handles.values()].filter((h) => h.session === session).length >=
      DEBUGGER_LIMITS.handles
    )
      throw new ChannelError('debugger_handle_limit')
    // A 192-bit non-numeric token cannot be mistaken for an adapter's integer
    // reference; its alphabet also never exposes a raw numeric DAP ID.
    const handle = Array.from(randomBytes(24), (byte) =>
      String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15))
    ).join('')
    this.handles.set(handle, {
      session,
      incarnation: state.incarnation,
      epoch: state.stop_epoch,
      kind,
      reference,
      thread,
    })
    return handle
  }
  resolveHandle(session: string, handle: string, kind: Handle['kind']): number {
    const state = this.load(session),
      value = this.handles.get(handle)
    if (
      !value ||
      value.session !== session ||
      value.incarnation !== state.incarnation ||
      value.epoch !== state.stop_epoch ||
      value.kind !== kind
    )
      throw new DebuggerStateError('stale_handle', state)
    if (
      state.lifecycle !== 'active' ||
      state.threads.find((t) => t.thread_id === value.thread)?.status !== 'stopped'
    )
      throw new DebuggerStateError('not_stopped', state)
    return value.reference
  }
  private expireHandles(session: string) {
    for (const [id, value] of this.handles) if (value.session === session) this.handles.delete(id)
  }
  private recover() {
    for (const row of this.core.db.prepare('SELECT body FROM debug_sessions').all()) {
      const state = DebuggerSnapshotSchema.parse(JSON.parse(String(row.body)))
      this.transition(state, { kind: 'recovery', incarnation: randomUUID() })
    }
  }
  /** Node-owned coordinator evidence; never changes execution revision. */
  controlPending(session: string, commands: string[], approvals: string[]) {
    const state = this.load(session)
    if (
      JSON.stringify(state.pending_commands) === JSON.stringify(commands) &&
      JSON.stringify(state.pending_approvals) === JSON.stringify(approvals)
    )
      return
    this.transition(state, { kind: 'control_pending', commands, approvals })
  }
  recordHistory(session: string, raw: DebuggerHistoryInput): DebuggerHistoryEntry {
    this.requireEnabled()
    return this.historyStore.append(this.load(session), raw)
  }
  history(
    session: string,
    after = 0
  ): { entries: DebuggerHistoryEntry[]; truncated_before: number } {
    this.load(session)
    return this.historyStore.read(session, after)
  }
}
