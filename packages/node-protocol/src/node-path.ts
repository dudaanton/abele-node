import { WireTimestampSchema } from '@abele/channel-protocol'
import { z } from 'zod'
import { CommitSchema, RelativePathSchema } from './files.js'
import {
  RepositoryChangesCursorSchema,
  RepositoryRefSchema,
  RepositoryTreeChangeSchema,
} from './repository.js'
import { TrustSchema } from './resources.js'
const id = z.string().min(1).max(128)
export const AbsolutePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => p.startsWith('/') && !p.includes('\0'))
export const SafeBasenameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine(
    (n) =>
      n !== '.' && n !== '..' && n.toLowerCase() !== '.git' && !/[\/\\\u0000-\u001f\u007f]/.test(n)
  )
export const DirectoryPageSchema = z
  .object({
    directory_id: id,
    path: AbsolutePathSchema,
    parent_path: AbsolutePathSchema.nullable(),
    entries: z
      .array(
        z.object({ name: z.string().max(16 * 1024 * 1024), path: AbsolutePathSchema }).strict()
      )
      .max(256),
    cursor: id.nullable(),
    incomplete: z.boolean(),
    omissions: z.array(z.string().max(16 * 1024 * 1024)).max(65536),
  })
  .strict()
export const DirectoryCreatedSchema = z.object({ path: AbsolutePathSchema }).strict()
export const WorktreeSelectionSchema = z
  .object({ project_id: id, worktree_id: id, listed: z.boolean() })
  .strict()
export const DivergenceSchema = z
  .object({
    base_ref: z
      .string()
      .max(16 * 1024 * 1024)
      .nullable(),
    base_commit: CommitSchema.nullable(),
    head_commit: CommitSchema.nullable(),
    ahead: z.number().multipleOf(1).nonnegative().nullable(),
    behind: z.number().multipleOf(1).nonnegative().nullable(),
    reason: z.enum(['ok', 'default_branch_required', 'unborn_head', 'unborn_base']),
  })
  .strict()
export const WorktreeDeletionSchema = z
  .object({
    worktree_id: id,
    state: z.enum(['deleted', 'conflict', 'not_applied', 'outcome_unknown']),
    reconciliation: z.enum(['applied_as_observed', 'not_applied', 'unresolved']).optional(),
    observed_at: WireTimestampSchema.optional(),
    reason: z.string().max(128).optional(),
    reservation_retained: z.boolean().optional(),
  })
  .strict()
export const WorkspaceWatchInvalidationSchema = z
  .object({
    workspace_id: id,
    reason: z.enum(['filesystem', 'reconciliation', 'reconnect', 'overflow']),
    generation: id,
  })
  .strict()
const file = RelativePathSchema.refine(
  (p) => p.length > 0 && !p.split('/').some((s) => s.toLowerCase() === '.git')
)
const contentId = z
  .string()
  .max(16 * 1024 * 1024)
  .regex(/^[a-f0-9]{64}$/)
export const DirectoryManifestSchema = z
  .object({
    content_id: contentId,
    entries: z
      .array(
        z
          .object({
            path: RelativePathSchema,
            kind: z.enum(['file', 'directory']),
            content_id: contentId.nullable(),
          })
          .strict()
      )
      .max(256),
  })
  .strict()
const moveCopy = { from: file, to: file, expected_content_id: contentId }
const move = { ...moveCopy, directory: z.boolean().optional() }
const remove = { path: file, expected_content_id: contentId, directory: z.boolean().optional() }
export const FileOperationResultSchema = z
  .object({
    operation_id: id,
    state: z.enum(['applied', 'conflict', 'outcome_unknown']),
    recovery_path: RelativePathSchema.nullable(),
  })
  .strict()
export const FileOperationMethodSchemas = {
  'workspace.file.move': z.object({ workspace_id: id, ...move }).strict(),
  'workspace.file.copy': z.object({ workspace_id: id, ...moveCopy }).strict(),
  'workspace.file.remove': z.object({ workspace_id: id, ...remove }).strict(),
  'workspace.file.mkdir': z.object({ workspace_id: id, path: file }).strict(),
  'repository.v1.file.move': z.object({ worktree_id: id, ...move }).strict(),
  'repository.v1.file.copy': z.object({ worktree_id: id, ...moveCopy }).strict(),
  'repository.v1.file.remove': z.object({ worktree_id: id, ...remove }).strict(),
  'repository.v1.file.mkdir': z.object({ worktree_id: id, path: file }).strict(),
} as const
export type FileOperationMethod = keyof typeof FileOperationMethodSchemas
import { ExecutionTargetSchema } from './turn.js'
export { ExecutionTargetSchema, type ExecutionTarget } from './turn.js'
export const ExecutionGrantSchema = z
  .object({ project_id: id, target: ExecutionTargetSchema, enabled: z.boolean() })
  .strict()
export const SessionTargetSchema = z
  .object({ project_id: id, target: ExecutionTargetSchema, incarnation: id.optional() })
  .strict()
export const SessionTargetSetSchema = z
  .object({ session_id: id, target: ExecutionTargetSchema })
  .strict()
export const SessionTargetChangedSchema = z
  .object({
    session_id: id,
    project_id: id,
    from: ExecutionTargetSchema,
    to: ExecutionTargetSchema,
    by: z.enum(['owner', 'agent']),
  })
  .strict()
export const ExecutionMethodSchemas = {
  'project.trust': z.object({ project_id: id, trust: TrustSchema }).strict(),
  'project.execution': ExecutionGrantSchema,
  'session.worktree.get': z
    .object({ session_id: id, include_incarnation: z.boolean().optional() })
    .strict(),
  'session.worktree.set': z
    .object({
      session_id: id,
      expected_target: ExecutionTargetSchema,
      target: ExecutionTargetSchema,
    })
    .strict(),
} as const
export const NodePathMethodSchemas = {
  ...ExecutionMethodSchemas,
  ...FileOperationMethodSchemas,
  'workspace.file.directory': z.object({ workspace_id: id, path: file }).strict(),
  'repository.v1.file.directory': z.object({ worktree_id: id, path: file }).strict(),
  'filesystem.v1.directories': z
    .object({
      path: AbsolutePathSchema.optional(),
      cursor: id.optional(),
      limit: z.number().int().min(1).max(256).default(256),
    })
    .strict(),
  'filesystem.v1.mkdir': z.object({ directory_id: id, name: SafeBasenameSchema }).strict(),
  'project.git_init': z.object({ project_id: id, initial_branch: RepositoryRefSchema }).strict(),
  'project.worktree_selection': WorktreeSelectionSchema,
  'repository.v1.divergence': z
    .object({ worktree_id: id, base_ref: RepositoryRefSchema.optional() })
    .strict(),
  'repository.v1.worktree.delete': z
    .object({
      worktree_id: id,
      expected_head: CommitSchema.nullable(),
      expected_observation_id: id,
    })
    .strict(),
  'workspace.search': z
    .object({
      workspace_id: id,
      query: z.string().min(1).max(1024),
      mode: z.enum(['literal', 'regex', 'filename']).default('literal'),
      case_sensitive: z.boolean().default(false),
      path_glob: z.string().max(256).optional(),
      cursor: id.optional(),
      limit: z.number().int().min(1).max(100).default(100),
    })
    .strict(),
  'workspace.watch': z
    .object({ workspace_id: id, changes: RepositoryChangesCursorSchema.nullable().optional() })
    .strict(),
  'workspace.unwatch': z.object({ workspace_id: id, subscription_id: id }).strict(),
} as const
export const NODE_PATH_MUTATIONS = [
  ...(Object.keys(FileOperationMethodSchemas) as FileOperationMethod[]),
  'filesystem.v1.mkdir',
  'project.git_init',
  'project.worktree_selection',
  'repository.v1.worktree.delete',
  'project.trust',
  'project.execution',
  'session.worktree.set',
] as const
export type NodePathMethod = keyof typeof NodePathMethodSchemas
export type NodePathParams<M extends NodePathMethod> = z.input<(typeof NodePathMethodSchemas)[M]>

const workspaceBatch = {
  workspace_id: id,
  stream_id: id,
  revision: z.number().multipleOf(1).positive(),
}
/**
 * `workspace.files_changed`: a plain folder's numbered batches, for a watcher that asked with
 * `changes`. Revisions count up by one per stream; anything else is a gap.
 */
export const WorkspaceChangeBatchSchema = z.discriminatedUnion('complete', [
  z
    .object({
      ...workspaceBatch,
      complete: z.literal(true),
      entries: z.array(RepositoryTreeChangeSchema).max(2048),
    })
    .strict(),
  z
    .object({
      ...workspaceBatch,
      complete: z.literal(false),
      reason: z.enum(['overflow', 'limit', 'unavailable']),
    })
    .strict(),
])
export type WorkspaceChangeBatch = z.infer<typeof WorkspaceChangeBatchSchema>
