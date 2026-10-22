// Strict response schemas copied from 0.4.42 (f224d69).
// Imported primitive schemas are unchanged in 0.4.43.
import { z } from 'zod'
import { Id } from '@abele/channel-protocol'
import {
  AgentIdSchema,
  SessionSettingsSchema,
  BackgroundTaskSchema,
  SessionContextSchema,
  DelegationStateSchema,
} from '@abele/node-protocol'
const id = z.string().min(1).max(128)
const path = z.string().min(1).max(4096)
const timestamp = z.string().datetime()
const TrustSchema = z.enum(['untrusted', 'trusted'])

export const ProjectSchema = z
  .object({
    project_id: id,
    root_path: path,
    repository_path: path.nullable(),
    git_common_dir: path.nullable(),
    trust: TrustSchema,
    use_repository_claude_permissions: z.boolean().default(false),
    created_at: timestamp,
  })
  .strict()

export const SessionSchema = z
  .object({
    session_id: id,
    title: z.string().max(256),
    provider: z.enum(['fake', 'claude', 'pi', 'codex', 'acp']),
    native_session_id: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[A-Za-z0-9_:-]+$/)
      .optional(),
    native_session_file: z.string().min(1).max(4096).optional(),
    /** The ACP agent a session of provider `acp` runs, by its configured name. */
    agent: AgentIdSchema.optional(),
    created_at: z.string().datetime(),
    workspace_id: id.nullable().optional(),
    /** The owner's choices for a long-lived session; absent means the node's defaults. */
    settings: SessionSettingsSchema.optional(),
  })
  .strict()
  .refine(
    (s) =>
      s.provider === 'codex' ||
      s.provider === 'acp' ||
      s.native_session_id === undefined ||
      z.string().uuid().safeParse(s.native_session_id).success,
    { message: 'Native ID must be a UUID for this provider', path: ['native_session_id'] }
  )
  .refine((s) => (s.provider === 'acp') === (s.agent !== undefined), {
    message: 'An ACP session names its agent, and only an ACP session does',
    path: ['agent'],
  })

export const LiveSessionStateSchema = z
  .object({
    session_id: id,
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

export const DelegationSchema = z
  .object({
    node_id: Id,
    session_id: Id,
    delegation_id: Id,
    delegation_key: Id,
    grant_id: Id,
    parent_id: Id,
    mailbox_stream_id: Id,
    workspace_id: Id.nullable(),
    job_id: Id.nullable(),
    state: DelegationStateSchema,
    reason: z.enum(['time_limit']).optional(),
    created_at: z.string().datetime(),
  })
  .strict()
