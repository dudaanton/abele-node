import { z } from 'zod'
const id = z.string().min(1).max(128)
export const ActionSchema = z
  .object({
    tool_use_id: id,
    native_session_id: z.string().uuid().optional(),
    tool_name: z.string().min(1).max(256),
    input: z.record(z.unknown()),
    kind: z.enum(['permission', 'select', 'confirm', 'input', 'trust']).optional(),
    title: z.string().max(4096).optional(),
    options: z.array(z.string().max(4096)).max(256).optional(),
    ttl_ms: z.number().int().positive().max(3600000).optional(),
  })
  .strict()
export const IdentitySchema = z
  .object({
    pid: z.number().int().min(2),
    group: z.number().int().min(2),
    fingerprint: z.string().min(1).max(65535),
  })
  .strict()
export const DebuggerToolSchema = z
  .object({
    // The node's own tools: language intelligence, debugger, worktree switch and messages.
    name: z
      .string()
      .max(128)
      .regex(/^(?:lsp|(?:debug|node)_[a-z0-9_]+|obsidian_[A-Za-z][A-Za-z0-9_]{0,63})$/),
    description: z.string().max(16384),
    inputSchema: z.record(z.unknown()),
  })
  .strict()
const sharedWorkerMessages = [
  z.object({ kind: z.literal('debugger_call'), id, name: id, args: z.unknown() }).strict(),
  z.object({ kind: z.literal('debugger_cancel'), id }).strict(),
  z
    .object({
      kind: z.literal('event'),
      event: z
        .object({
          type: z.string().min(1).max(256).startsWith('pi.'),
          data: z.record(z.unknown()),
        })
        .strict(),
    })
    .strict(),
  z.object({ kind: z.literal('question'), id, action: ActionSchema }).strict(),
  z.object({ kind: z.literal('consume'), id }).strict(),
  z.object({ kind: z.literal('question_cancel'), id }).strict(),
  z.object({ kind: z.literal('process_claim'), id, evidence: IdentitySchema }).strict(),
  z.object({ kind: z.literal('group_reaped'), id, evidence: IdentitySchema }).strict(),
] as const
export const WorkerMessageSchema = z.discriminatedUnion('kind', [
  ...sharedWorkerMessages,
  z.object({ kind: z.literal('ready'), evidence: IdentitySchema }).strict(),
  z.object({ kind: z.literal('inventory'), evidence: z.array(IdentitySchema).max(256) }).strict(),
  z
    .object({
      kind: z.literal('done'),
      result: z
        .object({
          subtype: z.enum(['success', 'error']),
          is_error: z.boolean(),
          terminal_reason: z.string().max(256).optional(),
        })
        .strict()
        .optional(),
      reason: z.enum(['pi_host_failed', 'pi_aborted', 'pi_output_limit']).optional(),
    })
    .strict(),
])
export const ConfigurationSchema = z
  .object({
    cwd: z.string().min(1).max(4096),
    sessionDir: z.string().min(1).max(4096),
    native_session_id: z.string().uuid().optional(),
    native_session_file: z.string().max(4096).optional(),
    agentDir: z.string().min(1).max(4096),
    provider: z.string().max(128),
    model: z.string().max(256),
    profile: z.enum(['inherited', 'isolated']),
    maxTokens: z.number().int().min(64).max(32768),
    permission_mode: z.enum(['manual', 'bypassPermissions']).optional(),
    debugger_tools: z.array(DebuggerToolSchema).max(320).optional(),
    live: z
      .object({ effort: z.string().max(32), permission_mode: z.string().max(64) })
      .strict()
      .optional(),
  })
  .strict()
export const ParentMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('debugger_result'), id, result: z.unknown() }).strict(),
  z
    .object({
      kind: z.literal('start'),
      config: ConfigurationSchema,
      hostModule: z.string().min(1).max(4096),
      text: z.string().min(1).max(32768),
    })
    .strict(),
  z.object({ kind: z.literal('stop') }).strict(),
  z.object({ kind: z.literal('ack'), bytes: z.number().int().nonnegative() }).strict(),
  z
    .object({
      kind: z.literal('answer'),
      id,
      choice: z.enum(['allow', 'deny']),
      value: z.string().max(32768).optional(),
    })
    .strict(),
  z.object({ kind: z.literal('confirmed'), id, confirmed: z.boolean() }).strict(),
  z.object({ kind: z.literal('registered'), id, confirmed: z.boolean() }).strict(),
])
const answer = z
  .object({
    kind: z.literal('answer'),
    id,
    choice: z.enum(['allow', 'deny']),
    value: z.string().max(32768).optional(),
  })
  .strict()
/** A long-lived worker: written once into its private run directory. */
export const LiveConfigurationSchema = z
  .object({ hostModule: z.string().min(1).max(4096), config: ConfigurationSchema })
  .strict()
export const LiveParentMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('debugger_result'), id, result: z.unknown() }).strict(),
  z
    .object({
      kind: z.literal('input'),
      input_id: id,
      text: z
        .string()
        .min(1)
        .max(1024 * 1024),
    })
    .strict(),
  z.object({ kind: z.literal('interrupt') }).strict(),
  z
    .object({
      kind: z.literal('control'),
      id,
      subtype: z.string().min(1).max(64),
      params: z.record(z.unknown()),
    })
    .strict(),
  /** A daemon (re)attached: ask again whatever still waits on one. */
  z.object({ kind: z.literal('attached') }).strict(),
  z.object({ kind: z.literal('stop') }).strict(),
  answer,
  z.object({ kind: z.literal('confirmed'), id, confirmed: z.boolean() }).strict(),
  z.object({ kind: z.literal('registered'), id, confirmed: z.boolean() }).strict(),
])
export const LiveWorkerMessageSchema = z.discriminatedUnion('kind', [
  ...sharedWorkerMessages,
  z.object({ kind: z.literal('ready') }).strict(),
  z.object({ kind: z.literal('failed'), reason: z.string().max(128) }).strict(),
  z
    .object({
      kind: z.literal('control_result'),
      id,
      ok: z.boolean(),
      result: z.record(z.unknown()).optional(),
      error: z.string().max(256).optional(),
    })
    .strict(),
])
