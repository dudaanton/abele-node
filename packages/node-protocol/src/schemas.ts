import { z } from 'zod'
import {
  DelegationMethodSchemas,
  DelegationCreateSchema,
  DELEGATION_MUTATIONS,
  DelegationSchema,
  DelegationMessageSchema,
  DelegationTerminalSchema,
} from './delegation.js'
export * from './delegation.js'
import { FileMethodSchemas, WorkspaceInvalidationSchema } from './files.js'
export * from './files.js'
import { EventSchema } from '@abele/channel-protocol'
import {
  ProjectSchema,
  WorkspaceSchema,
  JobSchema,
  ResourceMethodSchemas,
  RESOURCE_MUTATIONS,
} from './resources.js'
export * from './resources.js'
export { RecordSchema, EventSchema, RequestSchema, ErrorSchema } from '@abele/channel-protocol'
const id = z.string().min(1).max(128)
export const SeqSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const FakeStepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('echo') }).strict(),
  z.object({ kind: z.literal('chunk'), text: z.string().max(65536) }).strict(),
  z
    .object({
      kind: z.literal('permission'),
      ttl_ms: z.number().int().min(1).max(3600000).default(60000),
    })
    .strict(),
  z.object({ kind: z.literal('fail') }).strict(),
  z.object({ kind: z.literal('hang') }).strict(),
])
export type FakeStep = z.infer<typeof FakeStepSchema>
export const InputStateSchema = z.enum([
  'accepted',
  'queued',
  'dispatching',
  'delivered',
  'completed',
  'cancelled',
  'failed',
  'interrupted',
  'delivery_unknown',
])
export const PromptSchema = z
  .object({
    kind: z.enum(['permission', 'select', 'confirm', 'input', 'trust']).default('permission'),
    prompt_id: id,
    session_id: id,
    run_id: id,
    revision: z.literal(1),
    action_digest: z.string().length(64),
    expires_at: z.number().int(),
    state: z.enum(['pending', 'resolved', 'expired', 'invalidated']),
    choice: z.enum(['allow', 'deny']).nullable(),
    installation_id: id.nullable(),
    delivered: z.boolean(),
    tool_use_id: id.optional(),
    native_session_id: z.string().uuid().optional(),
    tool_name: z.string().min(1).max(256).optional(),
    input: z.record(z.unknown()).optional(),
    title: z.string().max(4096).optional(),
    options: z.array(z.string().max(4096)).max(256).optional(),
    value: z.string().max(32768).nullable().optional(),
  })
  .strict()
export type Prompt = z.infer<typeof PromptSchema>
export const SessionSchema = z
  .object({
    session_id: id,
    title: z.string().max(256),
    provider: z.enum(['fake', 'claude', 'pi']),
    native_session_id: z.string().uuid().optional(),
    native_session_file: z.string().min(1).max(4096).optional(),
    created_at: z.string().datetime(),
    workspace_id: id.nullable().optional(),
  })
  .strict()
export const CapabilitySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('supported'), evidence: z.string() }),
  z.object({ status: z.literal('unsupported'), reason: z.string() }),
  z.object({ status: z.literal('unverified'), reason: z.string() }),
])
export const ErrorCodeSchema = z.enum([
  'unauthorized',
  'not_found',
  'invalid_params',
  'unsupported_method',
  'operation_id_required',
  'idempotency_mismatch',
  'stale_revision',
  'prompt_expired',
  'resource_busy',
  'resync_required',
  'storage_unavailable',
  'record_too_large',
  'slow_consumer',
  'git_required',
  'invalid_ref',
  'repository_unavailable',
  'unmanaged_workspace',
  'workspace_dirty',
  'git_failed',
  'git_timeout',
  'output_limit',
  'unsupported_name',
  'unsafe_path',
  'unsupported_file_metadata', // Kept for historical receipts, no longer a write policy.
  'file_not_writable',
  'file_too_large',
  'recovery_expired',
  'recovery_migration_required',
  'invalid_anchor',
  'workspace_required',
  'project_untrusted',
  'provider_unavailable',
])
export const TokenCommandSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('create'),
      value: z.string().min(1).max(128).default('installation'),
    })
    .strict(),
  z.object({ action: z.literal('list'), value: z.undefined().optional() }).strict(),
  z.object({ action: z.literal('revoke'), value: id }).strict(),
])
const EventPayloads = {
  'delegation.created': DelegationSchema,
  'delegation.progress': DelegationMessageSchema,
  'delegation.question': DelegationMessageSchema,
  'delegation.result': DelegationMessageSchema,
  'delegation.terminal': DelegationTerminalSchema,
  'project.registered': ProjectSchema,
  'project.claude_permissions.changed': ProjectSchema,
  'project.removed': z.object({ project_id: id }).strict(),
  'workspace.changed': z.union([WorkspaceSchema, WorkspaceInvalidationSchema]),
  'job.changed': JobSchema,
  'session.updated': SessionSchema,
  'session.created': SessionSchema,
  'prompt.opened': PromptSchema,
  'prompt.resolved': PromptSchema,
  'prompt.expired': PromptSchema,
  'prompt.invalidated': PromptSchema,
  'content.delta': z
    .object({
      run_id: id,
      text: z.string().optional(),
      artifact_id: id.optional(),
      size: SeqSchema.optional(),
    })
    .strict()
    .refine((p) => Object.hasOwn(p, 'text') !== Object.hasOwn(p, 'artifact_id')),
} as const
/** Unknown optional events are retained; known permission/content semantics are validated. */
export const NodeEventSchema = EventSchema.superRefine((event, ctx) => {
  if (!Object.hasOwn(EventPayloads, event.type)) return
  const result = EventPayloads[event.type as keyof typeof EventPayloads].safeParse(event.data)
  if (!result.success)
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid known event payload' })
})
const session = { session_id: id }
export const MethodSchemas = {
  ...DelegationMethodSchemas,
  'delegation.create': DelegationCreateSchema.extend({
    script: z
      .array(FakeStepSchema)
      .min(1)
      .max(32)
      .default([{ kind: 'echo' }]),
  }),
  ...ResourceMethodSchemas,
  ...FileMethodSchemas,
  'session.detach': z.object(session).strict(),
  'node.describe': z.object({}).strict(),
  'session.list': z
    .object({ after_id: id.optional(), limit: z.number().int().min(1).max(256).default(256) })
    .strict(),
  'session.create': z
    .object({
      title: z.string().max(256).default('Fake session'),
      provider: z.enum(['fake', 'claude', 'pi']).default('fake'),
      workspace_id: id.optional(),
    })
    .strict(),
  'session.get': z.object(session).strict(),
  'session.send': z
    .object({
      ...session,
      text: z.string().min(1).max(32768),
      observed_seq: SeqSchema,
      script: z
        .array(FakeStepSchema)
        .min(1)
        .max(32)
        .default([{ kind: 'echo' }]),
    })
    .strict(),
  'session.interrupt': z.object({ ...session, run_id: id }).strict(),
  'input.cancel': z.object({ ...session, input_id: id }).strict(),
  'prompt.list': z
    .object({
      ...session,
      after_id: id.optional(),
      limit: z.number().int().min(1).max(256).default(256),
      state: z.enum(['pending', 'resolved', 'expired', 'invalidated']).optional(),
    })
    .strict(),
  'prompt.answer': z
    .object({
      ...session,
      prompt_id: id,
      run_id: id,
      revision: z.literal(1),
      action_digest: z.string().length(64),
      choice: z.enum(['allow', 'deny']),
      value: z.string().max(32768).optional(),
    })
    .strict(),
  'stream.read': z
    .object({
      stream_id: id,
      after_seq: SeqSchema,
      limit: z.number().int().min(1).max(256).default(256),
    })
    .strict(),
  'stream.subscribe': z.object({ stream_id: id, after_seq: SeqSchema }).strict(),
  'stream.ack': z.object({ stream_id: id, seq: SeqSchema }).strict(),
  'stream.unsubscribe': z.object({ stream_id: id }).strict(),
  'artifact.read': z
    .object({
      ...session,
      artifact_id: id,
      offset: SeqSchema,
      length: z
        .number()
        .int()
        .min(1)
        .max(128 * 1024)
        .default(128 * 1024),
    })
    .strict(),
} as const
export type DelegationCreateRequest = z.input<(typeof MethodSchemas)['delegation.create']>
export type Method = keyof typeof MethodSchemas
export const MUTATIONS = new Set<Method>([
  ...DELEGATION_MUTATIONS,
  ...RESOURCE_MUTATIONS,
  'review.submit',
  'workspace.write',
  'workspace.restore',
  'session.detach',
  'session.create',
  'session.send',
  'session.interrupt',
  'input.cancel',
  'prompt.answer',
])
export const FAKE_CAPABILITIES = {
  provider: 'fake',
  provider_version: '1',
  capabilities: {
    execution: { status: 'unsupported', reason: 'Non-executing fixture' },
    projects: { status: 'supported', evidence: 'registered-projects-v1' },
    workspaces: { status: 'supported', evidence: 'durable-git-worktrees-v1' },
    workspace_preview: { status: 'supported', evidence: 'bounded-read-only-head-diff-v1' },
    streaming: { status: 'supported', evidence: 'deterministic-fake-v1' },
    prompts: { status: 'supported', evidence: 'durable-prompt-v1' },
    steering: { status: 'unsupported', reason: 'Serialized queue only' },
  },
}
export function validateParams(method: string, params: unknown): unknown {
  if (!Object.hasOwn(MethodSchemas, method)) throw new Error('unsupported_method')
  return MethodSchemas[method as Method].parse(params)
}
