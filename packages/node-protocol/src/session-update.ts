import { z } from 'zod'
import { DebuggerAccessRequestSchema } from './debugger-control.js'

/**
 * One transcript vocabulary for every agent, modelled on ACP `session/update` kinds.
 * Journaled as `session.update` events beside the provider's own records, which stay as they
 * were. Additive only: a client ignores kinds and fields it does not know, so objects here are
 * not strict, and an unknown kind is retained rather than rejected.
 */
export const SESSION_UPDATE_VERSION = 1
const id = z.string().min(1).max(256)
const text = z.string().max(65536)
/** A subagent's output nests under the tool call that started it; null at the top level. */
const parent = { parent_tool_call_id: id.nullable().optional() }
/** Text cut to fit a journal record; the provider's own record keeps the whole of it. */
const truncated = { truncated: z.boolean().optional() }
const message = { message_id: id, block: z.number().int().min(0).nullable().optional(), ...parent }

export const TOOL_KINDS = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
] as const
export const TOOL_STATUSES = ['pending', 'in_progress', 'completed', 'failed'] as const
export const ToolLocationSchema = z.object({
  path: z.string().min(1).max(4096),
  line: z.number().int().min(0).nullable().optional(),
})
export const ToolContentSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('content'), text, ...truncated }),
  z.object({
    type: z.literal('diff'),
    path: z.string().min(1).max(4096),
    /** Null for a new file. */
    old_text: text.nullable(),
    new_text: text,
    ...truncated,
  }),
])
const tool = {
  tool_call_id: id,
  title: z.string().max(4096).optional(),
  /** ACP's tool `kind`, renamed so it does not clash with the update's own `kind`. */
  tool_kind: z.enum(TOOL_KINDS).optional(),
  status: z.enum(TOOL_STATUSES).optional(),
  locations: z.array(ToolLocationSchema).max(64).optional(),
  content: z.array(ToolContentSchema).max(64).optional(),
  /** The agent's own tool name, for a renderer that knows it better. */
  name: z.string().max(256).optional(),
  raw_input: z.record(z.unknown()).optional(),
}
export const PlanEntrySchema = z.object({
  content: z.string().max(4096),
  priority: z.enum(['high', 'medium', 'low']),
  status: z.enum(['pending', 'in_progress', 'completed']),
})
export const SessionCommandSchema = z.object({
  /** Without the slash; invoked by sending `/<name> <input>` as an ordinary message. */
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[^\s/][^\s]*$/),
  description: z.string().max(1024).nullable(),
  /** What goes after the name, when the agent says; null when it takes none or did not say. */
  input_hint: z.string().max(256).nullable().optional(),
  /** Where it comes from: `builtin`, `skill`, `prompt`, `extension`… informational. */
  source: z.string().max(32).optional(),
})
export const ConfigOptionSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(128),
  category: z.enum(['mode', 'model', 'thought_level', 'other']),
  current_value: z.string().max(256).nullable(),
  options: z
    .array(z.object({ value: z.string().max(256), name: z.string().max(256) }))
    .max(256)
    .optional(),
})

const kinds = {
  debugger_access_requested: DebuggerAccessRequestSchema,
  user_message: z.object({ kind: z.literal('user_message'), ...message, text, ...truncated }),
  /** Appended to the text of (message_id, block). */
  agent_message_chunk: z.object({ kind: z.literal('agent_message_chunk'), ...message, text }),
  /** The whole text of (message_id, block): replaces the chunks seen so far. */
  agent_message: z.object({ kind: z.literal('agent_message'), ...message, text, ...truncated }),
  agent_thought_chunk: z.object({ kind: z.literal('agent_thought_chunk'), ...message, text }),
  /** Replaces the chunks; `redacted` when the agent keeps its reasoning to itself. */
  agent_thought: z.object({
    kind: z.literal('agent_thought'),
    ...message,
    text,
    redacted: z.boolean().optional(),
    ...truncated,
  }),
  tool_call: z.object({
    kind: z.literal('tool_call'),
    ...tool,
    title: z.string().max(4096),
    ...parent,
  }),
  /** Only the fields present change; `content` replaces the call's content. */
  tool_call_update: z.object({ kind: z.literal('tool_call_update'), ...tool }),
  /** The whole plan each time. */
  plan: z.object({ kind: z.literal('plan'), entries: z.array(PlanEntrySchema).max(256) }),
  current_mode_update: z.object({
    kind: z.literal('current_mode_update'),
    mode_id: z.string().min(1).max(64),
  }),
  /** The whole list each time; what `session.commands` answers with until the next one. */
  available_commands_update: z.object({
    kind: z.literal('available_commands_update'),
    commands: z.array(SessionCommandSchema).max(512),
  }),
  config_option_update: z.object({
    kind: z.literal('config_option_update'),
    options: z.array(ConfigOptionSchema).max(32),
  }),
  /** Context window use; any field may be unknown. */
  usage_update: z.object({
    kind: z.literal('usage_update'),
    used_tokens: z.number().nullable(),
    max_tokens: z.number().nullable(),
    percentage: z.number().nullable().optional(),
    cost_usd: z.number().nullable().optional(),
  }),
  compaction_update: z.object({
    kind: z.literal('compaction_update'),
    state: z.enum(['started', 'completed', 'failed']),
    trigger: z.string().max(32).nullable().optional(),
    pre_tokens: z.number().nullable().optional(),
    post_tokens: z.number().nullable().optional(),
    error: z.string().max(256).nullable().optional(),
  }),
  compaction_summary: z.object({ kind: z.literal('compaction_summary'), text, ...truncated }),
  notice: z.object({
    kind: z.literal('notice'),
    level: z.enum(['info', 'warning', 'error']),
    text: z.string().max(4096),
    code: z.string().max(64).optional(),
    status: z.enum(['allowed_warning', 'rejected']).optional(),
    /** Provider reset time in Unix seconds; clients format it in their local timezone. */
    resets_at: z.number().finite().nullable().optional(),
  }),
} as const
export type SessionUpdateKind = keyof typeof kinds
export const SESSION_UPDATE_KINDS = Object.keys(kinds) as SessionUpdateKind[]
const known = new Set<string>(SESSION_UPDATE_KINDS)
export const KnownSessionUpdateSchema = z.discriminatedUnion(
  'kind',
  Object.values(kinds) as unknown as [
    (typeof kinds)[SessionUpdateKind],
    ...(typeof kinds)[SessionUpdateKind][],
  ]
)
/** A kind from a newer node: kept whole, never rendered as a known one. */
export const UnknownSessionUpdateSchema = z
  .object({
    kind: z
      .string()
      .min(1)
      .max(64)
      .refine((k) => !known.has(k)),
  })
  .passthrough()
export const SessionUpdateSchema = z.union([KnownSessionUpdateSchema, UnknownSessionUpdateSchema])
export type SessionUpdate = z.infer<typeof KnownSessionUpdateSchema>
export type SessionUpdateOf<K extends SessionUpdateKind> = Extract<SessionUpdate, { kind: K }>
export type SessionCommand = z.infer<typeof SessionCommandSchema>
export type ToolContent = z.infer<typeof ToolContentSchema>
export type PlanEntry = z.infer<typeof PlanEntrySchema>
/** The data of a `session.update` event. `run_id` is absent only for updates made outside a run. */
export const SessionUpdateEventSchema = z.object({
  run_id: z.string().min(1).max(128).optional(),
  update: SessionUpdateSchema,
})
export type SessionUpdateEvent = { run_id?: string; update: SessionUpdate }
export const SessionCommandsSchema = z.object({
  session_id: z.string().min(1).max(128),
  commands: z.array(SessionCommandSchema).max(512),
  /** The journal position of the update the list came from; 0 before the agent reported any. */
  seq: z.number().int().min(0),
})
export type SessionCommands = z.infer<typeof SessionCommandsSchema>
export function isKnownSessionUpdate(update: { kind?: unknown }): update is SessionUpdate {
  return typeof update.kind === 'string' && known.has(update.kind)
}
/** The text a client sends to run a command: an ordinary message the agent reads as one. */
export function commandText(name: string, input = ''): string {
  SessionCommandSchema.shape.name.parse(name)
  const rest = input.trim()
  return rest ? `/${name} ${rest}` : `/${name}`
}
