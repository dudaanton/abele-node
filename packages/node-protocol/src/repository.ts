import { z } from 'zod'
import {
  CommitSchema,
  RelativePathSchema,
  ContentChunkSchema,
  FileWriteSchema,
  FileRestoreSchema,
  FileMutationResultSchema,
} from './files.js'
import { StatusEntrySchema } from './resources.js'
const id = z.string().min(1).max(128)
const path = RelativePathSchema.refine((p) => !p.split('/').some((s) => s.toLowerCase() === '.git'))
const file = path.refine((p) => p.length > 0)
import { RepositoryRefSchema } from './refs.js'
export { RepositoryRefSchema } from './refs.js'
const ref = RepositoryRefSchema
export const RepositoryRevisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('commit'), commit: CommitSchema }).strict(),
  z
    .object({
      kind: z.literal('working'),
      observation_id: id,
      head: CommitSchema.nullable(),
      observed_at: z.string().datetime(),
    })
    .strict(),
])
export type RepositoryRevision = z.infer<typeof RepositoryRevisionSchema>
export const WorktreeEntrySchema = z
  .object({
    worktree_id: id,
    project_id: id,
    workspace_id: id.nullable(),
    kind: z.enum(['root', 'managed', 'external']),
    path_label: z.string().max(4096),
    branch: z.string().nullable(),
    detached: z.boolean(),
    head: CommitSchema.nullable(),
    availability: z.enum(['available', 'missing', 'unavailable', 'bare']),
    locked: z.boolean(),
    prunable: z.boolean(),
    dirty: z.boolean().nullable(),
    listed: z.boolean().optional(),
  })
  .strict()
export type WorktreeEntry = z.infer<typeof WorktreeEntrySchema>
export const RepositoryTreeEntrySchema = z
  .object({
    path,
    name: z.string(),
    kind: z.enum(['file', 'directory', 'symlink', 'submodule']),
    oid: CommitSchema.nullable(),
    size: z.number().int().nonnegative().nullable(),
  })
  .strict()
export const RepositoryCommitSchema = z
  .object({
    commit: CommitSchema,
    parents: z.array(CommitSchema),
    author: z.string(),
    email: z.string(),
    authored_at: z.string(),
    subject: z.string(),
    message: z.string(),
  })
  .strict()
export const RepositoryChangeSchema = z
  .object({
    path: file,
    status: z.string(),
    index: z.string().optional(),
    worktree: z.string().optional(),
  })
  .strict()
export const RepositoryBlameLineSchema = z
  .object({
    line: z.number().int().positive(),
    original_line: z.number().int().positive(),
    commit: CommitSchema.nullable(),
    author: z.string(),
    text: z.string(),
  })
  .strict()
export const RepositorySearchMatchSchema = z
  .object({
    path: file,
    line: z.number().int().nonnegative(),
    text: z.string(),
    content_id: id.nullable(),
  })
  .strict()
const page = { cursor: id.nullable(), incomplete: z.boolean(), omissions: z.array(z.string()) }
export const WorktreePageSchema = z
  .object({ entries: z.array(WorktreeEntrySchema).max(256), ...page })
  .strict()
export const RepositoryTreePageSchema = z
  .object({ entries: z.array(RepositoryTreeEntrySchema).max(256), ...page })
  .strict()
export const RepositoryHistoryPageSchema = z
  .object({ entries: z.array(RepositoryCommitSchema).max(100), ...page })
  .strict()
export const ChangeDetailSchema = z
  .object({
    kind: z.enum(['M', 'A', 'D', 'R', 'conflict']),
    stage: z.enum(['unstaged', 'staged', 'partly']),
    change_id: id,
    changed_at: z.string().datetime(),
    time_basis: z.literal('observed'),
  })
  .strict()
export const DetailedStatusEntrySchema = StatusEntrySchema.merge(ChangeDetailSchema)
export const RepositoryStatusPageSchema = z
  .object({
    entries: z.array(z.union([DetailedStatusEntrySchema, StatusEntrySchema])).max(256),
    ...page,
  })
  .strict()
export const RepositorySearchPageSchema = z
  .object({ entries: z.array(RepositorySearchMatchSchema).max(100), ...page })
  .strict()
export const RepositoryRefsPageSchema = z
  .object({
    entries: z
      .array(
        z
          .object({
            name: z.string(),
            commit: CommitSchema.nullable(),
            symbolic: z.string().nullable(),
          })
          .strict()
      )
      .max(256),
    default_branch: z.string().nullable(),
    ...page,
  })
  .strict()
export const RepositoryComparisonBaseSchema = z.union([
  RepositoryRevisionSchema,
  z.object({ kind: z.literal('empty') }).strict(),
])
export type RepositoryComparisonBase = z.infer<typeof RepositoryComparisonBaseSchema>
export const RepositoryComparisonSchema = z
  .object({
    comparison_id: id,
    base: RepositoryComparisonBaseSchema,
    head: RepositoryRevisionSchema,
    mode: z.enum(['endpoint', 'merge-base', 'staged', 'unstaged']),
    entries: z.array(RepositoryChangeSchema).max(256),
    ...page,
  })
  .strict()
export const RepositoryBlobSchema = z
  .object({
    content_id: id.nullable(),
    size: z.number().int().nonnegative(),
    binary: z.boolean(),
    requires_larger_load: z.boolean(),
    too_large: z.boolean(),
  })
  .strict()
export const RepositoryObservationSchema = z
  .object({ revision: RepositoryRevisionSchema, atomic: z.literal(false) })
  .strict()
export const RepositoryBlameSchema = z
  .object({ content_id: id, entries: z.array(RepositoryBlameLineSchema).max(1500), ...page })
  .strict()
export const RepositoryInvalidationSchema = z
  .object({
    project_id: id,
    worktree_id: id,
    reason: z.enum(['filesystem', 'reconciliation', 'reconnect', 'overflow']),
    generation: id,
  })
  .strict()
export const RepositorySettingsSchema = z
  .object({ project_id: id, external_read: z.boolean(), default_branch: z.string().nullable() })
  .strict()
export const RepositoryUnwatchSchema = z.object({ removed: z.literal(true) }).strict()
/** Where a change-stream client stands: the node run's stream and the last batch applied. */
export const RepositoryChangesCursorSchema = z
  .object({ stream_id: id, revision: z.number().int().nonnegative() })
  .strict()
export type RepositoryChangesCursor = z.infer<typeof RepositoryChangesCursorSchema>
/**
 * A lease. Without `changes` in the request it is the legacy shape and the client rereads on
 * every `repository.invalidated`. With it, `refresh_required: false` means the client's cursor
 * continues the stream, so applying later `repository.changed` batches keeps its view current.
 */
export const RepositoryWatchSchema = z
  .object({
    subscription_id: id,
    expires_at: z.string().datetime(),
    refresh_required: z.boolean(),
    changes: RepositoryChangesCursorSchema.optional(),
  })
  .strict()
const treeEntry = RepositoryTreeEntrySchema
/** Applied in order. A renamed or removed folder carries everything under it; an added folder
 * lists none of its contents, which are read when the folder is opened. */
export const RepositoryTreeChangeSchema = z.discriminatedUnion('change', [
  z.object({ change: z.literal('added'), entry: treeEntry }).strict(),
  z.object({ change: z.literal('modified'), entry: treeEntry }).strict(),
  z.object({ change: z.literal('renamed'), from: file, entry: treeEntry }).strict(),
  z.object({ change: z.literal('deleted'), path: file, kind: treeEntry.shape.kind }).strict(),
])
export type RepositoryTreeChange = z.infer<typeof RepositoryTreeChangeSchema>
/** HEAD, branch and the changed status rows; `entry: null` means the path is clean again. */
export const RepositoryGitChangeSchema = z
  .object({
    head: CommitSchema.nullable(),
    branch: z.string().nullable(),
    detached: z.boolean(),
    status: z
      .array(z.object({ path: file, entry: StatusEntrySchema.nullable() }).strict())
      .max(2048),
  })
  .strict()
const batch = {
  project_id: id,
  worktree_id: id,
  stream_id: id,
  revision: z.number().int().positive(),
}
/** `repository.changed`. Revisions count up by one per stream; anything else is a gap. */
export const RepositoryChangeBatchSchema = z.discriminatedUnion('complete', [
  z
    .object({
      ...batch,
      complete: z.literal(true),
      entries: z.array(RepositoryTreeChangeSchema).max(2048),
      git: RepositoryGitChangeSchema.nullable(),
    })
    .strict(),
  z
    .object({
      ...batch,
      complete: z.literal(false),
      reason: z.enum(['overflow', 'limit', 'unavailable']),
    })
    .strict(),
])
export type RepositoryChangeBatch = z.infer<typeof RepositoryChangeBatchSchema>
const target = { worktree_id: id }
export const RepositoryWriteSchema = FileWriteSchema.omit({ workspace_id: true })
  .extend(target)
  .strict()
export const RepositoryRestoreSchema = FileRestoreSchema.omit({ workspace_id: true })
  .extend(target)
  .strict()
export const RepositoryMutationResultSchema = FileMutationResultSchema.omit({ workspace_id: true })
  .extend(target)
  .strict()
export const RepositoryEditingSchema = z.object({ ...target, enabled: z.boolean() }).strict()
export type RepositoryWrite = z.infer<typeof RepositoryWriteSchema>
export type RepositoryRestore = z.infer<typeof RepositoryRestoreSchema>
export type RepositoryMutationResult = z.infer<typeof RepositoryMutationResultSchema>
const revision = { ...target, revision: RepositoryRevisionSchema }
const paging = { cursor: id.optional(), limit: z.number().int().min(1).max(256).default(256) }
export const RepositoryMethodSchemas = {
  'project.repository_settings': z
    .object({
      project_id: id,
      external_read: z.boolean(),
      default_branch: ref.nullable().optional(),
    })
    .strict(),
  // A read of its own: the project's answer stays the shape released clients parse strictly.
  'project.repository_settings.get': z.object({ project_id: id }).strict(),
  'repository.v1.editing': RepositoryEditingSchema,
  'repository.v1.editing.get': z.object(target).strict(),
  'repository.v1.write': RepositoryWriteSchema,
  'repository.v1.restore': RepositoryRestoreSchema,
  'repository.v1.recovery.read': z
    .object({
      ...target,
      recovery_path: RelativePathSchema,
      offset: z.number().int().nonnegative().default(0),
      length: z.number().int().min(1).max(131072).default(131072),
    })
    .strict(),
  'repository.v1.worktrees': z
    .object({ project_id: id, include_selection: z.boolean().optional(), ...paging })
    .strict(),
  'repository.v1.refs': z.object({ ...target, ...paging }).strict(),
  'repository.v1.resolve': z.object({ ...target, ref }).strict(),
  'repository.v1.observe': z
    .object({ ...target, include_ignored: z.boolean().default(false) })
    .strict(),
  'repository.v1.status': z
    .object({ ...revision, include_change_details: z.boolean().optional(), ...paging })
    .strict(),
  'repository.v1.tree': z.object({ ...revision, path: path.default(''), ...paging }).strict(),
  'repository.v1.blob': z
    .object({ ...revision, path: file, larger: z.boolean().default(false) })
    .strict(),
  'repository.v1.content': z
    .object({
      ...target,
      content_id: id,
      offset: z.number().int().nonnegative().default(0),
      length: z.number().int().min(1).max(131072).default(131072),
    })
    .strict(),
  'repository.v1.history': z
    .object({
      ...revision,
      path: file.optional(),
      cursor: id.optional(),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .strict(),
  'repository.v1.commit': z.object(revision).strict(),
  'repository.v1.compare': z
    .object({
      ...target,
      base: RepositoryComparisonBaseSchema,
      head: RepositoryRevisionSchema,
      mode: z.enum(['endpoint', 'merge-base', 'staged', 'unstaged']).default('endpoint'),
      ...paging,
    })
    .strict(),
  'repository.v1.patch': z.object({ ...target, comparison_id: id, path: file }).strict(),
  'repository.v1.blame': z
    .object({
      ...revision,
      cursor: id.optional(),
      path: file,
      start: z.number().int().min(1).max(1000000).default(1),
      count: z.number().int().min(1).max(1500).default(400),
    })
    .strict(),
  'repository.v1.search': z
    .object({
      ...revision,
      query: z.string().min(1).max(1024),
      scope: z.enum(['repository', 'changed']).default('repository'),
      mode: z.enum(['literal', 'regex', 'filename']).default('literal'),
      case_sensitive: z.boolean().default(false),
      path_glob: z.string().max(256).optional(),
      cursor: id.optional(),
      limit: z.number().int().min(1).max(100).default(100),
    })
    .strict(),
  'repository.v1.watch': z
    .object({ ...target, changes: RepositoryChangesCursorSchema.nullable().optional() })
    .strict(),
  'repository.v1.unwatch': z.object({ ...target, subscription_id: id }).strict(),
} as const
export const RepositoryContentChunkSchema = ContentChunkSchema
export type RepositoryMethod = keyof typeof RepositoryMethodSchemas
export type RepositoryParams<M extends RepositoryMethod> = z.input<
  (typeof RepositoryMethodSchemas)[M]
>
