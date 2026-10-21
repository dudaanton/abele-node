import { z } from 'zod'

const id = z.string().min(1).max(128)
export const SESSION_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export const SESSION_PERMISSION_MODES = [
  'manual',
  'acceptEdits',
  'auto',
  'plan',
  'dontAsk',
  'bypassPermissions',
] as const
/** Effective filesystem/tool policy, recorded with each session and delegation. */
export const ToolPermissionsSchema = z
  .object({
    permission_mode: z.enum(SESSION_PERMISSION_MODES),
    per_action_approval: z.boolean(),
    status: z.enum(['supported', 'unsupported']),
    reason: z.string().max(256).optional(),
  })
  .strict()
/** What the owner chose for one session. Absent fields take the node's defaults. */
export const SessionSettingsSchema = z
  .object({
    model: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_./:[\]-]+$/)
      .refine((m) => !m.startsWith('-'))
      .optional(),
    effort: z.enum(SESSION_EFFORTS).optional(),
    /** A configuration name the node offers in its capabilities, never a path. */
    account: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/)
      .optional(),
    permission_mode: z.enum(SESSION_PERMISSION_MODES).optional(),
    /** After a compaction the node asks for a manual one, write the continuation text. */
    continue_after_compaction: z.boolean().optional(),
    continuation_text: z.string().min(1).max(4096).optional(),
    /** The session may list the owner's other sessions and write to them, and receive from them.
     * On by default; delegated work never has it. */
    messaging: z.boolean().optional(),
  })
  .strict()
export type SessionSettings = z.infer<typeof SessionSettingsSchema>
export const LiveMethodSchemas = {
  'session.configure': z.object({ session_id: id, settings: SessionSettingsSchema }).strict(),
  'session.compact': z
    .object({
      session_id: id,
      focus: z.string().max(4096).optional(),
      /** Overrides the session's continue_after_compaction for this compaction. */
      continue: z.boolean().optional(),
    })
    .strict(),
  'session.stop': z.object({ session_id: id }).strict(),
  'session.state': z.object({ session_id: id }).strict(),
} as const
export const LIVE_MUTATIONS = ['session.configure', 'session.compact', 'session.stop'] as const
export const BackgroundTaskSchema = z
  .object({
    task_id: z.string().max(256),
    task_type: z.string().max(128).nullable(),
    description: z.string().max(4096).nullable(),
  })
  .strict()
export const SessionContextSchema = z
  .object({
    total_tokens: z.number().nullable(),
    max_tokens: z.number().nullable(),
    percentage: z.number().nullable(),
    auto_compact_threshold: z.number().nullable(),
    auto_compact_enabled: z.boolean().nullable(),
    model: z.string().max(256).nullable(),
    categories: z
      .array(
        z
          .object({
            name: z.string().max(128),
            tokens: z.number(),
            deferred: z.boolean().optional(),
          })
          .strict()
      )
      .max(32),
  })
  .strict()
export const LiveSessionStateSchema = z
  .object({
    session_id: id,
    tool_permissions: ToolPermissionsSchema.optional(),
    /** False: one process per message (delegated work, or a CLI without long-lived input). */
    live: z.boolean(),
    process: z.enum(['none', 'starting', 'idle', 'running', 'stopping']),
    run_id: id.nullable(),
    turn: z
      .object({ turn_id: id, trigger: z.string().max(32), started_at: z.string().datetime() })
      .strict()
      .nullable(),
    background_tasks: z.array(BackgroundTaskSchema).max(256),
    context: SessionContextSchema.nullable(),
    compacting: z.boolean(),
    settings: z
      .object({
        model: z.string(),
        effort: z.string(),
        account: z.string(),
        permission_mode: z.string(),
        continue_after_compaction: z.boolean(),
        continuation_text: z.string(),
        messaging: z.boolean(),
      })
      .strict(),
    /** What the running process was started with or switched to; null without a process. */
    process_settings: z
      .object({
        model: z.string(),
        effort: z.string(),
        account: z.string(),
        permission_mode: z.string(),
      })
      .strict()
      .nullable(),
    /** Effort or account changed while the process could not be restarted yet. */
    restart_pending: z.boolean(),
    watchers: z.number().int().min(0),
    idle_since: z.string().datetime().nullable(),
  })
  .strict()
export type LiveSessionState = z.infer<typeof LiveSessionStateSchema>
const runId = { run_id: id }
export const LiveEventPayloads = {
  'session.process': z
    .object({
      ...runId,
      state: z.enum(['starting', 'running', 'exited']),
      resumed: z.boolean().optional(),
      /** A process an earlier node left running, taken over by this one. */
      reattached: z.boolean().optional(),
      native_session_id: z.string().max(256).nullable().optional(),
      reason: z.string().max(256).nullable().optional(),
      exit_code: z.number().int().nullable().optional(),
      lost_tasks: z.array(BackgroundTaskSchema).max(256).optional(),
    })
    .strict(),
  'turn.started': z.object({ ...runId, turn_id: id, trigger: z.string().max(32) }).strict(),
  // A separate event keeps existing strict turn.completed readers compatible.
  'input.reply': z
    .object({
      ...runId,
      input_id: id,
      turn_id: id.nullable(),
      outcome: z.enum(['success', 'failed', 'interrupted']),
      final_reply: z
        .object({
          message_id: id,
          event_seqs: z.array(z.number().int().positive()),
        })
        .strict()
        .nullable(),
    })
    .strict(),
  'turn.completed': z
    .object({
      ...runId,
      turn_id: id,
      outcome: z.enum(['success', 'failed', 'interrupted']),
      input_ids: z.array(id).max(256),
      subtype: z.string().max(128).nullable(),
      num_turns: z.number().nullable(),
      duration_ms: z.number().nullable(),
      total_cost_usd: z.number().nullable(),
      terminal_reason: z.string().max(256).nullable(),
    })
    .strict(),
  'turn.interrupt_requested': z.object(runId).strict(),
  'session.tasks': z.object({ ...runId, tasks: z.array(BackgroundTaskSchema).max(256) }).strict(),
  'session.context': SessionContextSchema.extend(runId).strict(),
  'compaction.started': z.object(runId).strict(),
  /** In the sender's stream: a message this session wrote to another owner session. */
  'session.message.sent': z
    .object({
      input_id: id,
      to_session_id: id,
      to_title: z.string().max(256),
      text: z.string().max(32768),
    })
    .strict(),
  'compaction.completed': z
    .object({
      ...runId,
      result: z.enum(['success', 'failed']),
      trigger: z.string().max(32).nullable(),
      pre_tokens: z.number().nullable(),
      post_tokens: z.number().nullable(),
      duration_ms: z.number().nullable(),
      error: z.string().max(256).nullable(),
    })
    .strict(),
} as const
