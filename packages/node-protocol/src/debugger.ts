import { z } from 'zod'
import { ExecutionTargetSchema } from './turn.js'

export const DebuggerOwnerShape = {
  conversation_id: z.string().min(1).max(128).optional(),
  folder: ExecutionTargetSchema.optional(),
}
export const hasDebuggerOwner = (p: { conversation_id?: string; folder?: unknown }) =>
  !!(p.conversation_id || p.folder)

/** Opt-in infrastructure contract, not a publicly enabled control API. */
export const DEBUGGER_VERSION = 'debugger.v1' as const
export const DEBUGGER_LIMITS = Object.freeze({
  threads: 256,
  breakpoints: 256,
  replay_events: 128,
  output_bytes: 4096,
  event_bytes: 65536,
  history_entries: 128,
  history_payloads: 16,
  payload_bytes: 8192,
  handles: 1024,
  pending_commands: 128,
  command_bytes: 16384,
  approval_page_bytes: 65536,
  breakpoint_intent_bytes: 65536,
  durable_receipts: 10000,
  grants: 10000,
})
export const DEBUGGER_V1_CAPABILITY = Object.freeze({
  status: 'supported' as const,
  breakpoint_hit_condition: true,
  breakpoint_enabled: true,
  launch_stop_on_entry: true,
  launch_preflight: true,
  evaluate_watch: true,
  persisted_sources: true,
  source_runtime_admission: true,
  session_exit_reconciliation: true,
  exit_code: true,
  stop_exception_text: true,
  frame_source_paths: true,
  attach_breakpoint_restore: true,
  step_stop_reason: true,
  session_started_at: true,
  breakpoint_locations: true,
  source_breakable_lines: true,
  evidence:
    'debugger.v1-contracts; bounded-state-and-history; bounded-dap; js-profile-pinned; authorized-shared-control',
})
const id = z.string().min(1).max(128)
const seq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const threadId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const line = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const session = { debug_session_id: id }
const precondition = { ...session, incarnation: id, expected_state_revision: seq }
const effect = { ...precondition, operation_id: id }
export const DebuggerTargetSchema = z
  .object({
    node_id: id,
    project_id: id,
    workspace_id: id.nullable(),
    worktree_id: id,
    conversation_id: id.nullable(),
    target_id: id,
    adapter_profile: id,
    adapter_version: id,
    launch_configuration_id: id,
    process_ownership: z.enum(['unknown', 'owned', 'external']),
    process_evidence: z
      .object({
        pid: threadId,
        ownership_id: id,
        start_identity: z.string().min(1).max(256),
        executable_sha256: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .optional(),
    build_identity: z.enum(['unknown', 'matched', 'mismatched']),
  })
  .strict()
export type DebuggerTarget = z.infer<typeof DebuggerTargetSchema>
export const DebuggerSourceLocationSchema = z
  .object({ source_id: id, line, column: line.optional() })
  .strict()
export const DebuggerStopSchema = z
  .object({
    reason: z.string().min(1).max(256),
    description: z.string().max(4096).optional(),
    hit_breakpoint_ids: z.array(id).max(DEBUGGER_LIMITS.breakpoints),
    location: DebuggerSourceLocationSchema.nullable(),
  })
  .strict()
export const DebuggerThreadSchema = z
  .object({
    thread_id: threadId,
    name: z.string().max(256),
    status: z.enum(['running', 'stopped', 'unknown']),
    stop: DebuggerStopSchema.nullable(),
  })
  .strict()
export const DebuggerBreakpointRequestSchema = z
  .object({
    breakpoint_id: id,
    source_id: id,
    line,
    column: line.optional(),
    condition: z.string().min(1).max(8192).optional(),
    hit_condition: z.string().min(1).max(8192).optional(),
    enabled: z.boolean().optional(),
    log_message: z.string().min(1).max(8192).optional(),
  })
  .strict()
export type DebuggerBreakpointRequest = z.infer<typeof DebuggerBreakpointRequestSchema>

/** Internal normalized driver seam, not a public DAP request API. */
export const DebuggerObservationSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('stop_details'),
      thread_id: threadId,
      stop_epoch: seq,
      description: z.string().max(4096),
      reason: z.string().min(1).max(256).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('exited'), exit_code: z.number().int().safe() }).strict(),
  z
    .object({
      kind: z.literal('build_identity'),
      build_identity: z.enum(['unknown', 'matched', 'mismatched']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('threads'),
      inventory_revision: seq,
      threads: z
        .array(z.object({ id: threadId, name: z.string().max(256) }).strict())
        .max(DEBUGGER_LIMITS.threads),
    })
    .strict(),
  z
    .object({
      kind: z.literal('thread'),
      thread_id: threadId,
      reason: z.enum(['started', 'exited']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('stopped'),
      thread_id: threadId.optional(),
      all_threads_stopped: z.boolean(),
      reason: z.string().min(1).max(256),
      description: z.string().max(4096).optional(),
      hit_breakpoint_ids: z.array(id).max(256),
      location: DebuggerSourceLocationSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('continued'),
      thread_id: threadId.optional(),
      all_threads_continued: z.boolean(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('output'),
      text: z.string().max(256 * 1024),
      category: z.string().max(4096),
    })
    .strict(),
  z.object({ kind: z.literal('invalidated') }).strict(),
  z
    .object({
      kind: z.literal('lifecycle'),
      lifecycle: z.enum(['active', 'detached', 'terminated', 'failed', 'connection-lost']),
    })
    .strict(),
  z.object({ kind: z.literal('capabilities'), capabilities: z.array(id).max(128) }).strict(),
  z.object({ kind: z.literal('breakpoints_pending'), revision: seq }).strict(),
  z
    .object({
      kind: z.literal('breakpoints_result'),
      revision: seq,
      results: z
        .array(
          z
            .object({
              breakpoint_id: id,
              verified: z.boolean(),
              line: line.optional(),
              column: line.optional(),
              message: z.string().max(4096).optional(),
            })
            .strict()
        )
        .max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal('breakpoints_patch'),
      revision: seq,
      upsert: z.array(DebuggerBreakpointRequestSchema).max(256),
      remove: z.array(id).max(256),
    })
    .strict(),
  z
    .object({
      kind: z.literal('execution_intent'),
      action: z.enum(['continue', 'step', 'restart', 'evaluate']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('control_pending'),
      commands: z.array(id).max(128),
      approvals: z.array(id).max(128),
    })
    .strict(),
  z.object({ kind: z.literal('recovery'), incarnation: id }).strict(),
  z
    .object({ kind: z.literal('target_replaced'), incarnation: id, target: DebuggerTargetSchema })
    .strict(),
])
export type DebuggerObservation = z.infer<typeof DebuggerObservationSchema>
export const DebuggerBreakpointSchema = DebuggerBreakpointRequestSchema.extend({
  status: z.enum(['requested', 'verified', 'relocated', 'rejected', 'pending']),
  resolved_line: line.nullable(),
  resolved_column: line.nullable(),
  message: z.string().max(4096).nullable(),
}).strict()
export const DebuggerSnapshotSchema = z
  .object({
    version: z.literal(DEBUGGER_VERSION),
    ...session,
    incarnation: id,
    state_revision: seq,
    breakpoint_revision: seq,
    event_seq: seq,
    stop_epoch: seq,
    observed_at: z.string().datetime(),
    target: DebuggerTargetSchema,
    lifecycle: z.enum([
      'configuring',
      'active',
      'detached',
      'terminated',
      'failed',
      'connection-lost',
    ]),
    execution: z.enum(['running', 'stopped', 'mixed', 'unknown']),
    threads: z.array(DebuggerThreadSchema).max(DEBUGGER_LIMITS.threads),
    thread_inventory: z.enum(['unknown', 'complete']),
    // Older B1 snapshots predate response fencing; startup expires their inventory.
    thread_inventory_revision: seq.default(0),
    all_threads_status: z.enum(['unknown', 'running', 'stopped']),
    selected_thread_id: threadId.nullable(),
    selected_frame_handle: id.nullable(),
    breakpoints: z.array(DebuggerBreakpointSchema).max(DEBUGGER_LIMITS.breakpoints),
    adapter_capabilities: z.array(id).max(128),
    pending_approvals: z.array(id).max(128),
    pending_commands: z.array(id).max(128),
  })
  .strict()
export type DebuggerSnapshot = z.infer<typeof DebuggerSnapshotSchema>
export const DebuggerExitInfoResultSchema = z
  .object({ exit_code: z.number().int().safe().nullable() })
  .strict()
export const DebuggerSessionInfoResultSchema = z
  .object({ started_at: z.string().datetime().nullable() })
  .strict()
export const DebuggerSourcesResultSchema = z
  .object({
    sources: z.array(z.object({ source_id: id, path: z.string().max(4096) }).strict()).max(256),
  })
  .strict()
export const DebuggerLocationsResultSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            line,
            column: line.optional(),
            end_line: line.optional(),
            end_column: line.optional(),
          })
          .strict()
      )
      .max(256),
    truncated: z.boolean(),
    snapshot: DebuggerSnapshotSchema,
  })
  .strict()
export const DebuggerSourceStatusResultSchema = DebuggerLocationsResultSchema.extend({
  loaded: z.boolean().nullable(),
  known: z.boolean(),
}).strict()
export const DebuggerLocationsInspectionSchema = z
  .object({
    data: DebuggerLocationsResultSchema,
    truncated: z.boolean(),
    snapshot: DebuggerSnapshotSchema,
  })
  .strict()
export const DebuggerSourceStatusInspectionSchema = z
  .object({
    data: DebuggerSourceStatusResultSchema,
    truncated: z.boolean(),
    snapshot: DebuggerSnapshotSchema,
  })
  .strict()
export const DebuggerCursorSchema = z
  .object({ ...session, incarnation: id, event_seq: seq })
  .strict()
export type DebuggerCursor = z.infer<typeof DebuggerCursorSchema>
export const DebuggerEventSchema = z
  .object({
    version: z.literal(DEBUGGER_VERSION),
    ...session,
    incarnation: id,
    event_seq: seq,
    state_revision: seq,
    breakpoint_revision: seq,
    stop_epoch: seq,
    observed_at: z.string().datetime(),
    kind: id,
    data: z.unknown(),
    truncated: z.boolean(),
  })
  .strict()
export type DebuggerEvent = z.infer<typeof DebuggerEventSchema>
export const DebuggerSnapshotResultSchema = z
  .object({ snapshot: DebuggerSnapshotSchema, cursor: DebuggerCursorSchema })
  .strict()
  .refine(
    ({ snapshot, cursor }) =>
      snapshot.debug_session_id === cursor.debug_session_id &&
      snapshot.incarnation === cursor.incarnation &&
      snapshot.event_seq === cursor.event_seq,
    'snapshot_cursor_mismatch'
  )
export const DebuggerWaitResultSchema = z
  .object({
    wait_id: id,
    reason: z.enum(['elapsed', 'event', 'cancelled', 'connection_lost']),
    elapsed_ms: seq,
    code: id.optional(),
    event: DebuggerEventSchema.optional(),
    snapshot: DebuggerSnapshotSchema.nullable(),
  })
  .strict()
export type DebuggerWaitResult = z.infer<typeof DebuggerWaitResultSchema>
export const DebuggerReplayResultSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('events'),
      events: z.array(DebuggerEventSchema).max(DEBUGGER_LIMITS.replay_events),
      cursor: DebuggerCursorSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('fresh_snapshot_required'),
      reason: z.enum(['gap', 'overflow', 'incarnation', 'future']),
      snapshot: DebuggerSnapshotSchema,
      cursor: DebuggerCursorSchema,
    })
    .strict(),
])
export type DebuggerReplayResult = z.infer<typeof DebuggerReplayResultSchema>
export const DebuggerReceiptSchema = z
  .object({
    operation_id: id,
    acceptance: z.enum(['accepted', 'rejected']),
    dispatch: z.enum(['not_dispatched', 'dispatched', 'possible']),
    outcome: z.enum(['pending', 'completed', 'rejected', 'failed', 'timed_out', 'outcome_unknown']),
    code: id.optional(),
    proposal_hash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    completed_at: z.string().datetime(),
    snapshot: DebuggerSnapshotSchema,
  })
  .strict()
export const DebuggerActorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), principal_id: id }).strict(),
  z.object({ kind: z.literal('agent'), principal_id: id, run_id: id }).strict(),
  z.object({ kind: z.literal('node') }).strict(),
])
export const DebuggerHistoryInputSchema = z
  .object({
    actor: DebuggerActorSchema,
    operation_id: id.nullable(),
    operation: id,
    outcome: z.enum([
      'proposed',
      'approved',
      'denied',
      'dispatched',
      'completed',
      'rejected',
      'failed',
      'outcome_unknown',
    ]),
    requested_data: z.unknown().optional(),
  })
  .strict()
export type DebuggerHistoryInput = z.infer<typeof DebuggerHistoryInputSchema>
export const DebuggerHistoryEntrySchema = DebuggerHistoryInputSchema.extend({
  ...session,
  history_seq: seq,
  event_seq: seq,
  stop: DebuggerStopSchema.nullable(),
  observed_at: z.string().datetime(),
  incarnation: id,
  stop_epoch: seq,
  state_revision: seq,
  target_id: id,
  build_identity: DebuggerTargetSchema.shape.build_identity,
  payload_status: z.enum(['absent', 'retained', 'truncated', 'expired']),
}).strict()
export type DebuggerHistoryEntry = z.infer<typeof DebuggerHistoryEntrySchema>
export const DebuggerHistoryResultSchema = z
  .object({
    entries: z.array(DebuggerHistoryEntrySchema).max(DEBUGGER_LIMITS.history_entries),
    truncated_before: seq,
  })
  .strict()

/** Full v1 declarations. Only the implemented authorized B3 subset is routed;
 * these are never merged into ordinary offline mutation MethodSchemas. */
/** One explicit approved page. Handles are opaque, stop-scoped and may be used
 * only in another variables request. No recursion or getter evaluation is implied.
 * An inspection may invalidate previous handles; use the receipt snapshot. */
export const DebuggerVariablesResultSchema = z
  .object({
    items: z
      .array(
        z
          .object({
            name: z.string().max(256),
            value: z.string().max(4096),
            type: z.string().max(256).optional(),
            handle: id.nullable().optional(),
          })
          .strict()
      )
      .max(100),
    truncated: z.boolean(),
    start: seq,
    count: z.number().int().min(1).max(100),
    next: seq.nullable(),
    depth_limit: z.number().int().min(0).max(3),
    expansion_depth: z.literal(0),
    observation_stop_epoch: seq,
  })
  .strict()
export type DebuggerVariablesResult = z.infer<typeof DebuggerVariablesResultSchema>

export const DebuggerMethodSchemas = {
  'debugger.v1.sessionInfo': z.object(session).strict(),
  'debugger.v1.sources': z.object(session).strict(),
  'debugger.v1.breakpointLocations': z
    .object({
      ...session,
      source_id: id,
      line,
      end_line: line,
      column: line.optional(),
      end_column: line.optional(),
    })
    .strict()
    .refine((p) => p.end_line >= p.line && p.end_line - p.line <= 1000, 'invalid line range'),
  'debugger.v1.sourceStatus': z
    .object({ ...session, source_id: id, line, end_line: line })
    .strict()
    .refine((p) => p.end_line >= p.line && p.end_line - p.line <= 1000, 'invalid line range'),
  'debugger.v1.exitInfo': z.object(session).strict(),
  'debugger.v1.profiles': z.object({}).strict(),
  'debugger.v1.sessions': z
    .object({ ...DebuggerOwnerShape, limit: z.number().int().min(1).max(128).default(128) })
    .strict()
    .refine(hasDebuggerOwner, 'debugger owner required'),
  'debugger.v1.create': z.object({ operation_id: id, target: DebuggerTargetSchema }).strict(),
  'debugger.v1.launch': z.object({ ...effect, launch_configuration_id: id }).strict(),
  'debugger.v1.attach': z.object({ ...effect, target_id: id }).strict(),
  'debugger.v1.status': z.object(session).strict(),
  'debugger.v1.commandResult': z.object({ ...session, operation_id: id }).strict(),
  'debugger.v1.breakpoints.patch': z
    .object({
      ...effect,
      expected_breakpoint_revision: seq,
      upsert: z.array(DebuggerBreakpointRequestSchema).max(256),
      remove: z.array(id).max(256),
    })
    .strict(),
  'debugger.v1.exceptionBreakpoints.set': z
    .object({ ...effect, filters: z.array(id).max(128) })
    .strict(),
  'debugger.v1.pause': z.object({ ...effect, thread_id: threadId.optional() }).strict(),
  'debugger.v1.continue': z
    .object({
      ...effect,
      thread_id: threadId.optional(),
      single_thread: z.boolean().default(false),
    })
    .strict(),
  'debugger.v1.step': z
    .object({
      ...effect,
      thread_id: threadId,
      kind: z.enum(['over', 'in', 'out']),
      single_thread: z.boolean().default(false),
    })
    .strict(),
  'debugger.v1.restart': z.object(effect).strict(),
  'debugger.v1.threads': z.object(session).strict(),
  'debugger.v1.stack': z
    .object({
      ...precondition,
      thread_id: threadId,
      start: seq.default(0),
      count: z.number().int().min(1).max(100).default(50),
    })
    .strict(),
  'debugger.v1.scopes': z.object({ ...precondition, frame_handle: id }).strict(),
  'debugger.v1.variables': z
    .object({
      ...precondition,
      handle: id,
      operation_id: id.optional(),
      start: seq.default(0),
      count: z.number().int().min(1).max(100).default(50),
      depth: z.number().int().min(0).max(3).default(1),
      max_bytes: z.number().int().min(1).max(8192).default(8192),
    })
    .strict(),
  'debugger.v1.source': z
    .object({
      ...session,
      source_id: id,
      content_id: id.optional(),
      offset: seq.default(0),
      max_bytes: z.number().int().min(1).max(65536).default(65536),
    })
    .strict(),
  'debugger.v1.evaluate': z
    .object({
      ...effect,
      frame_handle: id,
      expression: z.string().min(1).max(8192),
      context: z.enum(['repl', 'watch']).optional(),
    })
    .strict(),
  'debugger.v1.setVariable': z
    .object({
      ...effect,
      handle: id,
      name: z.string().min(1).max(256),
      value: z.string().max(8192),
    })
    .strict(),
  'debugger.v1.detach': z.object(effect).strict(),
  'debugger.v1.terminate': z.object(effect).strict(),
  'debugger.v1.history': z
    .object({
      ...session,
      after: seq.default(0),
      limit: z.number().int().min(1).max(128).default(128),
    })
    .strict(),
  'debugger.v1.replay': z.object({ cursor: DebuggerCursorSchema }).strict(),
  'debugger.v1.wait': z
    .object({
      ...session,
      wait_id: id.optional(),
      after_event_seq: seq,
      incarnation: id.optional(),
      kinds: z.array(id).max(32),
      timeout_ms: z.number().int().min(0).max(60000),
    })
    .strict(),
  'debugger.v1.sleep': z
    .object({
      ...session,
      wait_id: id.optional(),
      duration_ms: z.number().int().min(0).max(60000),
      wake_on: z.array(id).max(32).optional(),
    })
    .strict(),
  'debugger.v1.cancelWait': z.object({ ...session, wait_id: id }).strict(),
} as const
export type DebuggerMethod = keyof typeof DebuggerMethodSchemas
