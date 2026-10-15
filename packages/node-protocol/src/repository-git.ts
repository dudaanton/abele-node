import { z } from 'zod'
import { CommitSchema, RelativePathSchema } from './files.js'
import { RepositoryRefSchema } from './refs.js'

const id = z.string().min(1).max(128)
/** Worktree-relative, never absolute, `..`, `.git` or NUL; a leading `-` is passed after `--`. */
export const GitPathSchema = RelativePathSchema.refine(
  (p) =>
    p.length > 0 &&
    !p.startsWith('/') &&
    !p.includes('\0') &&
    p.split('/').every((s) => s !== '' && s !== '.' && s !== '..' && s.toLowerCase() !== '.git')
)
const paths = z.array(GitPathSchema).min(1).max(1000)
const head = CommitSchema.nullable()
const target = { worktree_id: id }
const operation = z.enum(['rebase', 'merge'])
const remoteName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
/** Bounds only; the node checks the name with `git check-ref-format` as `refs/heads/<name>`. */
const branchName = z
  .string()
  .min(1)
  .max(255)
  .refine((n) => !n.startsWith('-') && !n.includes('\0'))

export const RepositoryGitMethodSchemas = {
  'repository.v1.git.stage': z
    .object({
      ...target,
      expected_head: head,
      paths: paths.optional(),
      all: z.literal(true).optional(),
    })
    .strict()
    .refine((p) => Boolean(p.paths) !== Boolean(p.all)),
  'repository.v1.git.unstage': z
    .object({
      ...target,
      expected_head: head,
      paths: paths.optional(),
      all: z.literal(true).optional(),
    })
    .strict()
    .refine((p) => Boolean(p.paths) !== Boolean(p.all)),
  'repository.v1.git.discard': z
    .object({
      ...target,
      paths,
      expected_observation_id: id,
      include_staged: z.boolean().default(false),
      confirmed: z.boolean(),
    })
    .strict(),
  'repository.v1.git.commit': z
    .object({
      ...target,
      expected_head: head,
      message: z
        .string()
        .min(1)
        .max(65536)
        .refine((m) => m.trim().length > 0 && !m.includes('\0')),
    })
    .strict(),
  'repository.v1.git.update': z
    .object({ ...target, expected_head: head, base_ref: RepositoryRefSchema.optional() })
    .strict(),
  'repository.v1.git.continue': z.object({ ...target, operation }).strict(),
  'repository.v1.git.abort': z.object({ ...target, operation }).strict(),
  'repository.v1.git.push': z
    .object({
      ...target,
      expected_head: CommitSchema,
      remote: remoteName.optional(),
      /** The remote branch commit the client last saw; replaces it only if it is still there. */
      force_with_lease: CommitSchema.optional(),
    })
    .strict(),
  'repository.v1.git.fetch': z
    .object({ ...target, remote: remoteName.optional(), prune: z.boolean().default(false) })
    .strict(),
  'repository.v1.git.create_branch': z
    .object({
      ...target,
      name: branchName,
      start_point: CommitSchema,
      switch: z.boolean().default(false),
      expected_head: head.optional(),
    })
    .strict()
    .refine((p) => !p.switch || p.expected_head !== undefined),
  'repository.v1.git.info': z.object(target).strict(),
} as const
export type RepositoryGitMethod = keyof typeof RepositoryGitMethodSchemas
export type RepositoryGitParams<M extends RepositoryGitMethod> = z.input<
  (typeof RepositoryGitMethodSchemas)[M]
>
/** Every git write is a durable owner mutation with an operation id; `info` is a read. */
export const REPOSITORY_GIT_MUTATIONS = [
  'repository.v1.git.stage',
  'repository.v1.git.unstage',
  'repository.v1.git.discard',
  'repository.v1.git.commit',
  'repository.v1.git.update',
  'repository.v1.git.continue',
  'repository.v1.git.abort',
  'repository.v1.git.push',
  'repository.v1.git.fetch',
  'repository.v1.git.create_branch',
] as const satisfies readonly RepositoryGitMethod[]

export const GitFailureCodeSchema = z.enum([
  'nothing_staged',
  'identity_missing',
  'hook_failed',
  'conflicted',
  'operation_in_progress',
  'commit_failed',
  'workspace_dirty',
  'detached_head',
  'default_branch_required',
  'base_not_found',
  'fetch_failed',
  'auth_failed',
  'remote_unreachable',
  'update_failed',
  'no_operation',
  'no_remote',
  'remote_required',
  'upstream_mismatch',
  'push_rejected',
  'push_failed',
  'lease_rejected',
  'invalid_branch_name',
  'branch_exists',
  'commit_not_found',
  'managed_branch',
  'switch_failed',
  'git_failed',
])
export type GitFailureCode = z.infer<typeof GitFailureCodeSchema>
const failed = z
  .object({
    state: z.literal('failed'),
    code: GitFailureCodeSchema,
    message: z.string().max(512),
    output: z.string().max(4096),
  })
  .strict()
/** The node lost track of an effect (restart mid-way). Re-read the worktree; never auto-retry. */
const unknown = z.object({ state: z.literal('outcome_unknown') }).strict()
const conflicts = z
  .object({
    state: z.literal('conflicts'),
    operation,
    base_ref: z.string().nullable(),
    conflicted_paths: z.array(z.string()).max(1000),
  })
  .strict()
const person = z.object({ name: z.string(), email: z.string() }).strict()

export const GitIndexResultSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('applied'), head }).strict(),
  failed,
  unknown,
])
export const GitDiscardResultSchema = z.discriminatedUnion('state', [
  z
    .object({ state: z.literal('applied'), head, discarded: z.array(z.string()).max(1000) })
    .strict(),
  failed,
  unknown,
])
export const GitCommitResultSchema = z.discriminatedUnion('state', [
  z
    .object({ state: z.literal('committed'), commit: CommitSchema, parent: head, author: person })
    .strict(),
  failed,
  unknown,
])
export const GitUpdateResultSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('updated'),
      strategy: z.enum(['rebase', 'fast-forward']),
      previous_head: head,
      head,
      base_ref: z.string(),
      base_commit: CommitSchema,
      changed: z.boolean(),
    })
    .strict(),
  conflicts,
  failed,
  unknown,
])
export const GitContinueResultSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('continued'), head }).strict(),
  conflicts,
  failed,
  unknown,
])
export const GitAbortResultSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('aborted'), head }).strict(),
  z.object({ state: z.literal('not_in_progress'), head }).strict(),
  failed,
  unknown,
])
export const GitPushResultSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('pushed'),
      remote: z.string(),
      branch: z.string(),
      upstream: z.string(),
      set_upstream: z.boolean(),
      commit: CommitSchema,
    })
    .strict(),
  failed,
  unknown,
])
const upstream = z
  .object({
    ref: z.string(),
    remote: z.string(),
    branch: z.string(),
    /** The local remote-tracking commit: the lease for a forced push. */
    commit: CommitSchema.nullable(),
    ahead: z.number().int().nonnegative().nullable(),
    behind: z.number().int().nonnegative().nullable(),
  })
  .strict()
const refs = z.array(z.string()).max(1000)
export const GitFetchResultSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('fetched'),
      remote: z.string(),
      pruned: z.boolean(),
      updated: refs,
      removed: refs,
      upstream: upstream.nullable(),
    })
    .strict(),
  failed,
  unknown,
])
export const GitCreateBranchResultSchema = z.discriminatedUnion('state', [
  z
    .object({
      state: z.literal('created'),
      branch: z.string(),
      commit: CommitSchema,
      switched: z.boolean(),
      head,
    })
    .strict(),
  failed,
  unknown,
])
export const GitForgeSchema = z
  .object({
    kind: z.enum(['github', 'gitlab', 'other']),
    host: z.string(),
    owner: z.string(),
    name: z.string(),
  })
  .strict()
export const GitInfoSchema = z
  .object({
    head,
    branch: z.string().nullable(),
    detached: z.boolean(),
    operation: z
      .object({
        kind: z.enum(['rebase', 'merge', 'cherry-pick', 'revert']),
        conflicted_paths: z.array(z.string()).max(1000),
      })
      .strict()
      .nullable(),
    upstream: upstream.nullable(),
    default_branch: z.string().nullable(),
    remotes: z
      .array(
        z.object({ name: z.string(), url: z.string(), forge: GitForgeSchema.nullable() }).strict()
      )
      .max(32),
    author: person.nullable(),
  })
  .strict()
export type GitInfo = z.infer<typeof GitInfoSchema>
export const RepositoryGitResultSchemas = {
  'repository.v1.git.stage': GitIndexResultSchema,
  'repository.v1.git.unstage': GitIndexResultSchema,
  'repository.v1.git.discard': GitDiscardResultSchema,
  'repository.v1.git.commit': GitCommitResultSchema,
  'repository.v1.git.update': GitUpdateResultSchema,
  'repository.v1.git.continue': GitContinueResultSchema,
  'repository.v1.git.abort': GitAbortResultSchema,
  'repository.v1.git.push': GitPushResultSchema,
  'repository.v1.git.fetch': GitFetchResultSchema,
  'repository.v1.git.create_branch': GitCreateBranchResultSchema,
  'repository.v1.git.info': GitInfoSchema,
} as const satisfies Record<RepositoryGitMethod, z.ZodTypeAny>
export type RepositoryGitResult<M extends RepositoryGitMethod> = z.infer<
  (typeof RepositoryGitResultSchemas)[M]
>

/** Plain sentences for failure codes and for the channel errors these methods throw. */
export const GIT_WRITE_ERROR_MESSAGES: Record<string, string> = {
  nothing_staged: 'Nothing is staged. Stage the changes to commit first.',
  identity_missing:
    'Git does not know who you are in this repository. Set user.name and user.email in git config.',
  hook_failed: 'A git hook in this repository refused the operation.',
  conflicted: 'Some files still have merge conflicts. Resolve them first.',
  operation_in_progress: 'A rebase or merge is in progress here. Continue or abort it first.',
  commit_failed: 'Git could not create the commit.',
  workspace_dirty: 'This worktree has uncommitted changes. Commit or discard them first.',
  detached_head: 'This worktree is not on a branch.',
  default_branch_required: 'Choose the base branch for this repository first.',
  base_not_found: 'The base branch was not found.',
  fetch_failed: 'Could not fetch from the remote.',
  auth_failed: 'The remote refused the credentials. Check your git login for this remote.',
  remote_unreachable: 'The remote could not be reached.',
  update_failed: 'Updating from the base branch failed. The worktree was put back as it was.',
  no_operation: 'There is no rebase or merge in progress here.',
  no_remote: 'This repository has no remote to push to.',
  remote_required: 'This repository has several remotes. Choose which one to push to.',
  upstream_mismatch:
    'This branch tracks a remote branch with another name. Push it from a terminal instead.',
  push_rejected: 'The remote has commits this branch does not have. Update from it first.',
  push_failed: 'Git could not push this branch.',
  lease_rejected:
    'The remote branch changed since you last saw it. Fetch and look at it before pushing again.',
  invalid_branch_name: 'That is not a valid branch name.',
  branch_exists: 'A branch with this name already exists.',
  commit_not_found: 'That commit is not in this repository.',
  managed_branch:
    'This worktree belongs to a node workspace and keeps its branch. Create the branch without switching.',
  switch_failed: 'Git could not switch to the new branch. The branch was not kept.',
  git_failed: 'Git failed.',
  confirmation_required: 'This change cannot be undone and needs an explicit confirmation.',
  stale_revision: 'The worktree changed since it was shown. Refresh and try again.',
  unauthorized: 'Changing this worktree is not allowed. Enable editing for it first.',
  resource_busy: 'The node is busy. Try again in a moment.',
  outcome_unknown: 'The node lost track of this operation. Refresh to see what happened.',
  repository_unavailable: 'The repository is not available.',
  stale_resource: 'This worktree was moved or replaced. Refresh the list.',
}
