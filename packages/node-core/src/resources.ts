import { randomUUID, createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { isAbsolute, join, resolve, dirname, basename } from 'node:path'
import { ChannelError, type AuthorityContext } from '@abele/channel-protocol'
import {
  ProjectSchema,
  WorkspaceSchema,
  JobSchema,
  RESOURCE_MUTATIONS,
  WorkspaceStatusSchema,
  WorkspaceDiffSchema,
  type Project,
  type Workspace,
  type Job,
} from '@abele/node-protocol'
import type { NodeCore } from './index.js'
import {
  WorkspaceFileService,
  GitViewService,
  DiffSnapshotStore,
  ReviewBatchService,
} from './files.js'
import { GitRunner, decodeGit, parseWorktrees } from './git.js'
import { FileMutationCoordinator } from './mutations.js'
import { RepositoryService } from './repository.js'
import { RepositoryGitService } from './repository-git.js'
import { NodePathService } from './node-path.js'
import { WorkspaceSearchService } from './workspace-search.js'
import { ExecutionTargetService } from './execution-targets.js'
import { NodeLsp } from './lsp/node.js'

type Params = Record<string, unknown>
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const legacyWorktreeName = (branch: string) => {
  const encoded = encodeURIComponent(branch)
  return encoded.length <= 200
    ? encoded
    : encoded.slice(0, 180) + '-' + createHash('sha256').update(branch).digest('hex').slice(0, 16)
}
const worktreeName = (branch: string) => {
  if (/^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,199}$/.test(branch)) return branch
  const slug = branch
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 180)
  return (slug || 'branch') + '-' + createHash('sha256').update(branch).digest('hex').slice(0, 16)
}
const now = () => new Date().toISOString()
const nodeActor = { kind: 'node' } as const
export interface WorkspaceLease {
  workspace_id: string
  session_id: string
}
function boundedPage<T>(rows: T[]): T[] {
  let bytes = 2
  const page: T[] = []
  for (const row of rows) {
    bytes += Buffer.byteLength(JSON.stringify(row)) + 1
    if (bytes > 128 * 1024) break
    page.push(row)
  }
  if (rows.length && !page.length) throw new ChannelError('output_limit')
  return page
}

export class ProjectService {
  constructor(private resources: ResourceServices) {}
  get(id: string): Project {
    const row = this.resources.core.db
      .prepare('SELECT body FROM projects WHERE project_id=? AND registered=1')
      .get(id) as { body: string } | undefined
    if (!row) throw new ChannelError('not_found')
    return ProjectSchema.parse(JSON.parse(row.body))
  }
  async inspect(
    path: string,
    trust: unknown,
    exactRoot = false
  ): Promise<
    Omit<
      Project,
      'project_id' | 'created_at' | 'use_repository_claude_permissions' | 'codex_network_enabled'
    >
  > {
    if (!isAbsolute(path)) throw new ChannelError('invalid_params')
    let root: string
    try {
      root = realpathSync(path)
      if (!statSync(root).isDirectory()) throw new Error()
    } catch {
      throw new ChannelError('repository_unavailable')
    }
    let repository: string | null = null,
      common: string | null = null
    try {
      repository = realpathSync(await this.resources.git.text(root, { kind: 'root' }))
      common = realpathSync(await this.resources.git.text(root, { kind: 'common' }))
      if (exactRoot && repository !== root) {
        repository = null
        common = null
      } else root = repository
    } catch (error) {
      if (
        !(error instanceof ChannelError) ||
        error.code !== 'git_failed' ||
        existsSync(join(root, '.git'))
      )
        throw new ChannelError('repository_unavailable')
    }
    return {
      root_path: root,
      repository_path: repository,
      git_common_dir: common,
      trust: trust as Project['trust'],
    }
  }
  async available(project: Project): Promise<void> {
    try {
      if (
        realpathSync(project.root_path) !== project.root_path ||
        !statSync(project.root_path).isDirectory()
      )
        throw new Error()
      if (project.repository_path) {
        const identity = await this.resources.git.identity(project.root_path)
        if (
          realpathSync(identity.root) !== project.repository_path ||
          realpathSync(identity.common) !== project.git_common_dir
        )
          throw new Error()
      }
    } catch {
      throw new ChannelError('repository_unavailable')
    }
  }
  list(p: Params) {
    return boundedPage(
      (
        this.resources.core.db
          .prepare(
            'SELECT body FROM projects WHERE registered=1 AND project_id>? ORDER BY project_id LIMIT ?'
          )
          .all(String(p.after_id ?? ''), Number(p.limit)) as { body: string }[]
      ).map((r) => ProjectSchema.parse(JSON.parse(r.body)))
    )
  }
}

export class WorkspaceService {
  constructor(private resources: ResourceServices) {}
  get(id: string): Workspace {
    const row = this.resources.core.db
      .prepare('SELECT body FROM workspaces WHERE workspace_id=?')
      .get(id) as { body: string } | undefined
    if (!row) throw new ChannelError('not_found')
    return WorkspaceSchema.parse(JSON.parse(row.body))
  }
  async list(p: Params): Promise<Workspace[]> {
    const project = this.resources.projects.get(String(p.project_id))
    // A successful Git observation distinguishes removed worktrees from an
    // unavailable project. Never infer deletion from a failed command.
    if (project.git_common_dir) {
      await this.resources.projects.available(project)
      const records = parseWorktrees(
        await this.resources.git.run(project.root_path, { kind: 'worktrees' })
      )
      this.reconcile(project.project_id, new Set(records.map((r) => r.path)))
    }
    return boundedPage(
      (
        this.resources.core.db
          .prepare(
            "SELECT body FROM workspaces WHERE project_id=? AND workspace_id>? AND state!='removed' ORDER BY workspace_id LIMIT ?"
          )
          .all(String(p.project_id), String(p.after_id ?? ''), Number(p.limit)) as {
          body: string
        }[]
      ).map((r) => WorkspaceSchema.parse(JSON.parse(r.body)))
    )
  }
  reconcile(project_id: string, paths: Set<string>) {
    this.resources.core.transaction(() => {
      for (const row of this.resources.core.db
        .prepare("SELECT body FROM workspaces WHERE project_id=? AND state='ready'")
        .all(project_id) as { body: string }[]) {
        const workspace = WorkspaceSchema.parse(JSON.parse(row.body))
        if (workspace.kind === 'managed' && !paths.has(workspace.path)) {
          this.save({ ...workspace, state: 'removed' })
          this.resources.core.db
            .prepare('DELETE FROM workspace_leases WHERE workspace_id=?')
            .run(workspace.workspace_id)
        }
      }
    })
  }
  save(
    workspace: Workspace,
    actor = nodeActor as import('@abele/channel-protocol').JournalEvent['actor']
  ) {
    WorkspaceSchema.parse(workspace)
    this.resources.core.db
      .prepare('UPDATE workspaces SET state=?,body=? WHERE workspace_id=?')
      .run(workspace.state, JSON.stringify(workspace), workspace.workspace_id)
    this.resources.core.append('catalog', 'workspace.changed', actor, workspace)
  }
  leased(id: string): boolean {
    return !!this.resources.core.db
      .prepare('SELECT 1 FROM workspace_leases WHERE workspace_id=?')
      .get(id)
  }
  assertLease(id: string, session: string) {
    if (
      !this.resources.core.db
        .prepare('SELECT 1 FROM workspace_leases WHERE workspace_id=? AND session_id=?')
        .get(id, session)
    )
      throw new ChannelError('resource_busy')
  }
  lease(id: string, session: string, provisioning = false): WorkspaceLease {
    const workspace = this.get(id)
    if (workspace.kind !== 'managed') throw new ChannelError('git_required')
    if (workspace.state !== (provisioning ? 'provisioning' : 'ready'))
      throw new ChannelError('resource_busy')
    // Ordinary chats may share bindings. A delegated child's retained lease
    // stays exclusive, including across provisioning cancellation and restart.
    const holder = this.resources.core.db
      .prepare(
        'SELECT d.delegation_id,d.session_id FROM workspace_leases l JOIN delegations d ON d.session_id=l.session_id WHERE l.workspace_id=? AND l.session_id<>?'
      )
      .get(id, session) as { delegation_id: string; session_id: string } | undefined
    if (holder)
      throw new ChannelError(
        'resource_busy',
        `resource_busy: workspace held by delegation ${this.resources.core.session(holder.session_id).title} (${holder.delegation_id})`,
        { holder: 'delegation', ...holder }
      )
    this.resources.core.db.prepare('INSERT INTO workspace_leases VALUES(?,?)').run(id, session)
    return { workspace_id: id, session_id: session }
  }
  /** Canonical node-owned parents, no symlinks, no caller-controlled paths. Never rm -rf. */
  managed(workspace: Workspace, createParents = false) {
    const legacy = join(this.resources.worktreeRoot, workspace.project_id, workspace.workspace_id)
    const root =
      workspace.path === legacy
        ? join(this.resources.worktreeRoot, workspace.project_id)
        : this.resources.workspaceRoot(this.resources.projects.get(workspace.project_id))
    if (
      workspace.kind !== 'managed' ||
      !uuid.test(workspace.project_id) ||
      !uuid.test(workspace.workspace_id) ||
      (workspace.path !== legacy &&
        workspace.path !== join(root, worktreeName(workspace.branch!)) &&
        workspace.path !== join(root, legacyWorktreeName(workspace.branch!)))
    )
      throw new ChannelError('unmanaged_workspace')
    try {
      for (const path of [dirname(root), root]) {
        if (createParents && !existsSync(path)) mkdirSync(path, { mode: 0o700 })
        if (
          lstatSync(path).isSymbolicLink() ||
          !statSync(path).isDirectory() ||
          realpathSync(path) !== path
        )
          throw new Error()
      }
      if (
        existsSync(workspace.path) ||
        (() => {
          try {
            lstatSync(workspace.path)
            return true
          } catch {
            return false
          }
        })()
      ) {
        if (
          lstatSync(workspace.path).isSymbolicLink() ||
          !statSync(workspace.path).isDirectory() ||
          realpathSync(workspace.path) !== workspace.path
        )
          throw new Error()
      }
    } catch {
      throw new ChannelError('unmanaged_workspace')
    }
  }
  async bound(workspace: Workspace): Promise<Project> {
    if (workspace.state !== 'ready' && workspace.state !== 'removing')
      throw new ChannelError('resource_busy')
    const project = this.resources.projects.get(workspace.project_id)
    await this.resources.projects.available(project)
    if (workspace.kind === 'managed') {
      this.managed(workspace)
      const record = parseWorktrees(
        await this.resources.git.run(project.root_path, { kind: 'worktrees' })
      ).find((w) => w.path === workspace.path)
      if (
        !existsSync(workspace.path) ||
        !record ||
        record.branch !== 'refs/heads/' + workspace.branch
      )
        throw new ChannelError('unmanaged_workspace')
      if (
        realpathSync(await this.resources.git.text(workspace.path, { kind: 'common' })) !==
          project.git_common_dir ||
        realpathSync(await this.resources.git.text(workspace.path, { kind: 'root' })) !==
          workspace.path ||
        (await this.resources.git.text(workspace.path, { kind: 'branch' })) !==
          'refs/heads/' + workspace.branch
      )
        throw new ChannelError('unmanaged_workspace')
    }
    return project
  }
  async clean(workspace: Workspace) {
    await this.bound(workspace)
    if (this.resources.targets.leasedPath(workspace.path)) throw new ChannelError('resource_busy')
    if (
      (await this.resources.git.run(workspace.path, { kind: 'status' })).length ||
      (await this.resources.git.run(workspace.path, { kind: 'untracked' })).length
    )
      throw new ChannelError('workspace_dirty')
  }
  async status(p: Params) {
    const workspace = this.get(String(p.workspace_id)),
      project = await this.bound(workspace)
    if (!project.repository_path) throw new ChannelError('git_required')
    const fields = decodeGit(await this.resources.git.run(workspace.path, { kind: 'status' }))
      .split('\0')
      .filter(Boolean)
    const entries: { index: string; worktree: string; path: string; original_path?: string }[] = []
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i]!
      const entry = {
        index: field[0]!,
        worktree: field[1]!,
        path: field.slice(3),
      } as (typeof entries)[number]
      if (/[RC]/.test(field.slice(0, 2))) {
        const original = fields[++i]
        if (!original) throw new ChannelError('git_failed')
        entry.original_path = original
      }
      entries.push(entry)
    }
    const offset = Number(p.offset),
      limit = Number(p.limit)
    const page: typeof entries = []
    let bytes = 0
    for (const entry of entries.slice(offset, offset + limit)) {
      bytes += Buffer.byteLength(JSON.stringify(entry))
      if (bytes > 128 * 1024) break
      page.push(entry)
    }
    const next = offset + page.length
    return WorkspaceStatusSchema.parse({
      workspace_id: workspace.workspace_id,
      entries: page,
      next_offset: next < entries.length ? next : null,
    })
  }
  async diff(id: string) {
    const workspace = this.get(id),
      project = await this.bound(workspace)
    if (!project.repository_path) throw new ChannelError('git_required')
    const head = await this.resources.git.text(workspace.path, { kind: 'resolve', ref: 'HEAD' })
    const diff = decodeGit(await this.resources.git.run(workspace.path, { kind: 'diff' }))
    return WorkspaceDiffSchema.parse({
      workspace_id: id,
      head_commit: head,
      base_commit: workspace.base_commit,
      diff,
    })
  }
}

/** Reconciliation and provisioning share the same state-inspecting algorithm. No blind effect retry. */
export class JobReconciler {
  constructor(private resources: ResourceServices) {}
  async create(
    job: Job,
    workspace: Workspace,
    boundary: (point: 'branch_created' | 'worktree_created') => void
  ) {
    const r = this.resources,
      project = r.projects.get(job.project_id)
    await r.projects.available(project)
    r.workspaces.managed(workspace, true)
    let branch: string | undefined
    try {
      branch = await r.git.text(project.root_path, {
        kind: 'resolve',
        ref: 'refs/heads/' + workspace.branch,
      })
    } catch (e) {
      if (!(e instanceof ChannelError) || e.code !== 'git_failed') throw e
    }
    if (
      branch &&
      ((job.phase === 'planned' && !job.branch_preexisting) || branch !== workspace.base_commit)
    )
      throw new ChannelError('unmanaged_workspace')
    if (!branch) {
      if (job.branch_preexisting) throw new ChannelError('unmanaged_workspace')
      if (job.phase !== 'planned' && job.phase !== 'branch_intent')
        throw new ChannelError('unmanaged_workspace')
      r.jobs.phase(job, 'branch_intent') // durable intent precedes external effect
      await r.git.run(
        project.root_path,
        { kind: 'branch.create', branch: workspace.branch!, commit: workspace.base_commit! },
        () => r.core.authority.check({ installation_id: job.installation_id }, 'provision')
      )
      boundary('branch_created')
    }
    const records = parseWorktrees(await r.git.run(project.root_path, { kind: 'worktrees' }))
    const record = records.find((w) => w.path === workspace.path)
    const branchElsewhere = records.find(
      (w) => w.branch === 'refs/heads/' + workspace.branch && w.path !== workspace.path
    )
    if (branchElsewhere) throw new ChannelError('unmanaged_workspace')
    if (record) {
      if (
        record.branch !== 'refs/heads/' + workspace.branch ||
        record.head !== workspace.base_commit ||
        !existsSync(workspace.path)
      )
        throw new ChannelError('unmanaged_workspace')
    } else {
      if (existsSync(workspace.path)) throw new ChannelError('unmanaged_workspace')
      r.jobs.phase(job, 'branch_created')
      await r.git.run(
        project.root_path,
        { kind: 'worktree.add', branch: workspace.branch!, path: workspace.path },
        () => r.core.authority.check({ installation_id: job.installation_id }, 'provision')
      )
      boundary('worktree_created')
    }
    r.workspaces.managed(workspace)
    chmodSync(workspace.path, 0o700)
    r.core.transaction(() => {
      workspace.state = 'ready'
      r.workspaces.save(workspace)
      job.phase = 'worktree_created'
      job.state = 'succeeded'
      r.jobs.save(job)
    })
  }
  async remove(job: Job, workspace: Workspace, boundary: (point: 'worktree_removed') => void) {
    const r = this.resources,
      project = r.projects.get(job.project_id)
    await r.projects.available(project)
    r.workspaces.managed(workspace)
    if (r.workspaces.leased(workspace.workspace_id)) throw new ChannelError('resource_busy')
    const record = parseWorktrees(await r.git.run(project.root_path, { kind: 'worktrees' })).find(
      (w) => w.path === workspace.path
    )
    if (record || existsSync(workspace.path)) {
      await r.workspaces.clean(workspace) // recheck just before Git; never force
      r.jobs.phase(job, 'remove_intent')
      await r.git.run(project.root_path, { kind: 'worktree.remove', path: workspace.path }, () => {
        r.core.authority.check({ installation_id: job.installation_id }, 'provision')
        r.repository.releaseWatchers(workspace.path)
      })
      boundary('worktree_removed')
    } else if (job.phase !== 'remove_intent') throw new ChannelError('unmanaged_workspace')
    r.core.transaction(() => {
      workspace.state = 'removed'
      r.workspaces.save(workspace)
      job.state = 'succeeded'
      r.jobs.save(job)
    })
  }
}

export class JobService {
  fault?: (point: 'branch_created' | 'worktree_created' | 'worktree_removed') => void
  private active?: Promise<void>
  private stopped = false
  constructor(private resources: ResourceServices) {}
  get(id: string): Job {
    const row = this.resources.core.db.prepare('SELECT body FROM jobs WHERE job_id=?').get(id) as
      { body: string } | undefined
    if (!row) throw new ChannelError('not_found')
    return JobSchema.parse(JSON.parse(row.body))
  }
  list(p: Params): Job[] {
    return boundedPage(
      (
        this.resources.core.db
          .prepare(
            'SELECT body FROM jobs WHERE job_id>? AND (? IS NULL OR project_id=?) ORDER BY job_id LIMIT ?'
          )
          .all(
            String(p.after_id ?? ''),
            p.project_id === undefined ? null : String(p.project_id),
            p.project_id === undefined ? null : String(p.project_id),
            Number(p.limit)
          ) as { body: string }[]
      ).map((r) => JobSchema.parse(JSON.parse(r.body)))
    )
  }
  insert(
    workspace: Workspace,
    kind: Job['kind'],
    actor: AuthorityContext,
    branchPreexisting?: boolean
  ): Job {
    const job = JobSchema.parse({
      job_id: randomUUID(),
      project_id: workspace.project_id,
      workspace_id: workspace.workspace_id,
      kind,
      state: 'queued',
      phase: 'planned',
      installation_id: actor.installation_id,
      created_at: now(),
      updated_at: now(),
      error: null,
      ...(branchPreexisting === undefined ? {} : { branch_preexisting: branchPreexisting }),
    })
    this.resources.core.db
      .prepare('INSERT INTO jobs VALUES(?,?,?,?,?)')
      .run(job.job_id, job.project_id, job.workspace_id, job.state, JSON.stringify(job))
    this.resources.core.append(
      'catalog',
      'job.changed',
      { kind: 'installation', installation_id: actor.installation_id },
      job
    )
    return job
  }
  save(job: Job) {
    job.updated_at = now()
    JobSchema.parse(job)
    this.resources.core.db
      .prepare('UPDATE jobs SET state=?,body=? WHERE job_id=?')
      .run(job.state, JSON.stringify(job), job.job_id)
    this.resources.core.append('catalog', 'job.changed', nodeActor, job)
  }
  phase(job: Job, phase: Job['phase']) {
    this.resources.core.transaction(() => {
      job.phase = phase
      this.save(job)
    })
  }
  drain(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    if (this.active) return this.active
    const rows = this.resources.core.db
      .prepare("SELECT body FROM jobs WHERE state IN ('queued','running') ORDER BY rowid LIMIT 64")
      .all() as { body: string }[]
    const work = async (row: { body: string }) => {
      const job = JobSchema.parse(JSON.parse(row.body)),
        project = this.resources.projects.get(job.project_id)
      await this.resources.git.serialize(project.git_common_dir ?? project.root_path, async () => {
        if (this.stopped) return
        let crashed = false
        const boundary = (point: 'branch_created' | 'worktree_created' | 'worktree_removed') => {
          try {
            this.fault?.(point)
          } catch (e) {
            crashed = true
            throw e
          }
        }
        const workspace = this.resources.workspaces.get(job.workspace_id)
        try {
          this.resources.core.authority.check(
            { installation_id: job.installation_id },
            'provision',
            workspace.workspace_id
          )
          this.resources.core.transaction(() => {
            job.state = 'running'
            this.save(job)
          })
          if (job.kind === 'workspace.create')
            await this.resources.reconciler.create(job, workspace, boundary)
          else await this.resources.reconciler.remove(job, workspace, boundary)
        } catch (e) {
          if (crashed || !(e instanceof ChannelError) || e.code === 'storage_unavailable') throw e
          this.resources.core.transaction(() => {
            workspace.state = 'needs_attention'
            this.resources.workspaces.save(workspace)
            job.state = 'needs_attention'
            job.error = e.code
            this.save(job)
          })
        }
      })
    }
    let index = 0
    this.active = Promise.allSettled(
      Array.from({ length: Math.min(4, rows.length) }, async () => {
        while (index < rows.length) await work(rows[index++]!)
      })
    ).then((results) => {
      const failed = results.find((r) => r.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })
    const active = this.active
    // Wait for every repository worker, even if another worker fails.
    void active
      .finally(() => {
        if (this.active === active) this.active = undefined
      })
      .catch(() => {})
    return active
  }
  async stop() {
    this.stopped = true
    // drain() reports worker errors; teardown must still close SQLite/IPC and release ownership.
    if (this.active) await Promise.allSettled([this.active])
  }
}

export class ResourceServices {
  readonly lsp: NodeLsp
  readonly ready: Promise<unknown>
  readonly search = new WorkspaceSearchService(this)
  readonly nodePath: NodePathService
  readonly targets: ExecutionTargetService
  readonly git: GitRunner
  readonly repository: RepositoryService
  readonly repositoryGit: RepositoryGitService
  readonly files = new WorkspaceFileService(this)
  readonly mutations = new FileMutationCoordinator(this)
  readonly views = new GitViewService(this)
  readonly snapshots = new DiffSnapshotStore(this)
  readonly reviews = new ReviewBatchService(this)
  readonly projects = new ProjectService(this)
  readonly workspaces = new WorkspaceService(this)
  readonly jobs = new JobService(this)
  readonly reconciler = new JobReconciler(this)
  readonly worktreeRoot: string
  private readonly customWorktreeRoot: boolean
  workspaceRoot(project: Project) {
    return this.customWorktreeRoot
      ? join(this.worktreeRoot, project.project_id)
      : join(dirname(project.root_path), basename(project.root_path) + '.worktrees')
  }
  /** A catalog binding is not execution. Preserve the chat, release idle bindings only. */
  async releaseWorktree(actor: AuthorityContext, path: string) {
    const lease = this.core.db
      .prepare('SELECT session_id FROM execution_target_leases WHERE path=?')
      .get(path) as { session_id: string } | undefined
    if (lease)
      throw new ChannelError(
        'resource_busy',
        'resource_busy: execution session ' + this.core.session(lease.session_id).title,
        {
          holder: 'execution',
          session_id: lease.session_id,
          title: this.core.session(lease.session_id).title,
        }
      )
    const sessions = (
      this.core.db
        .prepare(
          'SELECT session_id FROM sessions WHERE session_id NOT IN (SELECT session_id FROM deleted_sessions)'
        )
        .all() as { session_id: string }[]
    ).filter(({ session_id }) => this.targets.pathForSession(session_id) === path)
    const release: string[] = []
    for (const { session_id } of sessions) {
      const last = this.core.db
        .prepare(
          "SELECT json_extract(body,'$.type') AS type FROM events WHERE stream_id=? AND json_extract(body,'$.type') IN ('session.stop_requested','input.accepted') ORDER BY seq DESC LIMIT 1"
        )
        .get(session_id) as { type: string } | undefined
      const persistent = this.core.db
        .prepare('SELECT 1 FROM workspace_leases WHERE session_id=?')
        .get(session_id)
      if (!persistent && last?.type !== 'session.stop_requested') continue
      if (
        last?.type !== 'session.stop_requested' ||
        this.targets.busy(session_id) ||
        this.core.delegations.isActive(session_id)
      )
        throw new ChannelError(
          'resource_busy',
          'resource_busy: session ' + this.core.session(session_id).title,
          {
            holder: 'session',
            session_id,
            title: this.core.session(session_id).title,
          }
        )
      release.push(session_id)
    }
    for (const session_id of release)
      await this.core.request(actor, 'session.detach', { session_id }, randomUUID())
    await this.lsp.releaseRoot(path)
  }
  constructor(
    readonly core: NodeCore,
    configuredRoot?: string,
    git = new GitRunner()
  ) {
    this.git = git
    this.lsp = new NodeLsp(this)
    this.repository = new RepositoryService(this)
    this.repositoryGit = new RepositoryGitService(this)
    this.nodePath = new NodePathService(this)
    this.targets = new ExecutionTargetService(this)
    const stored = core.db.prepare("SELECT value FROM meta WHERE key='worktree_root'").get() as
      { value: string } | undefined
    const layout = core.db
      .prepare("SELECT value FROM meta WHERE key='worktree_root_custom'")
      .get() as { value: string } | undefined
    this.customWorktreeRoot =
      !!configuredRoot ||
      (layout
        ? layout.value === '1'
        : !!(stored && stored.value !== join(realpathSync(core.stateDir), 'worktrees')))
    this.worktreeRoot = resolve(
      configuredRoot ?? stored?.value ?? join(realpathSync(core.stateDir), 'worktrees')
    )
    const changing = stored && stored.value !== this.worktreeRoot
    if (
      changing &&
      core.db
        .prepare("SELECT 1 FROM workspaces WHERE json_extract(body,'$.kind')='managed' LIMIT 1")
        .get()
    )
      throw new Error('worktree_root_already_configured')
    if (
      (!stored || changing) &&
      existsSync(this.worktreeRoot) &&
      readdirSync(this.worktreeRoot).length
    )
      throw new Error('worktree_root_must_be_empty')
    if (!existsSync(this.worktreeRoot))
      mkdirSync(this.worktreeRoot, { recursive: true, mode: 0o700 })
    if (
      lstatSync(this.worktreeRoot).isSymbolicLink() ||
      realpathSync(this.worktreeRoot) !== this.worktreeRoot ||
      statSync(this.worktreeRoot).uid !== process.getuid!()
    )
      throw new Error('unmanaged_worktree_root')
    chmodSync(this.worktreeRoot, 0o700)
    core.db
      .prepare(
        "INSERT INTO meta VALUES('worktree_root',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      )
      .run(this.worktreeRoot)
    core.db
      .prepare(
        "INSERT INTO meta VALUES('worktree_root_custom',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
      )
      .run(this.customWorktreeRoot ? '1' : '0')
    this.ready = core.db.prepare('SELECT 1 FROM repository_deletions LIMIT 1').get()
      ? Promise.resolve().then(() => this.repository.recoverDeletions())
      : Promise.resolve([])
  }
  async stop() {
    await this.core.manager?.stop()
    await this.lsp.stop()
    this.nodePath.stop()
    await this.ready
    await this.search.stop()
    await this.repository.stop()
    await this.jobs.stop()
  }
  /** Read-only preparation; reservation and its provisioning job commit with the caller's receipt. */
  async prepareWorkspace(project_id: string, base_ref: string, branch?: string) {
    const project = this.projects.get(project_id)
    if (!project.repository_path) throw new ChannelError('git_required')
    await this.projects.available(project)
    try {
      let existing: string | undefined
      if (branch) {
        await this.git.run(project.root_path, { kind: 'branch.validate', branch })
        if (
          parseWorktrees(await this.git.run(project.root_path, { kind: 'worktrees' })).some(
            (w) => w.branch === 'refs/heads/' + branch
          )
        )
          throw new ChannelError('resource_busy')
        try {
          existing = await this.git.text(project.root_path, {
            kind: 'resolve',
            ref: 'refs/heads/' + branch,
          })
        } catch (e) {
          if (!(e instanceof ChannelError) || e.code !== 'git_failed') throw e
        }
      }
      return {
        project_id,
        base:
          existing ?? (await this.git.text(project.root_path, { kind: 'resolve', ref: base_ref })),
        ...(branch ? { branch, branch_preexisting: existing !== undefined } : {}),
      }
    } catch (e) {
      if (e instanceof ChannelError && e.code === 'git_failed')
        throw new ChannelError('invalid_ref')
      throw e
    }
  }
  /** Must be called inside the state transaction. No filesystem effects. */
  reserveWorkspace(
    actor: AuthorityContext,
    operation: string,
    prepared: { project_id: string; base: string; branch?: string; branch_preexisting?: boolean }
  ) {
    const project = this.projects.get(prepared.project_id)
    const workspace_id = randomUUID()
    const workspace = WorkspaceSchema.parse({
      workspace_id,
      project_id: project.project_id,
      kind: 'managed',
      path: join(
        this.workspaceRoot(project),
        worktreeName(prepared.branch ?? 'abele/' + workspace_id)
      ),
      branch: prepared.branch ?? 'abele/' + workspace_id,
      base_commit: prepared.base,
      state: 'provisioning',
      created_at: now(),
      provenance: {
        node_id: this.core.node_id,
        installation_id: actor.installation_id,
        operation_id: operation,
      },
    })
    this.core.db
      .prepare('INSERT INTO workspaces VALUES(?,?,?,?)')
      .run(workspace_id, workspace.project_id, workspace.state, JSON.stringify(workspace))
    this.core.append(
      'catalog',
      'workspace.changed',
      { kind: 'installation', installation_id: actor.installation_id },
      workspace
    )
    return {
      workspace_id,
      job_id: this.jobs.insert(workspace, 'workspace.create', actor, prepared.branch_preexisting)
        .job_id,
    }
  }
  async request(
    actor: AuthorityContext,
    method: string,
    p: Params,
    operation?: string
  ): Promise<unknown> {
    this.core.authority.check(
      actor,
      'resource',
      String(p.project_id ?? p.workspace_id ?? p.job_id ?? '')
    )
    if (this.nodePath.handles(method)) return this.nodePath.request(actor, method, p, operation)
    if (
      [
        'repository.v1.editing',
        'repository.v1.write',
        'repository.v1.restore',
        'repository.v1.recovery.read',
      ].includes(method)
    )
      return this.repository.mutation(actor, method, p, operation)
    if (this.repositoryGit.handles(method))
      return this.repositoryGit.request(actor, method, p, operation)
    if (method.startsWith('repository.v1.')) return this.repository.request(actor, method, p)
    if (method === 'project.repository_settings')
      return this.repository.settings(actor, p, operation)
    if (method === 'project.repository_settings.get')
      return this.repository.settingsOf(String(p.project_id))
    if (RESOURCE_MUTATIONS.includes(method as (typeof RESOURCE_MUTATIONS)[number])) {
      const previous = this.core.operationReceipt(actor, method, p, operation)
      if (previous) return previous.result
      if (method === 'project.claude_permissions' || method === 'project.codex_permissions')
        return this.core.commitOperation(actor, method, p, operation!, () => {
          const project = this.projects.get(String(p.project_id))
          if (this.targets.projectBusy(project.project_id)) throw new ChannelError('resource_busy')
          if (
            this.core.db
              .prepare(
                "SELECT 1 FROM provider_runs r JOIN workspace_leases l ON l.session_id=r.session_id JOIN workspaces w ON w.workspace_id=l.workspace_id WHERE w.project_id=? AND r.state='active'"
              )
              .get(project.project_id)
          )
            throw new ChannelError('resource_busy')
          if ((p.use_repository_permissions || p.network_enabled) && project.trust !== 'trusted')
            throw new ChannelError('project_untrusted')
          const updated = ProjectSchema.parse({
            ...project,
            ...(method === 'project.codex_permissions'
              ? { codex_network_enabled: p.network_enabled }
              : { use_repository_claude_permissions: p.use_repository_permissions }),
          })
          this.core.db
            .prepare('UPDATE projects SET body=? WHERE project_id=?')
            .run(JSON.stringify(updated), project.project_id)
          this.core.append(
            'catalog',
            method + '.changed',
            { kind: 'installation', installation_id: actor.installation_id },
            updated
          )
          return updated
        })
      if (method === 'project.register') {
        const inspected = await this.projects.inspect(
          String(p.path),
          p.trust,
          Boolean(p.exact_root)
        )
        if (
          inspected.repository_path &&
          (this.worktreeRoot === inspected.repository_path ||
            this.worktreeRoot.startsWith(inspected.repository_path + '/'))
        )
          throw new ChannelError('invalid_params')
        return this.core.commitOperation(actor, method, p, operation!, () => {
          let existing = this.core.db
            .prepare('SELECT body,registered FROM projects WHERE root_path=?')
            .get(inspected.root_path) as { body: string; registered: number } | undefined
          if (existing && !existing.registered) {
            const previous = ProjectSchema.parse(JSON.parse(existing.body))
            if (!this.repository.sameRegistration(previous, inspected)) {
              // Preserve old sessions/provenance while freeing the unique lookup
              // slot for a different filesystem identity at this path.
              this.core.db
                .prepare('UPDATE projects SET root_path=? WHERE project_id=?')
                .run('retired:' + previous.project_id, previous.project_id)
              existing = undefined
            }
          }
          if (existing) {
            const project = ProjectSchema.parse(JSON.parse(existing.body))
            if (
              project.repository_path &&
              (project.repository_path !== inspected.repository_path ||
                project.git_common_dir !== inspected.git_common_dir)
            )
              throw new ChannelError('repository_unavailable')
            // Explicit external git init + re-registration upgrades a folder; never init implicitly.
            // Registration restores identity, not trust. Read trust inside the
            // commit so an explicit change during inspection also wins. The
            // identity checks below must still succeed before anything commits.
            const refreshed = ProjectSchema.parse({
              ...project,
              ...inspected,
              trust: project.trust,
            })
            if (!existing.registered || (!project.repository_path && inspected.repository_path)) {
              this.core.db
                .prepare('UPDATE projects SET registered=1,body=? WHERE project_id=?')
                .run(JSON.stringify(refreshed), project.project_id)
              this.core.append(
                'catalog',
                'project.registered',
                { kind: 'installation', installation_id: actor.installation_id },
                refreshed
              )
            }
            this.repository.registered(refreshed, !existing.registered)
            return refreshed
          }
          const project = ProjectSchema.parse({
            ...inspected,
            project_id: randomUUID(),
            created_at: now(),
          })
          this.core.db
            .prepare('INSERT INTO projects(project_id,root_path,body) VALUES(?,?,?)')
            .run(project.project_id, project.root_path, JSON.stringify(project))
          this.core.append(
            'catalog',
            'project.registered',
            { kind: 'installation', installation_id: actor.installation_id },
            project
          )
          const workspace = WorkspaceSchema.parse({
            workspace_id: randomUUID(),
            project_id: project.project_id,
            kind: 'root',
            path: project.root_path,
            branch: null,
            base_commit: null,
            state: 'ready',
            created_at: now(),
            provenance: {
              node_id: this.core.node_id,
              installation_id: actor.installation_id,
              operation_id: operation!,
            },
          })
          this.core.db
            .prepare('INSERT INTO workspaces VALUES(?,?,?,?)')
            .run(
              workspace.workspace_id,
              workspace.project_id,
              workspace.state,
              JSON.stringify(workspace)
            )
          this.core.append('catalog', 'workspace.changed', nodeActor, workspace)
          this.repository.registered(project)
          return project
        })
      }
      if (method === 'project.remove')
        return this.core.commitOperation(actor, method, p, operation!, () => {
          this.projects.get(String(p.project_id))
          if (this.targets.projectBusy(String(p.project_id)))
            throw new ChannelError('resource_busy')
          const workspaces = this.core.db
            .prepare('SELECT body FROM workspaces WHERE project_id=?')
            .all(String(p.project_id)) as { body: string }[]
          if (
            workspaces.some((row) => {
              const w = WorkspaceSchema.parse(JSON.parse(row.body))
              return (
                (w.kind === 'managed' && w.state !== 'removed') ||
                this.workspaces.leased(w.workspace_id) ||
                this.targets.leasedPath(w.path)
              )
            })
          )
            throw new ChannelError('resource_busy')
          this.repository.removed(String(p.project_id))
          // Unregister, never erase durable provenance/jobs or their retry receipts.
          this.core.db
            .prepare('UPDATE projects SET registered=0 WHERE project_id=?')
            .run(String(p.project_id))
          this.core.append(
            'catalog',
            'project.removed',
            { kind: 'installation', installation_id: actor.installation_id },
            { project_id: p.project_id }
          )
          return { project_id: p.project_id, removed: true }
        })
      if (method === 'workspace.create') {
        const prepared = await this.prepareWorkspace(
          String(p.project_id),
          String(p.base_ref),
          p.branch as string | undefined
        )
        return this.core.commitOperation(actor, method, p, operation!, () =>
          this.reserveWorkspace(actor, operation!, prepared)
        )
      }
      if (method === 'workspace.remove') {
        const workspace = this.workspaces.get(String(p.workspace_id)),
          project = this.projects.get(workspace.project_id)
        if (workspace.kind !== 'managed') throw new ChannelError('unmanaged_workspace')
        await this.releaseWorktree(actor, workspace.path)
        if (workspace.state !== 'ready' || this.workspaces.leased(workspace.workspace_id))
          throw new ChannelError('resource_busy')
        return this.git.serialize(project.git_common_dir!, async () => {
          // Repeat receipt and preconditions after waiting for the repository lock.
          const previous = this.core.operationReceipt(actor, method, p, operation)
          if (previous) return previous.result
          const current = this.workspaces.get(workspace.workspace_id)
          if (current.state !== 'ready' || this.workspaces.leased(current.workspace_id))
            throw new ChannelError('resource_busy')
          await this.workspaces.clean(current)
          return this.core.commitOperation(actor, method, p, operation!, () => {
            if (this.workspaces.leased(current.workspace_id))
              throw new ChannelError('resource_busy')
            current.state = 'removing'
            this.workspaces.save(current, {
              kind: 'installation',
              installation_id: actor.installation_id,
            })
            return {
              workspace_id: current.workspace_id,
              job_id: this.jobs.insert(current, 'workspace.remove', actor).job_id,
            }
          })
        })
      }
    }
    switch (method) {
      case 'workspace.write':
        return this.mutations.write(
          actor,
          p as unknown as import('@abele/node-protocol').FileWrite,
          operation
        )
      case 'workspace.restore':
        return this.mutations.restore(
          actor,
          p as unknown as import('@abele/node-protocol').FileRestore,
          operation
        )
      case 'workspace.recovery.read':
        return this.mutations.readRecovery(
          String(p.workspace_id),
          String(p.recovery_path),
          Number(p.offset),
          Number(p.length)
        )
      case 'review.submit':
        return this.reviews.submit(
          actor,
          p as unknown as import('@abele/node-protocol').ReviewBatch,
          operation
        )
      case 'workspace.files':
        return this.files.list(
          String(p.workspace_id),
          String(p.path),
          p.after as string | undefined,
          Number(p.limit)
        )
      case 'workspace.stat':
        return this.files.stat(String(p.workspace_id), String(p.path))
      case 'workspace.read':
        return this.files.read(String(p.workspace_id), String(p.path))
      case 'workspace.content':
        return this.files.content(
          String(p.workspace_id),
          String(p.content_id),
          Number(p.offset),
          Number(p.length)
        )
      case 'workspace.diff.capture':
        return this.views.capture(
          String(p.workspace_id),
          p.mode as import('@abele/node-protocol').DiffMode,
          p.commit as string | undefined
        )
      case 'workspace.diff.get':
        return this.snapshots.get(String(p.workspace_id), String(p.diff_id))
      case 'workspace.diff.read': {
        const snapshot = this.snapshots.get(String(p.workspace_id), String(p.diff_id))
        return this.files.content(
          snapshot.workspace_id,
          snapshot.content_id,
          Number(p.offset),
          Number(p.length)
        )
      }
      case 'workspace.log':
        return this.views.log(String(p.workspace_id), Number(p.offset), Number(p.limit))
      case 'workspace.show':
        return this.views.show(String(p.workspace_id), String(p.commit), String(p.path))
      case 'project.list':
        return this.projects.list(p)
      case 'project.get':
        return this.projects.get(String(p.project_id))
      case 'workspace.list':
        return this.workspaces.list(p)
      case 'workspace.get':
        return this.workspaces.get(String(p.workspace_id))
      case 'workspace.status':
        return this.workspaces.status(p)
      case 'workspace.diff':
        return this.workspaces.diff(String(p.workspace_id))
      case 'job.get':
        return this.jobs.get(String(p.job_id))
      case 'job.list':
        return this.jobs.list(p)
      default:
        throw new ChannelError('unsupported_method')
    }
  }
}
