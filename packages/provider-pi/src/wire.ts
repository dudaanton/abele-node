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
export const WorkerMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), evidence: IdentitySchema }).strict(),
  z
    .object({
      kind: z.literal('event'),
      event: z
        .object({ type: z.string().min(1).max(256).startsWith('pi.'), data: z.record(z.unknown()) })
        .strict(),
    })
    .strict(),
  z.object({ kind: z.literal('question'), id, action: ActionSchema }).strict(),
  z.object({ kind: z.literal('consume'), id }).strict(),
  z.object({ kind: z.literal('question_cancel'), id }).strict(),
  z.object({ kind: z.literal('inventory'), evidence: z.array(IdentitySchema).max(256) }).strict(),
  z.object({ kind: z.literal('process_claim'), id, evidence: IdentitySchema }).strict(),
  z.object({ kind: z.literal('group_reaped'), id, evidence: IdentitySchema }).strict(),
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
  })
  .strict()
export const ParentMessageSchema = z.discriminatedUnion('kind', [
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
