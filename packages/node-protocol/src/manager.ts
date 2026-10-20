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
    .refine((p) => (p.argv !== undefined) !== (p.command !== undefined))
    .refine((p) => (p.worktree_id !== undefined) !== (p.project_id !== undefined)),
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
