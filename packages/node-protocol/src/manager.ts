import { z } from 'zod'

const id = z.string().min(1).max(128)
const argument = z
  .string()
  .max(32768)
  .refine((s) => !s.includes('\0'))
const text = argument.refine((s) => s.length > 0)
const session = { session_id: id }
const target = { ...session, worktree_id: id }
const run = { ...session, run_id: id }
const branch = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
const commit = z.string().regex(/^[a-f0-9]{40,64}$/)

/** These methods create exact owner prompts; authentication never implies execution approval. */
export const ManagerMethodSchemas = {
  'command.v1.run': z
    .object({
      ...session,
      worktree_id: id.optional(),
      project_id: id.optional(),
      argv: z
        .array(argument)
        .min(1)
        .max(256)
        .refine((args) => args[0]!.length > 0)
        .optional(),
      command: text.optional(),
      cwd: z.string().min(1).max(4096).optional(),
      env: z
        .record(z.string().max(32768))
        .refine((e) => Object.keys(e).length <= 128)
        .optional(),
      timeout_ms: z.number().int().min(1).max(2147483647).optional(),
      output_bytes: z.number().int().min(1024).max(16384).optional(),
    })
    .strict()
    .refine(
      (p) => (p.argv !== undefined) !== (p.command !== undefined),
      'Supply exactly one of argv or command'
    )
    .refine(
      (p) => (p.worktree_id !== undefined) !== (p.project_id !== undefined),
      'Supply exactly one of project_id or worktree_id; use delegation.status.worktree_id for a child'
    ),
  'command.v1.status': z.object(run).strict(),
  'command.v1.cancel': z.object(run).strict(),
  'git.v1.integrate': z
    .object({
      ...target,
      source_worktree_id: id,
      target_branch: branch,
      source_branch: branch,
      expected_target_head: commit,
      expected_source_head: commit,
      rebase: z.boolean().optional(),
    })
    .strict(),
} as const

export type CommandRunRequest = z.infer<(typeof ManagerMethodSchemas)['command.v1.run']>
export type GitIntegrateRequest = z.infer<(typeof ManagerMethodSchemas)['git.v1.integrate']>

const contextBinding = { context_id: id, parent_chat_id: id }
const contextRun = { ...contextBinding, run_id: id }
export const CommandContextMethodSchemas = {
  'command.context.v1.create': z
    .object({
      parent_chat_id: id,
      project_id: id.optional(),
      worktree_id: id.optional(),
    })
    .strict()
    .refine(
      (p) => (p.project_id !== undefined) !== (p.worktree_id !== undefined),
      'Supply exactly one project_id or worktree_id'
    ),
  'command.context.v1.prepare': ManagerMethodSchemas['command.v1.run']
    .innerType()
    .innerType()
    .omit({ session_id: true, project_id: true, worktree_id: true })
    .extend({
      ...contextBinding,
      permission_mode: z.enum(['ask', 'bypass']),
      justification: z.string().max(512).optional(),
    })
    .strict()
    .refine(
      (p) => (p.argv !== undefined) !== (p.command !== undefined),
      'Supply exactly one argv or command'
    ),
  'command.context.v1.execute': z
    .object({ ...contextRun, action_digest: id, choice: z.enum(['allow', 'deny']) })
    .strict(),
  'command.context.v1.status': z.object(contextRun).strict(),
  'command.context.v1.cancel': z.object(contextRun).strict(),
} as const

/** Provider-independent integration, using the same durable context binding as commands. */
export const IntegrationContextMethodSchemas = {
  'integration.context.v1.create': CommandContextMethodSchemas['command.context.v1.create'],
  'integration.context.v1.prepare': ManagerMethodSchemas['git.v1.integrate']
    .omit({ session_id: true })
    .extend({
      ...contextBinding,
      permission_mode: z.enum(['ask', 'bypass']),
      justification: z.string().max(512).optional(),
    })
    .strict(),
  'integration.context.v1.execute': CommandContextMethodSchemas['command.context.v1.execute'],
  'integration.context.v1.status': CommandContextMethodSchemas['command.context.v1.status'],
  'integration.context.v1.cancel': CommandContextMethodSchemas['command.context.v1.cancel'],
} as const

export const ManagerRunSchema = z
  .object({
    run_id: id,
    prompt_id: id,
    session_id: id,
    method: z.enum(['command.v1.run', 'git.v1.integrate']),
    state: z.enum([
      'pending_approval',
      'running',
      'exited',
      'denied',
      'timed_out',
      'cancelled',
      'applied',
      'failed',
      'outcome_unknown',
    ]),
    reason: z.string().optional(),
    stdout: z.string(),
    stderr: z.string(),
    stdout_truncated: z.boolean(),
    stderr_truncated: z.boolean(),
    exit_code: z.number().int().nullable().optional(),
    signal: z.string().nullable().optional(),
    head: commit.optional(),
    conflicting_files: z.array(z.string()).optional(),
  })
  .strict()
export type ManagerRun = z.infer<typeof ManagerRunSchema>

export const CommandContextSchema = z
  .object({
    context_id: id,
    parent_chat_id: id,
    stream_id: id,
    project_id: id.optional(),
    worktree_id: id.optional(),
  })
  .strict()
export const CommandContextRunSchema = ManagerRunSchema.extend({
  context_id: id,
  permission_mode: z.enum(['ask', 'bypass']),
  justification: z.string().max(512).optional(),
  approval: z.record(z.unknown()).nullable(),
}).strict()
export type CommandContext = z.infer<typeof CommandContextSchema>
export type CommandContextRun = z.infer<typeof CommandContextRunSchema>
export const IntegrationContextSchema = CommandContextSchema
export const IntegrationContextRunSchema = CommandContextRunSchema.extend({
  method: z.literal('git.v1.integrate'),
  stream_id: id,
}).strict()
export type IntegrationContext = z.infer<typeof IntegrationContextSchema>
export type IntegrationContextRun = z.infer<typeof IntegrationContextRunSchema>
