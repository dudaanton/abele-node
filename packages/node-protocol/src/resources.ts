import { z } from 'zod'
const id = z.string().min(1).max(128)
const path = z.string().min(1).max(4096)
const timestamp = z.string().datetime()
export const TrustSchema = z.enum(['untrusted', 'trusted'])
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
export type Project = z.infer<typeof ProjectSchema>
export const WorkspaceSchema = z
  .object({
    workspace_id: id,
    project_id: id,
    kind: z.enum(['root', 'managed']),
    path,
    branch: z.string().max(256).nullable(),
    base_commit: z
      .string()
      .regex(/^[a-f0-9]{40,64}$/)
      .nullable(),
    state: z.enum(['provisioning', 'ready', 'removing', 'removed', 'needs_attention']),
    created_at: timestamp,
    provenance: z
      .object({
        node_id: id,
        installation_id: id,
        operation_id: id,
      })
      .strict(),
  })
  .strict()
export type Workspace = z.infer<typeof WorkspaceSchema>
export const JobSchema = z
  .object({
    job_id: id,
    project_id: id,
    workspace_id: id,
    kind: z.enum(['workspace.create', 'workspace.remove']),
    state: z.enum(['queued', 'running', 'succeeded', 'failed', 'needs_attention']),
    phase: z.enum([
      'planned',
      'branch_intent',
      'branch_created',
      'worktree_created',
      'remove_intent',
    ]),
    installation_id: id,
    created_at: timestamp,
    updated_at: timestamp,
    error: z.string().max(128).nullable(),
  })
  .strict()
export type Job = z.infer<typeof JobSchema>
export const WorkspaceJobResultSchema = z.object({ workspace_id: id, job_id: id }).strict()
export const StatusEntrySchema = z
  .object({
    index: z.string().length(1),
    worktree: z.string().length(1),
    path,
    original_path: path.optional(),
  })
  .strict()
export const WorkspaceStatusSchema = z
  .object({
    workspace_id: id,
    entries: z.array(StatusEntrySchema).max(256),
    next_offset: z.number().int().min(0).nullable(),
  })
  .strict()
export const WorkspaceDiffSchema = z
  .object({
    workspace_id: id,
    head_commit: z.string().regex(/^[a-f0-9]{40,64}$/),
    base_commit: z.string().nullable(),
    diff: z.string(),
  })
  .strict()
const page = { after_id: id.optional(), limit: z.number().int().min(1).max(256).default(256) }
export const ResourceMethodSchemas = {
  'project.register': z.object({ path, trust: TrustSchema }).strict(),
  'project.list': z.object(page).strict(),
  'project.get': z.object({ project_id: id }).strict(),
  'project.remove': z.object({ project_id: id }).strict(),
  'project.claude_permissions': z
    .object({ project_id: id, use_repository_permissions: z.boolean() })
    .strict(),
  'workspace.create': z
    .object({
      project_id: id,
      // Ref names only, not Git options, revision expressions, or shell text.
      base_ref: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
        .refine((v) => !v.includes('..') && !v.includes('//'))
        .default('HEAD'),
    })
    .strict(),
  'workspace.list': z.object({ project_id: id, ...page }).strict(),
  'workspace.get': z.object({ workspace_id: id }).strict(),
  'workspace.remove': z.object({ workspace_id: id }).strict(),
  'workspace.status': z
    .object({
      workspace_id: id,
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(256).default(256),
    })
    .strict(),
  'workspace.diff': z.object({ workspace_id: id }).strict(),
  'job.get': z.object({ job_id: id }).strict(),
  'job.list': z.object({ project_id: id.optional(), ...page }).strict(),
} as const
export const RESOURCE_MUTATIONS = [
  'project.register',
  'project.remove',
  'project.claude_permissions',
  'workspace.create',
  'workspace.remove',
] as const
