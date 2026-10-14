import { z } from 'zod'
import { DebuggerMethodSchemas } from './debugger.js'
import { DelegationAuthoritySchema } from './delegation.js'

const id = z.string().min(1).max(128)
export const DebuggerActionSchema = z.enum([
  'read',
  'step',
  'continue',
  'pause',
  'breakpoints',
  'launch',
  'attach',
  'detach',
  'terminate',
  'expressions',
])
export const DebuggerModeSchema = z.enum(['ask', 'allow-all'])
export const DebuggerPolicySchema = z
  .object({
    mode: DebuggerModeSchema.default('ask'),
    max_grant_ms: z.number().int().min(1).max(86400000).default(3600000),
    sleep_max_ms: z.number().int().min(0).max(60000).default(60000),
    sleep_wake_on: z
      .array(id)
      .max(32)
      .default([
        'stopped',
        'continued',
        'thread',
        'threads',
        'invalidated',
        'lifecycle',
        'execution_intent',
        'target_replaced',
        'capabilities',
        'control_pending',
        'breakpoints_patch',
        'breakpoints_pending',
        'breakpoints_result',
      ]),
  })
  .strict()
export const DebuggerGrantInputSchema = z
  .object({
    installation_id: id,
    run_id: id,
    task_id: id,
    conversation_id: id,
    workspace_id: id.nullable(),
    target_id: id,
    debug_session_id: id,
    incarnation: id,
    expires_at: z.string().datetime(),
    actions: z.array(DebuggerActionSchema).min(1).max(10),
    mode: DebuggerModeSchema.optional(),
  })
  .strict()
export const DebuggerGrantSchema = DebuggerGrantInputSchema.extend({
  grant_id: id,
  mode: DebuggerModeSchema,
  revoked: z.boolean(),
  owner_authority: DelegationAuthoritySchema,
  controller_authority: DelegationAuthoritySchema,
}).strict()
export type DebuggerGrant = z.infer<typeof DebuggerGrantSchema>
export const DebuggerApprovalSchema = z
  .object({
    principal_key: z.string().min(1).max(512),
    operation_id: id,
    proposal_hash: z.string().min(1).max(128),
    decision: z.enum(['approve', 'deny']),
  })
  .strict()
const relativePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((v) => !v.includes('\0') && !/^([\\/]|[A-Za-z]:)/.test(v), 'relative path')
/** The owner starts a program of a chat's folder under the debugger: `program` and `sources` are
 * paths inside that folder. Only the native JS profile starts anything, and only once installed. */
export const DebuggerStartSchema = z
  .object({
    operation_id: id,
    conversation_id: id,
    program: relativePath,
    argv: z.array(z.string().max(8192)).max(256).default([]),
    sources: z.array(relativePath).max(255).default([]),
  })
  .strict()
export const DebuggerStartResultSchema = z
  .object({
    debug_session_id: id,
    sources: z.array(z.object({ source_id: id, path: z.string().max(4096) }).strict()).max(256),
  })
  .strict()
export type DebuggerStartResult = z.infer<typeof DebuggerStartResultSchema>
/** B3 exposes only authorized implemented methods. Profile startup, source,
 * tools, subscriptions and timers retain their later-stage gates. */
export const DebuggerControlMethodSchemas = {
  'debugger.v1.profiles': DebuggerMethodSchemas['debugger.v1.profiles'],
  'debugger.v1.start': DebuggerStartSchema,
  'debugger.v1.sessions': DebuggerMethodSchemas['debugger.v1.sessions'],
  'debugger.v1.status': DebuggerMethodSchemas['debugger.v1.status'],
  'debugger.v1.commandResult': DebuggerMethodSchemas['debugger.v1.commandResult'],
  'debugger.v1.history': DebuggerMethodSchemas['debugger.v1.history'],
  'debugger.v1.replay': DebuggerMethodSchemas['debugger.v1.replay'],
  'debugger.v1.wait': DebuggerMethodSchemas['debugger.v1.wait'],
  'debugger.v1.sleep': DebuggerMethodSchemas['debugger.v1.sleep'],
  'debugger.v1.cancelWait': DebuggerMethodSchemas['debugger.v1.cancelWait'],
  'debugger.v1.threads': DebuggerMethodSchemas['debugger.v1.threads'],
  'debugger.v1.stack': DebuggerMethodSchemas['debugger.v1.stack'],
  'debugger.v1.scopes': DebuggerMethodSchemas['debugger.v1.scopes'],
  'debugger.v1.variables': DebuggerMethodSchemas['debugger.v1.variables'],
  'debugger.v1.pause': DebuggerMethodSchemas['debugger.v1.pause'],
  'debugger.v1.continue': DebuggerMethodSchemas['debugger.v1.continue'],
  'debugger.v1.step': DebuggerMethodSchemas['debugger.v1.step'],
  'debugger.v1.breakpoints.patch': DebuggerMethodSchemas['debugger.v1.breakpoints.patch'],
  'debugger.v1.exceptionBreakpoints.set':
    DebuggerMethodSchemas['debugger.v1.exceptionBreakpoints.set'],
  'debugger.v1.evaluate': DebuggerMethodSchemas['debugger.v1.evaluate'],
  'debugger.v1.setVariable': DebuggerMethodSchemas['debugger.v1.setVariable'],
  'debugger.v1.detach': DebuggerMethodSchemas['debugger.v1.detach'],
  'debugger.v1.terminate': DebuggerMethodSchemas['debugger.v1.terminate'],
  'debugger.v1.grant.create': DebuggerGrantInputSchema,
  'debugger.v1.grant.revoke': z.object({ grant_id: id }).strict(),
  'debugger.v1.grant.setMode': z.object({ grant_id: id, mode: DebuggerModeSchema }).strict(),
  'debugger.v1.task.settle': z.object({ task_id: id, run_id: id }).strict(),
  'debugger.v1.policy.get': z.object({}).strict(),
  'debugger.v1.policy.set': DebuggerPolicySchema,
  'debugger.v1.approvals': z
    .object({ debug_session_id: id, after: z.string().max(1024).default('') })
    .strict(),
  'debugger.v1.approve': DebuggerApprovalSchema,
} as const
