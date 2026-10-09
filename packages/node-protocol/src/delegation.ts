import { z } from 'zod'
import { Id, Sequence } from '@abele/channel-protocol'

export const DelegationActionSchema = z.enum(['create', 'send', 'status', 'cancel', 'read'])
export const DelegationStateSchema = z.enum([
  'provisioning',
  'running',
  'completed',
  'failed',
  'cancelled',
  'unknown',
])
export const WorkerReportSchema = z
  .object({
    report_id: Id,
    kind: z.enum(['progress', 'question', 'result']),
    text: z.string().min(1).max(32768),
  })
  .strict()
export type WorkerReport = z.infer<typeof WorkerReportSchema>
/** Public identity/authorization provenance only; never a credential or private key. */
export const DelegationAuthoritySchema = z.discriminatedUnion('profile', [
  z.object({ installation_id: Id, profile: z.literal('local-token-v1') }).strict(),
  z
    .object({
      installation_id: Id,
      profile: z.literal('paired-wss-v1'),
      device_key: z.string().min(1).max(4096),
    })
    .strict(),
])
export const DelegationGrantSchema = z
  .object({
    grant_id: Id,
    installation_id: Id,
    approved_by: Id,
    owner_authority: DelegationAuthoritySchema.optional(),
    controller_authority: DelegationAuthoritySchema.optional(),
    parent_id: Id,
    project_ids: z.array(Id).max(128),
    providers: z
      .array(z.enum(['fake', 'claude', 'pi']))
      .min(1)
      .max(3),
    actions: z.array(DelegationActionSchema).min(1).max(5),
    allow_fake: z.boolean(),
    created_at: z.string().datetime(),
    revoked: z.boolean(),
  })
  .strict()
export type DelegationGrant = z.infer<typeof DelegationGrantSchema>
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
    created_at: z.string().datetime(),
  })
  .strict()
export type Delegation = z.infer<typeof DelegationSchema>
export const DelegationStatusSchema = DelegationSchema.extend({
  session_head_seq: Sequence,
  mailbox_head_seq: Sequence,
  pending_human_prompts: Sequence,
})
export type DelegationStatus = z.infer<typeof DelegationStatusSchema>
export const DelegationSendResultSchema = z
  .object({ input_id: Id, accepted_seq: Sequence })
  .strict()
export type DelegationSendResult = z.infer<typeof DelegationSendResultSchema>
export const DelegationTerminalSchema = z
  .object({
    delegation_id: Id,
    session_id: Id,
    state: z.enum(['completed', 'failed', 'cancelled', 'unknown']),
  })
  .strict()
export const DelegationMessageSchema = z
  .object({
    delegation_id: Id,
    session_id: Id,
    report_id: Id,
    text: z.string().max(32768),
  })
  .strict()
export const DelegationGrantRequestSchema = z
  .object({
    parent_id: Id,
    installation_id: Id.optional(),
    project_ids: z.array(Id).max(128),
    providers: z
      .array(z.enum(['fake', 'claude', 'pi']))
      .min(1)
      .max(3)
      .default(['fake', 'claude', 'pi']),
    actions: z
      .array(DelegationActionSchema)
      .min(1)
      .max(5)
      .default(['create', 'send', 'status', 'cancel', 'read']),
    allow_fake: z.boolean().default(false),
  })
  .strict()
export type DelegationGrantRequest = z.input<typeof DelegationGrantRequestSchema>
// Fake scripts are added by schemas.ts, to keep the reporter/grant contracts independent.
export const DelegationCreateSchema = z
  .object({
    grant_id: Id,
    delegation_key: Id,
    project_id: Id.optional(),
    base_ref: z.string().min(1).max(256).default('HEAD'),
    title: z.string().max(256),
    provider: z.enum(['fake', 'claude', 'pi']),
    text: z.string().min(1).max(32768),
  })
  .strict()
export const DelegationMethodSchemas = {
  'delegation.grant.create': DelegationGrantRequestSchema,
  'delegation.grant.revoke': z.object({ grant_id: Id }).strict(),
  'delegation.status': z.object({ delegation_id: Id }).strict(),
  'delegation.cancel': z.object({ delegation_id: Id }).strict(),
  'delegation.send': z
    .object({ delegation_id: Id, text: z.string().min(1).max(32768), observed_seq: Sequence })
    .strict(),
} as const
export const DELEGATION_MUTATIONS = [
  'delegation.grant.create',
  'delegation.grant.revoke',
  'delegation.create',
  'delegation.send',
  'delegation.cancel',
] as const
