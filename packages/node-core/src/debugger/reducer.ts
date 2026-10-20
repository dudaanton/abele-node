import {
  DebuggerSnapshotSchema,
  DEBUGGER_LIMITS,
  type DebuggerSnapshot,
} from '@abele/node-protocol'
import type { DebuggerObservation } from './adapter.js'

export function nextSequence(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value === Number.MAX_SAFE_INTEGER)
    throw new Error('debugger_sequence_exhausted')
  return value + 1
}

function aggregate(state: DebuggerSnapshot): DebuggerSnapshot['execution'] {
  const { threads, all_threads_status, thread_inventory } = state
  if (all_threads_status !== 'unknown') return all_threads_status
  if (
    thread_inventory !== 'complete' ||
    !threads.length ||
    threads.some((t) => t.status === 'unknown')
  )
    return 'unknown'
  const stopped = threads.filter((t) => t.status === 'stopped').length
  return stopped === threads.length ? 'stopped' : stopped === 0 ? 'running' : 'mixed'
}

/** Pure state transition. event_seq orders observations; state_revision fences
 * execution only. Output and breakpoint replies cannot invalidate a step. */
export function reduceDebugger(
  previous: DebuggerSnapshot,
  event: DebuggerObservation,
  at: string
): DebuggerSnapshot {
  const state = structuredClone(previous)
  state.event_seq = nextSequence(state.event_seq)
  state.observed_at = at
  const expire = () => {
    state.stop_epoch = nextSequence(state.stop_epoch)
    state.selected_frame_handle = null
  }
  const executionChanged = () => {
    state.state_revision = nextSequence(state.state_revision)
    expire()
  }
  const unknown = () => {
    state.all_threads_status = 'unknown'
    for (const thread of state.threads) {
      thread.status = 'unknown'
      thread.stop = null
    }
    state.selected_thread_id = null
  }
  const inventoryChanged = () => {
    state.thread_inventory_revision = nextSequence(state.thread_inventory_revision)
    state.thread_inventory = 'unknown'
  }
  const thread = (id: number) => {
    let found = state.threads.find((t) => t.thread_id === id)
    if (!found) {
      if (state.threads.length >= DEBUGGER_LIMITS.threads) throw new Error('debugger_thread_limit')
      found = { thread_id: id, name: '', status: state.all_threads_status, stop: null }
      state.threads.push(found)
      inventoryChanged()
    }
    return found
  }
  switch (event.kind) {
    case 'build_identity':
      if (state.target.build_identity !== event.build_identity) {
        state.target.build_identity = event.build_identity
        executionChanged()
      }
      break
    case 'control_pending':
      state.pending_commands = event.commands
      state.pending_approvals = event.approvals
      break
    case 'output':
      break
    case 'capabilities':
      state.adapter_capabilities = event.capabilities
      break
    case 'threads': {
      const ids = event.threads.map((t) => t.id)
      if (new Set(ids).size !== ids.length) throw new Error('debugger_duplicate_thread')
      // Correlate against inventory at request time, not receipt time. A stale
      // reply cannot remove newly discovered threads or certify completeness.
      if (event.inventory_revision !== state.thread_inventory_revision) break
      const known = state.threads.map((t) => t.thread_id)
      if (ids.length === known.length && ids.every((id) => known.includes(id))) {
        // The same threads, now certified complete: nothing ran or stopped, so a stop and its
        // handles stay what they were.
        for (const t of event.threads)
          state.threads.find((x) => x.thread_id === t.id)!.name = t.name
        state.thread_inventory = 'complete'
        break
      }
      state.threads = event.threads.map((t) => ({
        ...(state.threads.find((old) => old.thread_id === t.id) ?? {
          status: state.all_threads_status,
          stop: null,
        }),
        thread_id: t.id,
        name: t.name,
      }))
      // Also fence other in-flight replies captured before this accepted list.
      inventoryChanged()
      state.thread_inventory = 'complete'
      if (!state.threads.some((t) => t.thread_id === state.selected_thread_id))
        state.selected_thread_id = null
      executionChanged()
      break
    }
    case 'thread':
      if (event.reason === 'exited') {
        inventoryChanged()
        state.threads = state.threads.filter((t) => t.thread_id !== event.thread_id)
        if (state.selected_thread_id === event.thread_id) state.selected_thread_id = null
      } else {
        if (state.threads.some((t) => t.thread_id === event.thread_id)) inventoryChanged()
        state.all_threads_status = 'unknown'
        const started = thread(event.thread_id)
        started.status = 'unknown'
        started.stop = null
      }
      executionChanged()
      break
    case 'stop_details': {
      const stopped = state.threads.find((t) => t.thread_id === event.thread_id)
      if (event.stop_epoch === state.stop_epoch && stopped?.status === 'stopped' && stopped.stop) {
        stopped.stop.description = event.description
        if (event.reason !== undefined) stopped.stop.reason = event.reason
      }
      break
    }
    case 'stopped': {
      state.lifecycle = 'active'
      if (event.thread_id === undefined && !event.all_threads_stopped) unknown()
      if (event.thread_id !== undefined) thread(event.thread_id)
      for (const t of state.threads) {
        if (event.all_threads_stopped || t.thread_id === event.thread_id) {
          t.status = 'stopped'
          // The reason/location/hits describe the reporting thread, not all threads.
          t.stop =
            t.thread_id === event.thread_id
              ? {
                  reason: event.reason,
                  ...(event.description === undefined ? {} : { description: event.description }),
                  hit_breakpoint_ids: event.hit_breakpoint_ids,
                  location: event.location ?? null,
                }
              : null
        }
      }
      state.all_threads_status = event.all_threads_stopped ? 'stopped' : 'unknown'
      state.selected_thread_id = event.thread_id ?? null
      executionChanged()
      break
    }
    case 'continued':
      state.lifecycle = 'active'
      if (event.thread_id === undefined && !event.all_threads_continued) unknown()
      if (event.thread_id !== undefined) thread(event.thread_id)
      for (const t of state.threads)
        if (event.all_threads_continued || t.thread_id === event.thread_id) {
          t.status = 'running'
          t.stop = null
        }
      state.all_threads_status = event.all_threads_continued ? 'running' : 'unknown'
      if (event.all_threads_continued || state.selected_thread_id === event.thread_id)
        state.selected_thread_id = null
      executionChanged()
      break
    case 'execution_intent':
      // An accepted dispatch intent is not proof of running. Fence handles now,
      // even if the adapter fails or an effectful expression never sends an event.
      unknown()
      if (event.action === 'restart') {
        state.lifecycle = 'configuring'
        inventoryChanged()
      }
      executionChanged()
      break
    case 'invalidated':
      inventoryChanged()
      unknown()
      executionChanged()
      break
    case 'exited':
      break
    case 'lifecycle':
      state.lifecycle = event.lifecycle
      unknown()
      state.pending_commands = []
      state.pending_approvals = []
      executionChanged()
      break
    case 'target_replaced':
      state.target = event.target
      state.adapter_capabilities = []
      state.threads = []
      state.lifecycle = 'configuring'
    // Target replacement has the same handle/identity fence as node recovery.
    case 'recovery':
      inventoryChanged()
      state.incarnation = event.incarnation
      if (
        event.kind === 'recovery' &&
        !['terminated', 'detached', 'failed'].includes(state.lifecycle)
      )
        state.lifecycle = 'connection-lost'
      unknown()
      state.pending_commands = []
      state.pending_approvals = []
      for (const bp of state.breakpoints) {
        bp.status = 'pending'
        bp.resolved_line = null
        bp.resolved_column = null
      }
      executionChanged()
      break
    case 'breakpoints_patch': {
      if (event.revision !== state.breakpoint_revision) throw new Error('stale_breakpoints')
      const remove = new Set([...event.remove, ...event.upsert.map((bp) => bp.breakpoint_id)])
      state.breakpoints = state.breakpoints
        .filter((bp) => !remove.has(bp.breakpoint_id))
        .concat(
          event.upsert.map((bp) => ({
            ...bp,
            status: 'requested' as const,
            resolved_line: null,
            resolved_column: null,
            message: null,
          }))
        )
      state.breakpoint_revision = nextSequence(state.breakpoint_revision)
      break
    }
    case 'breakpoints_pending':
      if (event.revision === state.breakpoint_revision)
        for (const bp of state.breakpoints) bp.status = 'pending'
      break
    case 'breakpoints_result':
      if (event.revision !== state.breakpoint_revision) break
      for (const result of event.results) {
        const bp = state.breakpoints.find((bp) => bp.breakpoint_id === result.breakpoint_id)
        if (!bp) continue
        bp.resolved_line = result.line ?? null
        bp.resolved_column = result.column ?? null
        bp.message = result.message ?? null
        bp.status = !result.verified
          ? 'rejected'
          : (result.line !== undefined && result.line !== bp.line) ||
              (result.column !== undefined &&
                bp.column !== undefined &&
                result.column !== bp.column)
            ? 'relocated'
            : 'verified'
      }
      break
  }
  state.execution = aggregate(state)
  return DebuggerSnapshotSchema.parse(state)
}
