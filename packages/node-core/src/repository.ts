import { createHash, randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { systemProcessProbe } from '@abele/provider-claude'
import type { ProcessIdentity, ProcessProbe } from '@abele/provider-contract'
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  realpathSync,
  readFileSync,
  readlinkSync,
  readSync,
  watch,
  type FSWatcher,
} from 'node:fs'
import { join, basename } from 'node:path'
import { Worker } from 'node:worker_threads'
import { ChannelError, type AuthorityContext } from '@abele/channel-protocol'
import {
  WorkspaceSchema,
  WorktreePageSchema,
  RepositoryRefsPageSchema,
  type RepositoryRevision,
  type RepositoryComparisonBase,
  type WorktreeEntry,
  type Project,
  type RepositoryMethod,
  type RepositoryParams,
  type RepositoryWrite,
  type RepositoryRestore,
} from '@abele/node-protocol'
import type { ResourceServices } from './resources.js'
import { canonical } from './index.js'
import { RepositoryObjectCache } from './object-cache.js'
import { WorktreeMonitor, pathMetadata, sourceMetadata } from './worktree-monitor.js'
import { ChangeStreams, baselineOf } from './repository-changes.js'
import { decodeGit, parseWorktrees as parseGitWorktrees, type GitCommand } from './git.js'

// Git may retain a logical path after a worktree pool moves behind a symlink.
// Resolve at discovery, before workspace matching and identity pinning. All later
// filesystem checks still require the stored target path to remain canonical.
const parseWorktrees = (bytes: Uint8Array) =>
  parseGitWorktrees(bytes).map((record) => {
    let path = record.path
    try {
      path = realpathSync(path)
    } catch {
      // Keep missing/prunable entries visible without granting filesystem access.
    }
    return { ...record, path, registered_path: record.path }
  })

// Include every component: lstat on just the leaf follows substituted parents.
// Directory timestamps are deliberately excluded (unrelated children may change).
const pathIdentity = (path: string) => {
  const parts: unknown[] = []
  let at = '/'
  for (const component of path.split('/').filter(Boolean)) {
    at = join(at, component)
    const s = lstatSync(at)
    parts.push([at, s.dev, s.ino, s.mode, s.isSymbolicLink() ? readlinkSync(at) : null])
  }
  return hash(JSON.stringify(parts))
}

const hash = (v: string | Uint8Array) => createHash('sha256').update(v).digest('hex')
const stamp = (path: string) => {
  const s = lstatSync(path)
  return `${s.dev}:${s.ino}`
}
const metadata = (path: string) => {
  const s = lstatSync(path)
  return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.mode}`
}
const safePath = (path: string) =>
  !path.startsWith('/') &&
  !path.includes('\0') &&
  (path === '' ||
    path.split('/').every((p) => p && p !== '.' && p !== '..' && p.toLowerCase() !== '.git'))
const ttl = 10 * 60 * 1000
const contentLimit = 64 * 1024 * 1024
interface DeletionIntent {
  target: Target
  project_fingerprint: string
  common_stamp: string
  phase: 'prepared' | 'armed' | 'settled'
  process: ProcessIdentity | null
}
interface DeletionRow {
  principal_id: string
  operation_id: string
  request_hash: string
  body: string | null
}
interface DeletionResult {
  worktree_id: string
  state: 'deleted' | 'not_applied' | 'outcome_unknown'
  reconciliation: 'applied_as_observed' | 'not_applied' | 'unresolved'
  observed_at: string
  reason: string
  reservation_retained: boolean
}
type DeletionReceipt = DeletionResult | { worktree_id: string; state: 'deleted' }
export type RepositoryTarget = Target
interface Target {
  worktree_id: string
  project_id: string
  path: string
  kind: WorktreeEntry['kind']
  workspace_id: string | null
  fingerprint: string
  active: number
  /** Ephemeral per-project access epoch, captured by a request, never persisted as identity. */
  readGeneration?: number
}
interface WorkingSnapshot {
  head: string | null
  files: TreeEntry[]
  status: Status[]
  fingerprint: string
  signature: string
  monitor: WorktreeMonitor
  byPath: Map<string, TreeEntry>
  children: Map<string, TreeEntry[]>
  stamps: Map<string, string | null>
  tracked: Map<string, string[]>
  ignoreStamps: Map<string, string | null>
  started: number
  boundaries: string[]
}
interface Observation {
  target: string
  owner: string
  revision: Extract<RepositoryRevision, { kind: 'working' }>
  fingerprint: string
  files: TreeEntry[]
  status: Status[]
  expires: number
  includeIgnored: boolean
  snapshot: WorkingSnapshot
  registration?: string
}
interface TreeEntry {
  path: string
  name: string
  kind: 'file' | 'directory' | 'symlink' | 'submodule'
  oid: string | null
  size: number | null
}
interface Status {
  index: string
  worktree: string
  path: string
  original_path?: string
  kind?: 'M' | 'A' | 'D' | 'R' | 'conflict'
  stage?: 'unstaged' | 'staged' | 'partly'
  change_id?: string
  changed_at?: string
  time_basis?: 'observed'
}
interface Continuation {
  owner: string
  target: string
  key: string
  rows: unknown[]
  offset: number
  expires: number
  extra: Record<string, unknown>
  omissions: string[]
  scan?: { files: TreeEntry[]; next: number }
}
interface Comparison {
  owner: string
  target: string
  base: RepositoryComparisonBase
  baseObject: string
  head: RepositoryRevision
  mode: 'endpoint' | 'merge-base' | 'staged' | 'unstaged'
  paths: Set<string>
  patches: Map<
    string,
    {
      content_id: string
      size: number
      binary: boolean
      requires_larger_load: boolean
      too_large: boolean
    }
  >
  expires: number
}
interface Subscription {
  owner: AuthorityContext
  target: Target
  fingerprint: string
  /** What a reader sees: announced only when this moves, never on a hint alone. */
  visible: string
  expires: number
  watchers: FSWatcher[]
  timer?: NodeJS.Timeout
  pending?: NodeJS.Timeout
  checking: boolean
  dirty?: 'filesystem' | 'reconciliation' | 'overflow'
  /** A change-stream watcher: gets numbered batches instead of invalidations. */
  changes: boolean
  monitor?: WorktreeMonitor
  detach?: () => void
}

/** Repository targets deliberately do not enter the managed-workspace/provider tables. */
export class RepositoryService {
  deleteFault?: () => void
  deletionProbe: ProcessProbe = systemProcessProbe
  private objectCache = new RepositoryObjectCache()
  private cacheGeneration = 0
  private readGenerations = new Map<string, number>()
  private invalidateReads(project: string) {
    this.readGenerations.set(project, (this.readGenerations.get(project) ?? 0) + 1)
  }
  private checkRead(target: Target) {
    const config = this.config(target.project_id)
    if (
      target.kind === 'external' &&
      (!config.external_read ||
        (target.readGeneration !== undefined &&
          target.readGeneration !== (this.readGenerations.get(target.project_id) ?? 0)))
    )
      throw new ChannelError('unauthorized')
  }
  private clearObjectCache() {
    this.cacheGeneration++
    this.objectCache.clear()
  }
  private monitors = new Map<string, WorktreeMonitor>()
  private snapshots = new Map<string, WorkingSnapshot>()
  private retainedSizes = new WeakMap<object, number>()
  private rowSnapshots = new WeakMap<object, WorkingSnapshot>()
  private observations = new Map<string, Observation>()
  private cursors = new Map<string, Continuation>()
  private comparisons = new Map<string, Comparison>()
  private subscriptions = new Map<string, Subscription>()
  readonly changes = new ChangeStreams(() => randomUUID())
  private workers = new Set<Worker>()
  private reconciliations = new Set<Promise<void>>()
  private active = 0
  private stopped = false
  constructor(private r: ResourceServices) {
    const version = r.core.db
      .prepare("SELECT value FROM meta WHERE key='repository_schema_version'")
      .get() as { value: string } | undefined
    if (version && !['1', '2'].includes(version.value))
      throw new Error('unsupported_repository_database_version')
    r.core.db.exec(`BEGIN IMMEDIATE;
      CREATE INDEX IF NOT EXISTS repository_workspace_path ON workspaces(project_id,json_extract(body,'$.path')) WHERE state!='removed';
      CREATE TABLE IF NOT EXISTS repository_projects(project_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, external_read INTEGER NOT NULL DEFAULT 0, default_branch TEXT);
      CREATE TABLE IF NOT EXISTS repository_targets(worktree_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, workspace_id TEXT, fingerprint TEXT NOT NULL, active INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS repository_contents(worktree_id TEXT NOT NULL, content_id TEXT NOT NULL, content BLOB NOT NULL, touched INTEGER NOT NULL, PRIMARY KEY(worktree_id,content_id));
      CREATE TABLE IF NOT EXISTS repository_deletions(principal_id TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, body TEXT, PRIMARY KEY(principal_id,operation_id));
      CREATE TABLE IF NOT EXISTS repository_deletion_outcomes(principal_id TEXT NOT NULL, operation_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(principal_id,operation_id));
      CREATE TABLE IF NOT EXISTS repository_change_stamps(worktree_id TEXT NOT NULL, path TEXT NOT NULL, fingerprint TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(worktree_id,path));
      CREATE TABLE IF NOT EXISTS repository_selections(installation_id TEXT NOT NULL, project_id TEXT NOT NULL, worktree_id TEXT NOT NULL, listed INTEGER NOT NULL, PRIMARY KEY(installation_id,project_id,worktree_id));
      CREATE TABLE IF NOT EXISTS repository_edit_permissions(worktree_id TEXT PRIMARY KEY REFERENCES repository_targets(worktree_id), enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS repository_recovery_copies(ordinal INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES repository_targets(worktree_id), path TEXT UNIQUE NOT NULL, file_path TEXT NOT NULL, content_id TEXT NOT NULL, size INTEGER NOT NULL);
      INSERT INTO meta VALUES('repository_schema_version','2') ON CONFLICT(key) DO UPDATE SET value='2';
      COMMIT;
    `)
    if (
      !(
        r.core.db.prepare('PRAGMA table_info(repository_deletions)').all() as { name: string }[]
      ).some((c) => c.name === 'body')
    )
      r.core.db.exec('ALTER TABLE repository_deletions ADD COLUMN body TEXT')
  }
  private projectFingerprint(p: Project) {
    return hash(
      JSON.stringify([stamp(p.root_path), p.git_common_dir ? stamp(p.git_common_dir) : null])
    )
  }
  sameRegistration(p: Project, inspected: Pick<Project, 'repository_path' | 'git_common_dir'>) {
    if (
      p.repository_path !== inspected.repository_path ||
      p.git_common_dir !== inspected.git_common_dir
    )
      return false
    try {
      const pin = this.r.core.db
        .prepare('SELECT fingerprint FROM repository_projects WHERE project_id=?')
        .get(p.project_id) as { fingerprint: string } | undefined
      if (pin) return pin.fingerprint === this.projectFingerprint(p)
      // Older unregisters discarded the project pin. A plain repository's root
      // target pins the same root and common directory; linked roots cannot prove it.
      if (p.git_common_dir !== join(p.root_path, '.git')) return false
      const root = this.r.core.db
        .prepare(
          "SELECT fingerprint FROM repository_targets WHERE project_id=? AND kind='root' ORDER BY rowid DESC LIMIT 1"
        )
        .get(p.project_id) as { fingerprint: string } | undefined
      return !!root && root.fingerprint === this.targetFingerprint(p.root_path)
    } catch {
      return false
    }
  }
  registered(p: Project, restore = false) {
    const fingerprint = this.projectFingerprint(p)
    const old = this.r.core.db
      .prepare('SELECT fingerprint FROM repository_projects WHERE project_id=?')
      .get(p.project_id) as { fingerprint: string } | undefined
    if (old && old.fingerprint !== fingerprint) {
      // Only an explicit folder -> Git upgrade may change a pin in place.
      // A repository/common-directory replacement must never inherit sessions
      // or execution grants, even if the linked root and its .git file survived.
      const folderFingerprint = hash(JSON.stringify([stamp(p.root_path), null]))
      if (!p.git_common_dir || old.fingerprint !== folderFingerprint)
        throw new ChannelError('stale_resource')
      this.removed(p.project_id)
    }
    this.r.core.db
      .prepare(
        'INSERT INTO repository_projects(project_id,fingerprint) VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET fingerprint=excluded.fingerprint'
      )
      .run(p.project_id, fingerprint)
    if (restore) {
      const targets = this.r.core.db
        .prepare('SELECT * FROM repository_targets WHERE project_id=? ORDER BY rowid DESC')
        .all(p.project_id) as unknown as Target[]
      const seen = new Set<string>()
      for (const target of targets) {
        if (seen.has(target.path)) continue
        seen.add(target.path)
        try {
          if (
            realpathSync(target.path) === target.path &&
            this.targetFingerprint(target.path) === target.fingerprint
          )
            this.r.core.db
              .prepare('UPDATE repository_targets SET active=1 WHERE worktree_id=?')
              .run(target.worktree_id)
        } catch {
          // Missing/replaced targets stay retired, even when the project returns.
        }
      }
    }
  }
  removed(id: string) {
    this.invalidateReads(id)
    this.clearObjectCache()
    for (const row of this.r.core.db
      .prepare('SELECT worktree_id FROM repository_targets WHERE project_id=?')
      .all(id) as { worktree_id: string }[]) {
      this.dropMonitor(row.worktree_id)
      this.changes.drop(row.worktree_id)
    }
    // Keep the identity pin for safe re-registration, but revoke browsing settings.
    this.r.core.db
      .prepare(
        'UPDATE repository_projects SET external_read=0,default_branch=NULL WHERE project_id=?'
      )
      .run(id)
    this.r.core.db.prepare('UPDATE repository_targets SET active=0 WHERE project_id=?').run(id)
    this.r.core.db
      .prepare(
        'DELETE FROM repository_edit_permissions WHERE worktree_id IN (SELECT worktree_id FROM repository_targets WHERE project_id=?)'
      )
      .run(id)
    for (const [key, s] of this.subscriptions) if (s.target.project_id === id) this.unwatch(key)
  }
  settings(actor: AuthorityContext, p: Record<string, unknown>, operation?: string) {
    const core = this.r.core
    return core.commitOperation(actor, 'project.repository_settings', p, operation, () => {
      const project = this.r.projects.get(String(p.project_id))
      if (
        !p.external_read &&
        this.r.core.db
          .prepare(
            "SELECT 1 FROM execution_target_leases l JOIN repository_targets t ON t.path=l.path WHERE t.project_id=? AND t.kind='external'"
          )
          .get(project.project_id)
      )
        throw new ChannelError('resource_busy')
      this.clearObjectCache()
      this.registered(project)
      if (!p.external_read) this.invalidateReads(project.project_id)
      core.db
        .prepare(
          'UPDATE repository_projects SET external_read=?,default_branch=CASE WHEN ? THEN ? ELSE default_branch END WHERE project_id=?'
        )
        .run(
          p.external_read ? 1 : 0,
          Object.hasOwn(p, 'default_branch') ? 1 : 0,
          p.default_branch === null || p.default_branch === undefined
            ? null
            : String(p.default_branch),
          project.project_id
        )
      if (!p.external_read) {
        const targets = new Set(
          (
            core.db
              .prepare(
                "SELECT worktree_id FROM repository_targets WHERE project_id=? AND kind='external'"
              )
              .all(project.project_id) as { worktree_id: string }[]
          ).map((t) => t.worktree_id)
        )
        for (const [id, o] of this.observations)
          if (targets.has(o.target)) this.observations.delete(id)
        for (const [id, c] of this.cursors)
          if (targets.has(c.target) || c.target === project.project_id) this.cursors.delete(id)
        for (const [id, c] of this.comparisons)
          if (targets.has(c.target)) this.comparisons.delete(id)
        for (const id of targets) {
          this.dropMonitor(id)
          this.changes.drop(id)
          core.db.prepare('DELETE FROM repository_contents WHERE worktree_id=?').run(id)
          core.db.prepare('DELETE FROM repository_edit_permissions WHERE worktree_id=?').run(id)
        }
      }
      if (!p.external_read)
        for (const [key, s] of this.subscriptions)
          if (s.target.project_id === project.project_id && s.target.kind === 'external')
            this.unwatch(key)
      core.append(
        'catalog',
        'project.repository_settings.changed',
        { kind: 'installation', installation_id: actor.installation_id },
        {
          project_id: project.project_id,
          external_read: p.external_read,
          default_branch: p.default_branch ?? null,
        }
      )
      return {
        project_id: project.project_id,
        external_read: p.external_read,
        default_branch: this.config(project.project_id).default_branch,
      }
    })
  }
  /** Whether the project's other worktrees are open to browsing, and its default branch. */
  settingsOf(id: string) {
    const config = this.config(id)
    return {
      project_id: id,
      external_read: Boolean(config.external_read),
      default_branch: config.default_branch,
    }
  }
  private config(id: string): {
    fingerprint: string
    external_read: number
    default_branch: string | null
  } {
    const p = this.r.projects.get(id)
    const row = this.r.core.db
      .prepare('SELECT * FROM repository_projects WHERE project_id=?')
      .get(id) as
      { fingerprint: string; external_read: number; default_branch: string | null } | undefined
    if (!row) {
      this.registered(p)
      return this.config(id)
    }
    try {
      if (row.fingerprint !== this.projectFingerprint(p)) throw new Error()
    } catch {
      throw new ChannelError('stale_resource')
    }
    return row
  }
  checkWorkspaceIdentity(project: string) {
    return this.config(project).fingerprint
  }
  executionIdentity(id: string) {
    const target = this.get(id)
    this.checkRead(target)
    if (!target.active || this.targetFingerprint(target.path) !== target.fingerprint)
      throw new ChannelError('stale_resource')
    if (target.workspace_id && this.r.workspaces.get(target.workspace_id).state !== 'ready')
      throw new ChannelError('resource_busy')
    return { project_id: target.project_id, path: target.path, fingerprint: target.fingerprint }
  }
  async executionTarget(id: string) {
    await this.validate(this.get(id))
    return this.executionIdentity(id)
  }
  private targetFingerprint(path: string) {
    return hash(JSON.stringify([stamp(path), stamp(join(path, '.git'))]))
  }
  private async deletionRegistration(target: Target) {
    const project = this.r.projects.get(target.project_id)
    const matches = parseWorktrees(
      await this.r.git.run(project.root_path, { kind: 'worktrees' })
    ).filter((record) => record.path === target.path && !record.bare)
    if (matches.length !== 1) throw new ChannelError('stale_revision')
    return matches[0]!
  }
  private registrationIdentity(record: { registered_path: string }) {
    return hash(JSON.stringify([record.registered_path, pathIdentity(record.registered_path)]))
  }
  private async validate(target: Target) {
    if (!target.active) throw new ChannelError('stale_resource')
    const project = this.r.projects.get(target.project_id)
    this.checkRead(target)
    // Every read pays for these checks twice, so their Git processes run side by side.
    const available = this.r.projects.available(project)
    const checks = (async () => {
      if (
        realpathSync(target.path) !== target.path ||
        lstatSync(target.path).isSymbolicLink() ||
        this.targetFingerprint(target.path) !== target.fingerprint
      )
        throw new Error()
      const [identity, worktrees] = await Promise.all([
        this.r.git.identity(target.path),
        this.r.git.run(project.root_path, { kind: 'worktrees' }),
      ])
      if (
        realpathSync(identity.root) !== target.path ||
        realpathSync(identity.common) !== project.git_common_dir
      )
        throw new Error()
      const records = parseWorktrees(worktrees)
      if (!records.some((w) => w.path === target.path && !w.bare)) throw new Error()
    })().catch(() => {
      throw new ChannelError('repository_unavailable')
    })
    await Promise.all([available, checks])
    this.checkRead(target)
    return target
  }
  checkPublication(actor: AuthorityContext, p: Record<string, unknown>, result?: unknown) {
    this.r.core.authority.check(actor, 'publish', String(p.worktree_id ?? p.project_id))
    if (p.worktree_id) {
      const target = this.get(String(p.worktree_id)),
        config = this.config(target.project_id)
      if (!target.active) throw new ChannelError('stale_resource')
      if (target.kind === 'external' && !config.external_read)
        throw new ChannelError('unauthorized')
      try {
        if (this.targetFingerprint(target.path) !== target.fingerprint) throw new Error()
      } catch {
        throw new ChannelError('stale_resource')
      }
    } else {
      const config = this.config(String(p.project_id))
      if (
        !config.external_read &&
        result !== undefined &&
        WorktreePageSchema.parse(result).entries.some((entry) => entry.kind === 'external')
      )
        throw new ChannelError('unauthorized')
    }
  }
  /** Synchronous boundary for the existing pinned-descriptor editor, after async Git validation. */
  fileRoot(id: string) {
    const target = this.get(id)
    this.checkEdit(target)
    try {
      if (
        realpathSync(target.path) !== target.path ||
        this.targetFingerprint(target.path) !== target.fingerprint
      )
        throw new Error()
    } catch {
      throw new ChannelError('stale_resource')
    }
    if (target.workspace_id) {
      const w = this.r.workspaces.get(target.workspace_id)
      if (w.state !== 'ready' || w.path !== target.path) throw new ChannelError('resource_busy')
    }
    return target.path
  }
  /** Git writes need what saving a file there needs, after full Git validation. */
  async writableTarget(actor: AuthorityContext, id: string) {
    this.r.core.authority.check(actor, 'mutate', id)
    const target = await this.validate(this.get(id))
    this.fileRoot(id)
    return target
  }
  async readableTarget(actor: AuthorityContext, id: string) {
    this.r.core.authority.check(actor, 'resource', id)
    return this.validate(this.get(id))
  }
  /** Rechecked immediately before a git effect and before its result is published. */
  checkWritable(actor: AuthorityContext, id: string) {
    this.r.core.authority.check(actor, 'mutate', id)
    this.checkPublication(actor, { worktree_id: id })
    this.fileRoot(id)
  }
  headOf(target: RepositoryTarget) {
    return this.head(target)
  }
  async defaultBranchOf(actor: AuthorityContext, target: RepositoryTarget) {
    return RepositoryRefsPageSchema.parse(
      await this.refs(actor, target, 'repository.v1.refs', {
        worktree_id: target.worktree_id,
        limit: 256,
      })
    ).default_branch
  }
  /**
   * The status rows of `paths` as the caller's observation showed them, provided each path, its
   * index entry and HEAD are unchanged since. Other paths may change freely.
   */
  async observedChanges(
    actor: AuthorityContext,
    target: RepositoryTarget,
    observation: string,
    paths: string[]
  ) {
    this.prune()
    const o = this.observations.get(observation)
    if (!o || o.owner !== actor.installation_id || o.target !== target.worktree_id)
      throw new ChannelError('stale_revision')
    if ((await this.head(target)) !== o.revision.head) throw new ChannelError('stale_revision')
    const current = new Map(
      this.parseStatus(await this.r.git.run(target.path, { kind: 'status' })).map((row) => [
        row.path,
        row,
      ])
    )
    return paths.map((path) => {
      const seen = o.status.find((row) => row.path === path),
        now = current.get(path)
      if (!seen || !now || now.index !== seen.index || now.worktree !== seen.worktree)
        throw new ChannelError('stale_revision')
      this.checkObservedPath(target, o.snapshot, path)
      return { path, index: now.index, worktree: now.worktree }
    })
  }
  /** Tell every reader of this worktree to refresh after a git write. */
  gitChanged(actor: AuthorityContext, target: RepositoryTarget) {
    this.r.core.append(
      'catalog',
      'repository.invalidated',
      { kind: 'installation', installation_id: actor.installation_id },
      {
        project_id: target.project_id,
        worktree_id: target.worktree_id,
        reason: 'reconciliation',
        generation: randomUUID(),
      }
    )
  }
  private checkEdit(target: Target) {
    if (!target.active) throw new ChannelError('stale_resource')
    const config = this.config(target.project_id)
    if (target.kind === 'external') {
      const approval = this.r.core.db
        .prepare('SELECT enabled FROM repository_edit_permissions WHERE worktree_id=?')
        .get(target.worktree_id) as { enabled: number } | undefined
      if (!config.external_read || !approval?.enabled) throw new ChannelError('unauthorized')
    }
  }
  private async editJob<T>(work: () => Promise<T>) {
    if (this.stopped || this.active >= 4) throw new ChannelError('resource_busy')
    this.active++
    try {
      return await this.r.git.bounded(15000, work)
    } finally {
      this.active--
    }
  }
  async prepareEdit(actor: AuthorityContext, id: string, path: string) {
    return this.editJob(async () => {
      this.r.core.authority.check(actor, 'mutate', id)
      const target = await this.validate(this.get(id))
      this.fileRoot(id)
      const state = await this.workingState(target)
      if (
        state.files.some(
          (f) => f.kind === 'submodule' && (path === f.path || path.startsWith(f.path + '/'))
        )
      )
        throw new ChannelError('unsafe_path')
      this.r.core.authority.check(actor, 'mutate', id)
      this.fileRoot(id)
    })
  }
  editing(actor: AuthorityContext, p: Record<string, unknown>, operation?: string) {
    return this.editJob(async () => {
      const target = await this.validate(this.get(String(p.worktree_id)))
      if (target.kind !== 'external') throw new ChannelError('invalid_params')
      return this.r.core.commitOperation(actor, 'repository.v1.editing', p, operation, () => {
        this.checkPublication(actor, p)
        this.r.core.db
          .prepare(
            'INSERT INTO repository_edit_permissions VALUES(?,?) ON CONFLICT(worktree_id) DO UPDATE SET enabled=excluded.enabled'
          )
          .run(target.worktree_id, p.enabled ? 1 : 0)
        this.r.core.append(
          'catalog',
          'repository.invalidated',
          { kind: 'installation', installation_id: actor.installation_id },
          {
            project_id: target.project_id,
            worktree_id: target.worktree_id,
            reason: 'reconciliation',
            generation: randomUUID(),
          }
        )
        return { worktree_id: target.worktree_id, enabled: Boolean(p.enabled) }
      })
    })
  }
  async mutation(
    actor: AuthorityContext,
    method: string,
    p: Record<string, unknown>,
    operation?: string
  ) {
    if (this.stopped) throw new ChannelError('resource_busy')
    if (method === 'repository.v1.editing') return this.editing(actor, p, operation)
    let result: unknown
    if (method === 'repository.v1.write')
      result = await this.r.mutations.writeRepository(
        actor,
        p as unknown as RepositoryWrite,
        operation
      )
    else if (method === 'repository.v1.restore')
      result = await this.r.mutations.restoreRepository(
        actor,
        p as unknown as RepositoryRestore,
        operation
      )
    else
      result = await this.editJob(async () => {
        await this.validate(this.get(String(p.worktree_id)))
        this.fileRoot(String(p.worktree_id))
        return this.r.mutations.readRecovery(
          String(p.worktree_id),
          String(p.recovery_path),
          Number(p.offset),
          Number(p.length),
          true
        )
      })
    this.checkPublication(actor, p)
    this.fileRoot(String(p.worktree_id))
    return result
  }
  canPublishInvalidation(data: unknown) {
    try {
      const target = this.get(String((data as { worktree_id: string }).worktree_id))
      const config = this.config(target.project_id)
      return Boolean(target.active && (target.kind !== 'external' || config.external_read))
    } catch {
      return false
    }
  }
  mutationPublication(actor: AuthorityContext, method: string, p: Record<string, unknown>) {
    if (
      ['repository.v1.write', 'repository.v1.restore', 'repository.v1.recovery.read'].includes(
        method
      ) ||
      method.startsWith('repository.v1.file.') ||
      (method.startsWith('repository.v1.git.') && method !== 'repository.v1.git.info')
    ) {
      this.checkPublication(actor, p)
      this.fileRoot(String(p.worktree_id))
    }
  }
  retainEdited(id: string, bytes: Uint8Array) {
    return this.retain(this.get(id), Buffer.from(bytes))
  }
  editedBytes(id: string, content: string) {
    return this.content(this.get(id), content)
  }
  private get(id: string) {
    const row = this.r.core.db
      .prepare('SELECT * FROM repository_targets WHERE worktree_id=?')
      .get(id) as unknown as Target | undefined
    if (!row) throw new ChannelError('not_found')
    return { ...row, readGeneration: this.readGenerations.get(row.project_id) ?? 0 }
  }
  private dropMonitor(id: string) {
    this.monitors.get(id)?.close()
    this.monitors.delete(id)
    this.snapshots.delete(id + ':false')
    this.snapshots.delete(id + ':true')
  }
  private leaseSize(value: object): number {
    // Index-owned arrays are charged once to the separate working-index budget.
    if (this.rowSnapshots.has(value)) return 0
    const known = this.retainedSizes.get(value)
    if (known !== undefined) return known
    const bytes = Buffer.byteLength(
      JSON.stringify(value, (key, v: unknown) =>
        ['snapshot', 'rows', 'files', 'scan'].includes(key)
          ? undefined
          : v instanceof Map
            ? [...v]
            : v instanceof Set
              ? [...v]
              : v
      )
    )
    const shared = value as { rows?: unknown[]; files?: TreeEntry[]; scan?: object }
    const total =
      bytes +
      (shared.rows ? this.leaseSize(shared.rows) : 0) +
      (shared.files ? this.leaseSize(shared.files) : 0) +
      (shared.scan ? this.leaseSize(shared.scan) : 0)
    this.retainedSizes.set(value, total)
    return total
  }
  private restoreBaseline(monitor: WorktreeMonitor, preferred?: WorkingSnapshot) {
    const retained =
      preferred ??
      [
        ...this.snapshots.values(),
        ...[...this.observations.values()].map((o) => o.snapshot),
        ...[...this.cursors.values()].flatMap((c) => [
          this.rowSnapshots.get(c.rows),
          c.scan && this.rowSnapshots.get(c.scan.files),
        ]),
      ].find((s) => s?.monitor === monitor)
    if (retained)
      monitor.capture(retained.stamps, retained.started, retained.boundaries, retained.ignoreStamps)
    else monitor.releaseBaseline()
  }
  private evictSnapshot(snapshot: WorkingSnapshot) {
    for (const [key, state] of this.snapshots) if (state === snapshot) this.snapshots.delete(key)
    for (const [id, observation] of this.observations)
      if (observation.snapshot === snapshot) this.observations.delete(id)
    for (const [id, cursor] of this.cursors)
      if (
        this.rowSnapshots.get(cursor.rows) === snapshot ||
        (cursor.scan && this.rowSnapshots.get(cursor.scan.files) === snapshot)
      )
        this.cursors.delete(id)
    if (snapshot.monitor.ownsBaseline(snapshot.stamps)) this.restoreBaseline(snapshot.monitor)
  }
  private pruneIndexes(keep?: WorkingSnapshot) {
    // Count even old indexes retained only by a lease, once per shared snapshot.
    const cached = new Set(this.snapshots.values())
    const states = new Set(cached)
    for (const observation of this.observations.values()) states.add(observation.snapshot)
    for (const cursor of this.cursors.values()) {
      const state = this.rowSnapshots.get(cursor.rows)
      const scan = cursor.scan && this.rowSnapshots.get(cursor.scan.files)
      if (state) states.add(state)
      if (scan) states.add(scan)
    }
    let bytes = [...states].reduce((sum, state) => sum + this.retainedSizes.get(state)!, 0)
    const oldest = [...states]
      .filter((state) => state !== keep)
      .sort((a, b) => Number(cached.has(a)) - Number(cached.has(b)))
    for (const state of oldest) {
      if (bytes <= 32 * 1024 * 1024) break
      this.evictSnapshot(state)
      bytes -= this.retainedSizes.get(state)!
    }
  }
  private prune(keep?: WorkingSnapshot) {
    for (const [id, monitor] of this.monitors)
      if (monitor.touched + ttl < Date.now()) this.dropMonitor(id)
    for (const map of [this.observations, this.cursors, this.comparisons]) {
      for (const [key, value] of map) if (value.expires < Date.now()) map.delete(key)
      let bytes = [...map.values()].reduce((sum, value) => sum + this.leaseSize(value), 0)
      while (map.size >= 128 || bytes > 8 * 1024 * 1024) {
        const key = map.keys().next().value!
        bytes -= this.leaseSize(map.get(key)!)
        map.delete(key)
      }
    }
    this.pruneIndexes(keep)
  }
  private key(method: string, p: Record<string, unknown>) {
    const { cursor: _c, limit: _l, ...query } = p
    return hash(JSON.stringify([method, query]))
  }
  private page(
    actor: AuthorityContext,
    method: string,
    p: Record<string, unknown>,
    rows: unknown[],
    extra: Record<string, unknown> = {},
    omissions: string[] = [],
    scan?: Continuation['scan']
  ) {
    this.prune()
    const target = String(p.worktree_id ?? p.project_id),
      key = this.key(method, p)
    let offset = 0
    if (p.cursor) {
      const saved = this.cursors.get(String(p.cursor))
      if (
        !saved ||
        saved.owner !== actor.installation_id ||
        saved.target !== target ||
        saved.key !== key
      )
        throw new ChannelError('stale_cursor')
      rows = saved.rows
      offset = saved.offset
      extra = saved.extra
      omissions = saved.omissions
      scan = saved.scan
    }
    const entries: unknown[] = []
    let bytes = Buffer.byteLength(JSON.stringify(extra)) + 1024
    for (const row of rows.slice(offset, offset + Number(p.limit ?? p.count ?? 256))) {
      const size = Buffer.byteLength(JSON.stringify(row)) + 1
      if (bytes + size > 32768) {
        if (!entries.length) throw new ChannelError('output_limit')
        break
      }
      entries.push(row)
      bytes += size
    }
    offset += entries.length
    let cursor: string | null = null
    if (offset < rows.length || scan) {
      cursor = randomUUID()
      const continuation = {
        owner: actor.installation_id,
        target,
        key,
        rows,
        offset,
        expires: Date.now() + ttl,
        extra,
        omissions,
        scan,
      }
      if (this.leaseSize(continuation) > 8 * 1024 * 1024) throw new ChannelError('output_limit')
      this.cursors.set(cursor, continuation)
      this.prune()
    }
    return { ...extra, entries, cursor, incomplete: omissions.length > 0, omissions }
  }
  private continuation(actor: AuthorityContext, method: string, p: Record<string, unknown>) {
    if (!p.cursor) return undefined
    return this.page(actor, method, p, [])
  }
  private async catalog(actor: AuthorityContext, method: string, p: Record<string, unknown>) {
    const project = this.r.projects.get(String(p.project_id)),
      config = this.config(project.project_id),
      readGeneration = this.readGenerations.get(project.project_id) ?? 0
    await this.r.projects.available(project)
    if (!project.git_common_dir) throw new ChannelError('git_required')
    const known = this.r.core.db.prepare(
      "SELECT body FROM workspaces WHERE project_id=? AND json_extract(body,'$.path')=? AND state!='removed' LIMIT 1"
    )
    const records = parseWorktrees(await this.r.git.run(project.root_path, { kind: 'worktrees' }))
    if (records.length > 1024) throw new ChannelError('scan_limit')
    const entries: WorktreeEntry[] = []
    let dirtyChecks = 0
    const seen = new Set<string>()
    for (const record of records) {
      if (seen.has(record.path)) continue
      seen.add(record.path)
      const row = known.get(project.project_id, record.path) as { body: string } | undefined
      const w = row ? WorkspaceSchema.parse(JSON.parse(row.body)) : undefined
      const kind = w?.kind ?? 'external'
      if (kind === 'external' && !config.external_read) continue
      let availability: WorktreeEntry['availability'] = record.bare ? 'bare' : 'available',
        fingerprint = ''
      try {
        fingerprint = this.targetFingerprint(record.path)
        if (realpathSync(record.path) !== record.path || lstatSync(record.path).isSymbolicLink())
          availability = 'unavailable'
      } catch {
        availability = record.bare ? 'bare' : 'missing'
      }
      let target = this.r.core.db
        .prepare(
          'SELECT * FROM repository_targets WHERE project_id=? AND path=? AND active=1 ORDER BY rowid DESC LIMIT 1'
        )
        .get(project.project_id, record.path) as unknown as Target | undefined
      if (target && fingerprint && target.fingerprint !== fingerprint) {
        this.r.core.db
          .prepare('UPDATE repository_targets SET active=0 WHERE worktree_id=?')
          .run(target.worktree_id)
        target = undefined
      }
      if (!target) {
        target = {
          worktree_id: randomUUID(),
          project_id: project.project_id,
          path: record.path,
          kind,
          workspace_id: w?.workspace_id ?? null,
          fingerprint,
          active: 1,
        }
        this.r.core.db
          .prepare('INSERT INTO repository_targets VALUES(?,?,?,?,?,?,?)')
          .run(
            target.worktree_id,
            target.project_id,
            target.path,
            target.kind,
            target.workspace_id,
            target.fingerprint,
            1
          )
      }
      let dirty: boolean | null = null
      if (availability === 'available' && dirtyChecks++ < 64) {
        try {
          await this.validate(target)
          dirty = (await this.r.git.run(target.path, { kind: 'status' })).length > 0
        } catch (error) {
          if (error instanceof ChannelError && ['git_timeout', 'output_limit'].includes(error.code))
            dirtyChecks = 64
          else availability = 'unavailable'
        }
      }
      entries.push({
        worktree_id: target.worktree_id,
        project_id: project.project_id,
        workspace_id: target.workspace_id,
        kind,
        path_label: basename(record.path),
        ...(p.include_identity && availability === 'available'
          ? { identity: { canonical_path: target.path, fingerprint: target.fingerprint } }
          : {}),
        branch: record.branch,
        detached: record.detached,
        head: record.head && !/^0+$/.test(record.head) ? record.head : null,
        availability,
        locked: record.locked,
        prunable: record.prunable,
        dirty,
        ...(p.include_selection
          ? {
              listed:
                kind === 'root' ||
                Boolean(
                  (
                    this.r.core.db
                      .prepare(
                        'SELECT listed FROM repository_selections WHERE installation_id=? AND project_id=? AND worktree_id=?'
                      )
                      .get(actor.installation_id, project.project_id, target.worktree_id) as
                      { listed: number } | undefined
                  )?.listed ?? (kind === 'managed' ? 1 : 0)
                ),
            }
          : {}),
      })
    }
    // Removed records cannot retain read authority even if a directory remains at the old path.
    const old = this.r.core.db
      .prepare('SELECT * FROM repository_targets WHERE project_id=? AND active=1')
      .all(project.project_id) as unknown as Target[]
    for (const t of old)
      if (!seen.has(t.path))
        this.r.core.db
          .prepare('UPDATE repository_targets SET active=0 WHERE worktree_id=?')
          .run(t.worktree_id)
    // Enumeration can yield to an owner opt-out. Recheck before publishing metadata or
    // retaining a continuation, even when this page contains only registered workspaces.
    if (
      entries.some((entry) => entry.kind === 'external') &&
      (!this.config(project.project_id).external_read ||
        readGeneration !== (this.readGenerations.get(project.project_id) ?? 0))
    )
      throw new ChannelError('unauthorized')
    entries.sort((a, b) => (a.kind === 'root' ? 0 : 1) - (b.kind === 'root' ? 0 : 1))
    const resumed = this.continuation(actor, method, p)
    // Catalogue cursors must not silently publish stale authority/discovery results.
    if (resumed) {
      const saved = this.cursors.get(String(p.cursor))!
      if (hash(JSON.stringify(saved.rows)) !== hash(JSON.stringify(entries)))
        throw new ChannelError('stale_cursor')
      return resumed
    }
    return this.page(actor, method, p, entries)
  }
  private deletionSettled(intent: DeletionIntent | undefined): boolean {
    if (intent?.phase === 'prepared' || intent?.phase === 'settled') return true
    if (intent?.process) {
      const p = intent.process,
        actual = this.deletionProbe.identity(p.pid)
      if (actual && (actual.fingerprint !== p.fingerprint || actual.group !== p.group))
        throw new Error('process_identity_changed')
      return !actual && this.deletionProbe.groupMembers(p).length === 0
    }
    // Legacy intents predate the gated process evidence. The old daemon cannot
    // launch another effect after ownership recovery; conservatively require no
    // removal command in a successful system inventory before observing its result.
    const inventory = spawnSync('/bin/ps', ['-axo', 'args='], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 1024 * 1024,
    })
    if (inventory.error || inventory.signal || inventory.status !== 0 || !inventory.stdout.trim())
      throw new Error('process_inventory_unavailable')
    return !inventory.stdout.split('\n').some((line) => /\bworktree\s+remove\b/.test(line))
  }
  private async reconcileDeletion(
    row: DeletionRow,
    legacySuccess = false
  ): Promise<DeletionReceipt> {
    const core = this.r.core
    const reservation = core.db
      .prepare(
        'SELECT * FROM execution_target_reservations WHERE principal_id=? AND operation_id=?'
      )
      .get(row.principal_id, row.operation_id) as
      { worktree_id: string; project_id: string; path: string } | undefined
    let intent: DeletionIntent | undefined, target: Target | undefined
    let reason = 'target_unconfirmed',
      state: DeletionResult['state'] = 'outcome_unknown'
    try {
      intent = row.body ? (JSON.parse(row.body) as DeletionIntent) : undefined
      target = intent?.target ?? (reservation ? this.get(reservation.worktree_id) : undefined)
      if (
        !target ||
        target.kind !== 'external' ||
        (reservation &&
          (target.project_id !== reservation.project_id || target.path !== reservation.path))
      )
        throw new Error('target_unconfirmed')
      reason = 'git_process_unconfirmed'
      if (!this.deletionSettled(intent)) reason = 'git_process_live'
      else {
        reason = 'target_unconfirmed'
        const project = this.r.projects.get(target.project_id),
          config = this.config(project.project_id)
        if (
          intent &&
          (config.fingerprint !== intent.project_fingerprint ||
            stamp(project.git_common_dir!) !== intent.common_stamp)
        )
          throw new Error('target_unconfirmed')
        await this.r.projects.available(project)
        const records = parseWorktrees(
          await this.r.git.run(project.root_path, { kind: 'worktrees' })
        )
        const listed = records.find((w) => w.path === target!.path)
        let present = true
        try {
          lstatSync(target.path)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
          present = false
        }
        if (!listed && !present) state = 'deleted'
        else if (
          listed &&
          !listed.bare &&
          present &&
          this.targetFingerprint(target.path) === target.fingerprint
        ) {
          // Recovery is an owner/state inspection, not a browsing/edit grant. Do
          // not let revoked external-read epochs prevent releasing a settled fence.
          if (
            realpathSync(target.path) !== target.path ||
            lstatSync(target.path).isSymbolicLink() ||
            realpathSync(await this.r.git.text(target.path, { kind: 'root' })) !== target.path ||
            realpathSync(await this.r.git.text(target.path, { kind: 'common' })) !==
              project.git_common_dir
          )
            throw new Error('target_unconfirmed')
          state = 'not_applied'
        }
        if (state !== 'outcome_unknown') reason = 'observed'
      }
    } catch {
      /* Missing identity, failed probes or incomplete Git state retain the fence. */
    }
    const result: DeletionResult = {
      worktree_id: target?.worktree_id ?? reservation?.worktree_id ?? 'unknown',
      state,
      reconciliation:
        state === 'deleted'
          ? 'applied_as_observed'
          : state === 'not_applied'
            ? 'not_applied'
            : 'unresolved',
      observed_at: new Date().toISOString(),
      reason,
      reservation_retained: false,
    }
    return core.transaction(() => {
      const previous = core.storedOperationReceipt(
        row.principal_id,
        row.operation_id,
        row.request_hash
      )
      if (previous && (previous.result as { state?: string }).state !== 'outcome_unknown')
        return previous.result as DeletionReceipt
      result.reservation_retained =
        state === 'outcome_unknown' &&
        !!core.db
          .prepare(
            'SELECT 1 FROM execution_target_reservations WHERE principal_id=? AND operation_id=?'
          )
          .get(row.principal_id, row.operation_id)
      core.db
        .prepare(
          'INSERT INTO repository_deletion_outcomes VALUES(?,?,?) ON CONFLICT(principal_id,operation_id) DO UPDATE SET body=excluded.body'
        )
        .run(row.principal_id, row.operation_id, JSON.stringify(result))
      if (state === 'outcome_unknown') return result
      // This is an observed terminal outcome, not an execution/replay of removal.
      // Normal successful calls retain the established response/receipt shape.
      const receipt: DeletionReceipt =
        legacySuccess && state === 'deleted'
          ? { worktree_id: result.worktree_id, state: 'deleted' }
          : result
      core.db
        .prepare(
          'INSERT INTO operations VALUES(?,?,?,?) ON CONFLICT(principal_id,operation_id) DO UPDATE SET receipt=excluded.receipt'
        )
        .run(row.principal_id, row.operation_id, row.request_hash, JSON.stringify(receipt))
      if (state === 'deleted') {
        core.db
          .prepare('UPDATE repository_targets SET active=0 WHERE worktree_id=?')
          .run(result.worktree_id)
        core.db
          .prepare('DELETE FROM repository_edit_permissions WHERE worktree_id=?')
          .run(result.worktree_id)
        for (const [id, lease] of this.subscriptions)
          if (lease.target.worktree_id === result.worktree_id) this.unwatch(id)
        core.append(
          'catalog',
          'project.worktree.deleted',
          { kind: 'node' },
          { project_id: target!.project_id, worktree_id: result.worktree_id }
        )
      }
      core.db
        .prepare('DELETE FROM repository_deletions WHERE principal_id=? AND operation_id=?')
        .run(row.principal_id, row.operation_id)
      core.db
        .prepare(
          'DELETE FROM execution_target_reservations WHERE principal_id=? AND operation_id=?'
        )
        .run(row.principal_id, row.operation_id)
      core.append('catalog', 'project.worktree.deletion.reconciled', { kind: 'node' }, result)
      return receipt
    })
  }
  /** Startup and protected owner CLI inspection. Never starts or repeats a removal. */
  async recoverDeletions(operation?: string, installation?: string) {
    const rows = this.r.core.db
      .prepare(
        'SELECT * FROM repository_deletions WHERE (? IS NULL OR operation_id=?) AND (? IS NULL OR principal_id=?)'
      )
      .all(
        operation ?? null,
        operation ?? null,
        installation ?? null,
        installation ?? null
      ) as unknown as DeletionRow[]
    for (const row of rows) {
      const reservation = this.r.core.db
        .prepare(
          'SELECT project_id FROM execution_target_reservations WHERE principal_id=? AND operation_id=?'
        )
        .get(row.principal_id, row.operation_id) as { project_id: string } | undefined
      let key = row.principal_id + ':' + row.operation_id
      try {
        key =
          this.r.projects.get(
            reservation?.project_id ?? (JSON.parse(row.body!) as DeletionIntent).target.project_id
          ).git_common_dir ?? key
      } catch {
        /* preserve incomplete evidence */
      }
      await this.r.git.serialize(key, async () => {
        const current = this.r.core.db
          .prepare('SELECT * FROM repository_deletions WHERE principal_id=? AND operation_id=?')
          .get(row.principal_id, row.operation_id) as DeletionRow | undefined
        if (current) await this.r.git.bounded(15000, () => this.reconcileDeletion(current))
      })
    }
    return (
      this.r.core.db
        .prepare(
          'SELECT * FROM repository_deletion_outcomes WHERE (? IS NULL OR operation_id=?) AND (? IS NULL OR principal_id=?) ORDER BY rowid'
        )
        .all(operation ?? null, operation ?? null, installation ?? null, installation ?? null) as {
        principal_id: string
        operation_id: string
        body: string
      }[]
    ).map((row) => ({
      installation_id: row.principal_id,
      operation_id: row.operation_id,
      ...(JSON.parse(row.body) as DeletionResult),
    }))
  }
  checkDeletionPublication(actor: AuthorityContext, p: Record<string, unknown>) {
    const target = this.get(String(p.worktree_id))
    this.r.core.authority.check(actor, 'publish', target.worktree_id)
    this.checkRead(target)
  }
  deleteWorktree(actor: AuthorityContext, p: Record<string, unknown>, operation?: string) {
    return this.editJob(async () => {
      const method = 'repository.v1.worktree.delete',
        core = this.r.core
      const previous = core.operationReceipt(actor, method, p, operation)
      if (
        previous &&
        ((previous.result as { state?: string }).state !== 'outcome_unknown' ||
          !core.db
            .prepare('SELECT 1 FROM repository_deletions WHERE principal_id=? AND operation_id=?')
            .get(actor.installation_id, operation!))
      )
        return previous.result
      const request_hash = hash(canonical({ method, params: p }))
      const target = this.get(String(p.worktree_id))
      if (target.kind !== 'external') throw new ChannelError('unmanaged_workspace')
      const project = this.r.projects.get(target.project_id)
      return this.r.git.serialize(project.git_common_dir!, async () => {
        const previous = core.operationReceipt(actor, method, p, operation)
        // An in-flight effect owns this same common-directory lock. Only a surviving
        // intent after it releases the lock is uncertain; concurrent retries wait for its receipt.
        const pending = core.db
          .prepare('SELECT * FROM repository_deletions WHERE principal_id=? AND operation_id=?')
          .get(actor.installation_id, operation!) as DeletionRow | undefined
        if (
          previous &&
          ((previous.result as { state?: string }).state !== 'outcome_unknown' || !pending)
        )
          return previous.result
        if (pending) {
          if (pending.request_hash !== request_hash) throw new ChannelError('idempotency_mismatch')
          return this.reconcileDeletion(pending)
        }
        const releaseReservation = this.r.targets.reserveDeletion(
          actor,
          target.project_id,
          target.path,
          target.worktree_id,
          operation!
        )
        try {
          await this.validate(target)
          const observed = this.observations.get(String(p.expected_observation_id))
          if (
            !observed ||
            observed.owner !== actor.installation_id ||
            observed.target !== target.worktree_id ||
            observed.revision.head !== p.expected_head
          )
            throw new ChannelError('stale_revision')
          await this.observation(actor, target, observed.revision)
          const records = parseWorktrees(
            await this.r.git.run(project.root_path, { kind: 'worktrees' })
          )
          const record = records.find((w) => w.path === target.path)
          if (!record || record.bare || record.prunable)
            throw new ChannelError('unmanaged_workspace')
          if (this.registrationIdentity(record) !== observed.registration)
            throw new ChannelError('stale_revision')
          if (
            record.locked ||
            this.r.targets.leasedPath(target.path) ||
            (target.workspace_id && this.r.workspaces.leased(target.workspace_id))
          )
            throw new ChannelError('resource_busy')
          const gitDir = await this.r.git.text(target.path, { kind: 'directory' })
          const gitDirIdentity = pathIdentity(gitDir)
          const backlink = join(gitDir, 'gitdir')
          const registeredIdentity = this.registrationIdentity(record)
          const checkPaths = () => {
            try {
              if (
                this.registrationIdentity(record) !== registeredIdentity ||
                realpathSync(gitDir) !== gitDir ||
                pathIdentity(gitDir) !== gitDirIdentity ||
                realpathSync(target.path) !== target.path ||
                this.targetFingerprint(target.path) !== target.fingerprint
              )
                throw new Error()
            } catch {
              throw new ChannelError('stale_revision')
            }
          }
          const checkBacklink = (path: string) => {
            checkPaths()
            try {
              if (
                !lstatSync(backlink).isFile() ||
                realpathSync(backlink) !== backlink ||
                readFileSync(backlink, 'utf8') !== join(path, '.git') + '\n'
              )
                throw new Error()
            } catch {
              throw new ChannelError('stale_revision')
            }
          }
          // Git remove can use its backlink rather than the canonical argv path.
          // Repair metadata first; never let destructive Git follow the logical alias.
          if (record.registered_path !== target.path) {
            await this.r.git.run(
              project.root_path,
              { kind: 'worktree.repair', path: target.path },
              () => {
                checkBacklink(record.registered_path)
                core.authority.check(actor, 'mutate', target.worktree_id)
                this.r.targets.checkDeletionReservation(actor, target.path, operation!)
              }
            )
            checkPaths()
            const repaired = await this.deletionRegistration(target)
            if (repaired.registered_path !== target.path) throw new ChannelError('stale_revision')
            await this.validate(target)
          }
          const checkRegistration = () => {
            checkBacklink(target.path)
          }
          checkRegistration()
          const effectFingerprint = () =>
            hash(
              JSON.stringify([
                this.registrationIdentity(record),
                pathIdentity(target.path),
                pathIdentity(gitDir),
                readFileSync(backlink, 'utf8'),
                this.r.nodePath.snapshot(target.path),
                this.r.nodePath.snapshot(join(project.git_common_dir!, 'refs')),
                ...[
                  join(target.path, '.git'),
                  join(gitDir, 'HEAD'),
                  join(gitDir, 'locked'),
                  join(gitDir, 'gitdir'),
                  join(project.git_common_dir!, 'packed-refs'),
                ].map((path) => {
                  try {
                    return metadata(path)
                  } catch {
                    return null
                  }
                }),
              ])
            )
          const inspected = effectFingerprint()
          if ((await this.head(target)) !== p.expected_head)
            throw new ChannelError('stale_revision')
          if (
            (await this.r.git.run(target.path, { kind: 'status' })).length ||
            (await this.r.git.run(target.path, { kind: 'untracked' })).length
          )
            throw new ChannelError('workspace_dirty')
          if (effectFingerprint() !== inspected) throw new ChannelError('stale_revision')
          core.authority.check(actor, 'mutate', target.worktree_id)
          this.checkPublication(actor, p)
          const intent: DeletionIntent = {
            target,
            project_fingerprint: this.config(project.project_id).fingerprint,
            common_stamp: stamp(project.git_common_dir!),
            phase: 'prepared',
            process: null,
          }
          const saveIntent = () =>
            core.transaction(() =>
              core.db
                .prepare(
                  'UPDATE repository_deletions SET body=? WHERE principal_id=? AND operation_id=?'
                )
                .run(JSON.stringify(intent), actor.installation_id, operation!)
            )
          const reserved = core.reserveOperation(actor, method, p, operation!, () => {
            core.db
              .prepare(
                'INSERT INTO repository_deletions(principal_id,operation_id,request_hash,body) VALUES(?,?,?,?)'
              )
              .run(actor.installation_id, operation!, request_hash, JSON.stringify(intent))
          })
          if (reserved) return reserved.result
          let refusedBeforeEffect = false
          try {
            await this.r.git.run(
              project.root_path,
              { kind: 'worktree.remove', path: target.path },
              () => {
                try {
                  checkRegistration()
                  core.authority.check(actor, 'mutate', target.worktree_id)
                  this.checkPublication(actor, p)
                  this.r.targets.checkDeletionReservation(actor, target.path, operation!)
                  if (effectFingerprint() !== inspected) throw new ChannelError('stale_revision')
                } catch (error) {
                  refusedBeforeEffect = true
                  throw error
                }
              },
              undefined,
              {
                started: (evidence) => {
                  intent.phase = 'armed'
                  intent.process = evidence
                  saveIntent()
                },
                settled: () => {
                  intent.phase = 'settled'
                  saveIntent()
                },
              }
            )
          } catch (e) {
            // The IPC gate never sent "start". A settled refusal is not an
            // uncertain deletion and must not leave the target permanently fenced.
            if (refusedBeforeEffect && e instanceof ChannelError && e.code === 'stale_revision') {
              core.db
                .prepare('DELETE FROM repository_deletions WHERE principal_id=? AND operation_id=?')
                .run(actor.installation_id, operation!)
              throw e
            }
            if (
              !(e instanceof ChannelError) ||
              ![
                'git_process_unconfirmed',
                'git_timeout',
                'git_failed',
                'repository_unavailable',
                'output_limit',
              ].includes(e.code)
            )
              throw e
            const row = core.db
              .prepare('SELECT * FROM repository_deletions WHERE principal_id=? AND operation_id=?')
              .get(actor.installation_id, operation!) as unknown as DeletionRow
            return await this.reconcileDeletion(row)
          }
          this.deleteFault?.()
          const row = core.db
            .prepare('SELECT * FROM repository_deletions WHERE principal_id=? AND operation_id=?')
            .get(actor.installation_id, operation!) as unknown as DeletionRow
          return await this.reconcileDeletion(row, true)
        } finally {
          // Settlement of Git is only process evidence. A surviving durable
          // intent must remain fenced until target inspection commits a terminal
          // observation. Preflight failures without an intent can release safely.
          if (
            !core.db
              .prepare('SELECT 1 FROM repository_deletions WHERE principal_id=? AND operation_id=?')
              .get(actor.installation_id, operation!)
          )
            releaseReservation()
        }
      })
    })
  }
  async select(actor: AuthorityContext, p: Record<string, unknown>, operation?: string) {
    const target = await this.validate(this.get(String(p.worktree_id)))
    if (target.project_id !== p.project_id || (target.kind === 'root' && !p.listed))
      throw new ChannelError('invalid_params')
    return this.r.core.commitOperation(actor, 'project.worktree_selection', p, operation, () => {
      this.checkPublication(actor, { worktree_id: target.worktree_id })
      this.r.core.db
        .prepare(
          'INSERT INTO repository_selections VALUES(?,?,?,?) ON CONFLICT(installation_id,project_id,worktree_id) DO UPDATE SET listed=excluded.listed'
        )
        .run(actor.installation_id, target.project_id, target.worktree_id, p.listed ? 1 : 0)
      const result = {
        project_id: target.project_id,
        worktree_id: target.worktree_id,
        listed: Boolean(p.listed),
      }
      this.r.core.append(
        'catalog',
        'project.worktree_selection.changed',
        { kind: 'installation', installation_id: actor.installation_id },
        result
      )
      return result
    })
  }
  private checked(target: Target, path: string) {
    if (!safePath(path)) throw new ChannelError('unsafe_path')
    let full = target.path
    for (const part of path.split('/').filter(Boolean)) {
      full = join(full, part)
      const s = lstatSync(full)
      if (s.isSymbolicLink()) throw new ChannelError('unsafe_path')
    }
    if (realpathSync(full) !== full) throw new ChannelError('unsafe_path')
    return full
  }
  private readFile(target: Target, path: string, limit: number) {
    let fd: number | undefined
    try {
      const full = this.checked(target, path),
        before = lstatSync(full)
      if (!before.isFile()) throw new ChannelError('unsafe_path')
      if (before.size > limit) return { size: before.size, bytes: null }
      fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const opened = fstatSync(fd)
      if (
        !opened.isFile() ||
        before.dev !== opened.dev ||
        before.ino !== opened.ino ||
        opened.size > limit
      )
        throw new ChannelError('stale_revision')
      const bytes = Buffer.alloc(opened.size)
      let n = 0
      while (n < bytes.length) {
        const count = readSync(fd, bytes, n, bytes.length - n, n)
        if (!count) break
        n += count
      }
      const after = fstatSync(fd)
      if (
        n !== opened.size ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs ||
        this.checked(target, path) !== full ||
        metadata(full) !==
          `${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}:${after.mode}`
      )
        throw new ChannelError('stale_revision')
      return { size: bytes.length, bytes }
    } catch (e) {
      if (e instanceof ChannelError) throw e
      throw new ChannelError('unsafe_path')
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
  private async head(target: Target) {
    try {
      return await this.r.git.text(target.path, { kind: 'resolve', ref: 'HEAD' })
    } catch (e) {
      if (e instanceof ChannelError && e.code === 'git_failed') {
        const records = parseWorktrees(await this.r.git.run(target.path, { kind: 'worktrees' }))
        if (records.find((w) => w.path === target.path)?.head.match(/^0+$/)) return null
      }
      throw e
    }
  }
  private parseStatus(bytes: Buffer): Status[] {
    const fields = decodeGit(bytes).split('\0').filter(Boolean),
      result: Status[] = []
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i]!,
        row: Status = { index: f[0]!, worktree: f[1]!, path: f.slice(3) }
      if (/[RC]/.test(f.slice(0, 2))) row.original_path = fields[++i]
      if (safePath(row.path)) result.push(row)
    }
    return result
  }
  private async monitor(target: Target) {
    let monitor = this.monitors.get(target.worktree_id)
    if (!monitor) {
      const gitdir = await this.r.git.text(target.path, { kind: 'directory' })
      monitor = this.monitors.get(target.worktree_id)
      if (!monitor) {
        while (this.monitors.size >= 8) {
          const id = this.monitors.keys().next().value!
          this.dropMonitor(id)
        }
        if (this.stopped) throw new ChannelError('resource_busy')
        this.checkRead(target)
        monitor = new WorktreeMonitor(
          target.path,
          gitdir,
          this.r.projects.get(target.project_id).git_common_dir!
        )
        this.monitors.set(target.worktree_id, monitor)
      }
    }
    monitor.touched = Date.now()
    this.monitors.delete(target.worktree_id)
    this.monitors.set(target.worktree_id, monitor)
    return monitor
  }
  private async configureMonitor(target: Target, monitor: WorktreeMonitor) {
    if (!monitor.needsConfiguration()) return
    for (let attempt = 0; attempt < 3; attempt++) {
      const sources = await this.r.git.excludeSources(target.path)
      monitor.configure(sources)
      const confirmed = await this.r.git.excludeSources(target.path)
      if (!monitor.needsConfiguration() && JSON.stringify(sources) === JSON.stringify(confirmed))
        return
      monitor.configurationStale()
    }
    throw new ChannelError('stale_revision')
  }
  private async workingState(
    target: Target,
    includeIgnored = false,
    retries = 2
  ): Promise<WorkingSnapshot> {
    const monitor = await this.monitor(target)
    await this.configureMonitor(target, monitor)
    const signature = monitor.signature()
    const started = Date.now()
    const key = target.worktree_id + ':' + includeIgnored
    const cached = this.snapshots.get(key)
    if (monitor.reliable && cached?.signature === signature) {
      // Explicitly creating a fresh repository observation reconciles its known
      // metadata, including same-turn tracked edits before filesystem delivery.
      // Item/page reads never enter this route or enumerate the shared index.
      let membershipUnchanged = true
      for (const [path, stamp] of cached.stamps)
        if (pathMetadata(join(target.path, path)) !== stamp) {
          membershipUnchanged = false
          break
        }
      const ignoresUnchanged = [...cached.ignoreStamps].every(
        ([path, stamp]) => sourceMetadata(path) === stamp
      )
      if (membershipUnchanged && ignoresUnchanged) return cached
      monitor.generation++
      return this.workingState(target, includeIgnored, retries)
    }
    const head = await this.head(target),
      status = this.parseStatus(await this.r.git.run(target.path, { kind: 'status' }))
    const paths = new Map<string, { kind: TreeEntry['kind']; oid: string | null }>()
    const tracked = new Map<string, string[]>()
    const untracked = new Set<string>()
    await this.r.git.records(target.path, { kind: 'tracked' }, (f) => {
      const m = f.match(/^(\d+) ([a-f0-9]+) \d\t([\s\S]*)$/)
      if (!m) throw new ChannelError('git_failed')
      if (safePath(m[3]!)) {
        const rows = tracked.get(m[3]!) ?? []
        rows.push(f)
        tracked.set(m[3]!, rows)
        paths.set(m[3]!, {
          kind: m[1] === '160000' ? 'submodule' : m[1] === '120000' ? 'symlink' : 'file',
          oid: m[2]!,
        })
      }
      if (paths.size > 250000) throw new ChannelError('scan_limit')
    })
    await this.r.git.records(
      target.path,
      { kind: includeIgnored ? 'untracked' : 'visible.untracked' },
      (path) => {
        if (safePath(path)) {
          untracked.add(path)
          paths.set(path, { kind: 'file', oid: null })
        }
        if (paths.size > 250000) throw new ChannelError('scan_limit')
      }
    )
    if (paths.size > 250000) throw new ChannelError('scan_limit')
    const files: TreeEntry[] = [],
      stamps = new Map<string, string | null>(),
      byPath = new Map<string, TreeEntry>(),
      children = new Map<string, TreeEntry[]>()
    const add = (entry: TreeEntry) => {
      byPath.set(entry.path, entry)
      const parent = entry.path.includes('/')
        ? entry.path.slice(0, entry.path.lastIndexOf('/'))
        : ''
      const rows = children.get(parent) ?? []
      rows.push(entry)
      children.set(parent, rows)
    }
    stamps.set('', pathMetadata(target.path))
    const submodules = [...paths].filter(([, d]) => d.kind === 'submodule').map(([path]) => path)
    for (const [path, data] of paths) {
      if (submodules.some((parent) => path.startsWith(parent + '/'))) continue
      try {
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
        this.checked(target, parent)
        const full = join(target.path, path),
          s = lstatSync(full)
        stamps.set(path, metadata(full))
        let directory = ''
        for (const part of parent.split('/').filter(Boolean)) {
          directory = directory ? directory + '/' + part : part
          if (!byPath.has(directory)) {
            add({ path: directory, name: part, kind: 'directory', oid: null, size: null })
            stamps.set(directory, pathMetadata(join(target.path, directory)))
          }
        }
        const entry: TreeEntry = {
          path,
          name: path.split('/').at(-1)!,
          kind: s.isSymbolicLink() ? 'symlink' : data.kind,
          oid: data.oid,
          size: s.size,
        }
        files.push(entry)
        add(entry)
      } catch {
        stamps.set(path, null)
      }
    }
    for (const row of status)
      if (!stamps.has(row.path)) stamps.set(row.path, pathMetadata(join(target.path, row.path)))
    for (const rows of children.values()) {
      rows.sort((a, b) => a.path.localeCompare(b.path))
      this.retainedSizes.set(rows, Buffer.byteLength(JSON.stringify(rows)))
    }
    this.retainedSizes.set(files, Buffer.byteLength(JSON.stringify(files)))
    const ignoreDirectories = new Set(['', ...children.keys()])
    for (const row of status) {
      const parts = row.path.split('/')
      parts.pop()
      for (let i = 1; i <= parts.length; i++) ignoreDirectories.add(parts.slice(0, i).join('/'))
    }
    const ignoreStamps = new Map(
      [...ignoreDirectories].map((directory) => {
        const path = join(target.path, directory, '.gitignore')
        return [path, sourceMetadata(path)] as const
      })
    )
    // Ignore files may change before their first dependency stamp is discovered.
    // Confirm the enumeration while those stamps are pinned; never cache a mixed
    // old visible-path list with new rules (even if a filesystem hint is delayed).
    const confirmedStatus = this.parseStatus(await this.r.git.run(target.path, { kind: 'status' }))
    const confirmedUntracked = new Set<string>()
    await this.r.git.records(
      target.path,
      { kind: includeIgnored ? 'untracked' : 'visible.untracked' },
      (path) => {
        if (safePath(path)) confirmedUntracked.add(path)
        if (confirmedUntracked.size > 250000) throw new ChannelError('scan_limit')
      }
    )
    if (
      JSON.stringify(confirmedStatus) !== JSON.stringify(status) ||
      confirmedUntracked.size !== untracked.size ||
      [...untracked].some((path) => !confirmedUntracked.has(path)) ||
      [...ignoreStamps].some(([path, stamp]) => sourceMetadata(path) !== stamp)
    ) {
      if (retries) return this.workingState(target, includeIgnored, retries - 1)
      throw new ChannelError('stale_revision')
    }
    const boundaries = files
      .filter((file) => file.kind === 'submodule' || file.kind === 'symlink')
      .map((file) => file.path)
    monitor.capture(stamps, started, boundaries, ignoreStamps)
    if (monitor.reliable && monitor.signature() !== signature) {
      if (retries) {
        try {
          return await this.workingState(target, includeIgnored, retries - 1)
        } catch (error) {
          this.restoreBaseline(monitor)
          throw error
        }
      }
      this.restoreBaseline(monitor)
      throw new ChannelError('stale_revision')
    }
    const snapshot: WorkingSnapshot = {
      head,
      files,
      status,
      signature,
      monitor,
      byPath,
      children,
      stamps,
      tracked,
      ignoreStamps,
      started,
      boundaries,
      fingerprint: hash(JSON.stringify([head, status, [...stamps], [...ignoreStamps], signature])),
    }
    const footprint =
      this.retainedSizes.get(files)! +
      Buffer.byteLength(JSON.stringify([...stamps])) +
      Buffer.byteLength(JSON.stringify([...tracked])) +
      Buffer.byteLength(JSON.stringify([...ignoreStamps])) +
      Buffer.byteLength(JSON.stringify(status))
    if (footprint > 32 * 1024 * 1024) {
      this.restoreBaseline(monitor)
      throw new ChannelError('scan_limit')
    }
    if (cached?.fingerprint === snapshot.fingerprint) {
      this.restoreBaseline(monitor, cached)
      return cached
    }
    this.retainedSizes.set(snapshot, footprint)
    this.rowSnapshots.set(files, snapshot)
    for (const rows of children.values()) this.rowSnapshots.set(rows, snapshot)
    this.snapshots.set(key, snapshot)
    this.pruneIndexes(snapshot)
    return snapshot
  }
  private async changeDetails(target: Target, rows: Status[], tracked: Map<string, string[]>) {
    let bytes = 0
    const detailed: Status[] = []
    for (const row of rows) {
      const conflict = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'].includes(row.index + row.worktree)
      const untracked = row.index === '?'
      const staged = !untracked && row.index !== ' '
      const unstaged = untracked || row.worktree !== ' '
      const kind = conflict
        ? 'conflict'
        : untracked
          ? 'A'
          : /R/.test(row.index + row.worktree)
            ? 'R'
            : /D/.test(row.index + row.worktree)
              ? 'D'
              : /A/.test(row.index + row.worktree)
                ? 'A'
                : 'M'
      const stage = conflict
        ? 'unstaged'
        : staged && unstaged
          ? 'partly'
          : staged
            ? 'staged'
            : 'unstaged'
      let content: string | null = null
      try {
        const parent = row.path.includes('/') ? row.path.slice(0, row.path.lastIndexOf('/')) : ''
        this.checked(target, parent)
        const full = join(target.path, row.path),
          s = lstatSync(full)
        if (s.isFile() && bytes + s.size <= 16 * 1024 * 1024) {
          const result = this.readFile(target, row.path, 16 * 1024 * 1024)
          if (result.bytes) {
            content = hash(result.bytes)
            bytes += result.bytes.length
          }
        } else content = metadata(full)
      } catch (e) {
        if (e instanceof ChannelError && e.code === 'stale_revision') throw e
        content = null
      }
      const fingerprint = hash(JSON.stringify([row, tracked.get(row.path) ?? [], content]))
      const old = this.r.core.db
        .prepare(
          'SELECT fingerprint,body FROM repository_change_stamps WHERE worktree_id=? AND path=?'
        )
        .get(target.worktree_id, row.path) as { fingerprint: string; body: string } | undefined
      const detail =
        old?.fingerprint === fingerprint
          ? (JSON.parse(old.body) as Record<string, unknown>)
          : {
              kind,
              stage,
              change_id: randomUUID(),
              changed_at: new Date().toISOString(),
              time_basis: 'observed',
            }
      this.r.core.db
        .prepare(
          'INSERT INTO repository_change_stamps VALUES(?,?,?,?) ON CONFLICT(worktree_id,path) DO UPDATE SET fingerprint=excluded.fingerprint,body=excluded.body'
        )
        .run(target.worktree_id, row.path, fingerprint, JSON.stringify(detail))
      detailed.push({ ...row, ...detail })
    }
    // A clean interval separates successive changes, even if bytes later match an old edit.
    const dirty = new Set(rows.map((row) => row.path))
    for (const row of this.r.core.db
      .prepare('SELECT path FROM repository_change_stamps WHERE worktree_id=?')
      .all(target.worktree_id) as { path: string }[])
      if (!dirty.has(row.path))
        this.r.core.db
          .prepare('DELETE FROM repository_change_stamps WHERE worktree_id=? AND path=?')
          .run(target.worktree_id, row.path)
    return detailed
  }
  private async divergence(actor: AuthorityContext, target: Target, p: Record<string, unknown>) {
    const base_ref =
      p.base_ref === undefined
        ? RepositoryRefsPageSchema.parse(
            await this.refs(actor, target, 'repository.v1.refs', {
              worktree_id: target.worktree_id,
              limit: 256,
            })
          ).default_branch
        : String(p.base_ref)
    const head_commit = await this.head(target)
    let base_commit: string | null = null
    if (base_ref) {
      try {
        base_commit = await this.r.git.text(target.path, { kind: 'resolve', ref: base_ref })
      } catch (e) {
        if (!(e instanceof ChannelError) || e.code !== 'git_failed') throw e
      }
    }
    const result = {
      base_ref,
      base_commit,
      head_commit,
      ahead: null as number | null,
      behind: null as number | null,
    }
    if (!base_ref) return { ...result, reason: 'default_branch_required' }
    if (!head_commit) return { ...result, reason: 'unborn_head' }
    if (!base_commit) return { ...result, reason: 'unborn_base' }
    const counts = (
      await this.r.git.text(target.path, {
        kind: 'divergence',
        base: base_commit,
        head: head_commit,
      })
    )
      .trim()
      .split(/\s+/)
      .map(Number)
    if (counts.length !== 2 || counts.some((n) => !Number.isSafeInteger(n) || n < 0))
      throw new ChannelError('git_failed')
    return { ...result, behind: counts[0], ahead: counts[1], reason: 'ok' }
  }
  private async observation(actor: AuthorityContext, target: Target, revision: RepositoryRevision) {
    if (revision.kind !== 'working') throw new ChannelError('invalid_revision')
    this.prune()
    const o = this.observations.get(revision.observation_id)
    if (
      !o ||
      o.owner !== actor.installation_id ||
      o.target !== target.worktree_id ||
      JSON.stringify(o.revision) !== JSON.stringify(revision)
    )
      throw new ChannelError('stale_revision')
    o.snapshot.monitor.touched = Date.now()
    if (o.snapshot.monitor.closed) throw new ChannelError('stale_revision')
    if (o.snapshot.monitor.reliable) {
      if (o.snapshot.monitor.signature() !== o.snapshot.signature)
        throw new ChannelError('stale_revision')
    } else if ((await this.workingState(target, o.includeIgnored)).fingerprint !== o.fingerprint)
      throw new ChannelError('stale_revision')
    return o
  }
  private checkObservedPath(target: Target, snapshot: WorkingSnapshot, path: string) {
    let directory = ''
    const parents = ['']
    const parts = path.split('/').filter(Boolean)
    if (snapshot.byPath.get(path)?.kind !== 'directory') parts.pop()
    for (const part of parts) {
      directory = directory ? directory + '/' + part : part
      parents.push(directory)
    }
    const ignoresUnchanged = parents.every((directory) => {
      const source = join(target.path, directory, '.gitignore')
      return sourceMetadata(source) === (snapshot.ignoreStamps.get(source) ?? null)
    })
    // A path the observation never saw (only the base has it) is unchanged while it stays absent.
    if (
      !ignoresUnchanged ||
      pathMetadata(join(target.path, path)) !== (snapshot.stamps.get(path) ?? null)
    ) {
      // Fence the cache too: an immediate re-observe must not reuse the old state
      // while a delayed filesystem hint is still in flight.
      snapshot.monitor.generation++
      throw new ChannelError('stale_revision')
    }
  }
  private retain(target: Target, bytes: Buffer) {
    // A read completing after opt-out must neither retain nor publish old bytes, even
    // if the owner opted back in while Git/worker I/O was pending.
    this.checkRead(target)
    if (bytes.length > 16 * 1024 * 1024) throw new ChannelError('output_limit')
    const id = hash(bytes),
      db = this.r.core.db
    this.r.core.transaction(() => {
      db.prepare(
        'INSERT INTO repository_contents VALUES(?,?,?,?) ON CONFLICT(worktree_id,content_id) DO UPDATE SET touched=excluded.touched'
      ).run(target.worktree_id, id, bytes, Date.now())
      let size = Number(
        (
          db
            .prepare('SELECT COALESCE(SUM(length(content)),0) AS size FROM repository_contents')
            .get() as { size: number }
        ).size
      )
      for (const row of db
        .prepare(
          'SELECT worktree_id,content_id,length(content) AS size FROM repository_contents ORDER BY touched,rowid'
        )
        .all() as { worktree_id: string; content_id: string; size: number }[]) {
        if (size <= contentLimit) break
        db.prepare('DELETE FROM repository_contents WHERE worktree_id=? AND content_id=?').run(
          row.worktree_id,
          row.content_id
        )
        size -= row.size
      }
    })
    return id
  }
  private content(target: Target, id: string) {
    const row = this.r.core.db
      .prepare('SELECT content FROM repository_contents WHERE worktree_id=? AND content_id=?')
      .get(target.worktree_id, id) as { content: Uint8Array } | undefined
    if (!row) throw new ChannelError('content_expired')
    this.r.core.db
      .prepare('UPDATE repository_contents SET touched=? WHERE worktree_id=? AND content_id=?')
      .run(Date.now(), target.worktree_id, id)
    return Buffer.from(row.content)
  }
  private parseTree(bytes: Buffer, prefix = ''): TreeEntry[] {
    return decodeGit(bytes)
      .split('\0')
      .filter(Boolean)
      .flatMap((f) => {
        const m = f.match(/^(\d+) (\w+) ([a-f0-9]+)\s+(-|\d+)\t([\s\S]*)$/)
        if (!m) throw new ChannelError('git_failed')
        const path = prefix + m[5]!
        if (!safePath(path)) return []
        return [
          {
            path,
            name: path.split('/').at(-1)!,
            kind:
              m[1] === '160000'
                ? ('submodule' as const)
                : m[1] === '120000'
                  ? ('symlink' as const)
                  : m[2] === 'tree'
                    ? ('directory' as const)
                    : ('file' as const),
            oid: m[3]!,
            size: m[4] === '-' ? null : Number(m[4]),
          },
        ]
      })
  }
  private async immutable(
    target: Target,
    command: Extract<GitCommand, { kind: 'tree' | 'blob' | 'blob.size' }>,
    deadline?: number
  ) {
    const project = this.r.projects.get(target.project_id)
    const generation = this.cacheGeneration
    const key = JSON.stringify([
      generation,
      project.git_common_dir,
      this.config(target.project_id).fingerprint,
      command,
    ])
    const cached = this.objectCache.get(key)
    if (cached) return cached
    const bytes = await this.r.git.run(target.path, command, undefined, deadline)
    // Access is still checked by dispatch before publishing a hit or a newly loaded object.
    if (generation === this.cacheGeneration) this.objectCache.set(key, bytes)
    return bytes
  }
  private async commitTree(target: Target, commit: string, path = '', recursive = false) {
    // Resolve directory one component at a time; links/gitlinks are never dereferenced.
    let object = commit,
      prefix = ''
    for (const part of path.split('/').filter(Boolean)) {
      const entries = this.parseTree(await this.immutable(target, { kind: 'tree', object }))
      const dir = entries.find((e) => e.name === part)
      if (!dir || dir.kind !== 'directory') throw new ChannelError('unsafe_path')
      object = dir.oid!
      prefix += part + '/'
    }
    return this.parseTree(await this.immutable(target, { kind: 'tree', object, recursive }), prefix)
  }
  private async blobBytes(
    actor: AuthorityContext,
    target: Target,
    revision: RepositoryRevision,
    path: string,
    limit: number
  ) {
    if (revision.kind === 'working') {
      const o = await this.observation(actor, target, revision)
      const entry = o.snapshot.byPath.get(path)
      if (!entry || entry.kind !== 'file') throw new ChannelError('unsafe_path')
      this.checkObservedPath(target, o.snapshot, path)
      const result = this.readFile(target, path, limit)
      this.checkObservedPath(target, o.snapshot, path)
      await this.observation(actor, target, revision)
      return result
    }
    const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
    const entry = (await this.commitTree(target, revision.commit, parent)).find(
      (e) => e.path === path
    )
    if (!entry) throw new ChannelError('not_found')
    if (entry.kind !== 'file') throw new ChannelError('unsafe_path')
    const size = Number(
      decodeGit(await this.immutable(target, { kind: 'blob.size', object: entry.oid! }))
    )
    if (size > limit) return { size, bytes: null }
    return { size, bytes: await this.immutable(target, { kind: 'blob', object: entry.oid! }) }
  }
  private async blob(actor: AuthorityContext, target: Target, p: Record<string, unknown>) {
    const result = await this.blobBytes(
      actor,
      target,
      p.revision as RepositoryRevision,
      String(p.path),
      p.larger ? 16 * 1024 * 1024 : 1024 * 1024
    )
    let binary = false
    if (result.bytes) {
      try {
        decodeGit(result.bytes)
        binary = result.bytes.includes(0)
      } catch {
        binary = true
      }
    }
    return {
      content_id: result.bytes ? this.retain(target, result.bytes) : null,
      size: result.size,
      binary,
      requires_larger_load: result.size > 1024 * 1024 && !p.larger,
      too_large: result.size > 16 * 1024 * 1024,
    }
  }
  private async refs(
    actor: AuthorityContext,
    target: Target,
    method: string,
    p: Record<string, unknown>
  ) {
    const continued = this.continuation(actor, method, p)
    const fields = decodeGit(await this.r.git.run(target.path, { kind: 'refs' })).split('\0')
    const entries: { name: string; commit: string | null; symbolic: string | null }[] = []
    for (let i = 0; i + 5 < fields.length; i += 6) {
      const name = fields[i]!.replace(/^\n/, '')
      if (!name) continue
      const commit =
        fields[i + 3] === 'commit'
          ? fields[i + 1]!
          : fields[i + 5] === 'commit'
            ? fields[i + 4]!
            : null
      entries.push({ name, commit, symbolic: fields[i + 2] || null })
    }
    const defaults = [
      ...new Set(
        entries
          .filter((e) => /^refs\/remotes\/[^/]+\/HEAD$/.test(e.name) && e.symbolic)
          .map((e) => e.symbolic!)
      ),
    ]
    const default_branch =
      this.config(target.project_id).default_branch ?? (defaults.length === 1 ? defaults[0]! : null)
    if (continued) {
      const saved = this.cursors.get(String(p.cursor))!
      if (
        hash(JSON.stringify(saved.rows)) !== hash(JSON.stringify(entries)) ||
        saved.extra.default_branch !== default_branch
      )
        throw new ChannelError('stale_cursor')
      return continued
    }
    return this.page(actor, method, p, entries, { default_branch })
  }
  private async history(
    actor: AuthorityContext,
    target: Target,
    method: string,
    p: Record<string, unknown>
  ) {
    const revision = p.revision as RepositoryRevision
    const commit =
      revision.kind === 'commit'
        ? revision.commit
        : (await this.observation(actor, target, revision)).revision.head
    if (!commit) {
      if (method === 'repository.v1.commit') throw new ChannelError('unborn_head')
      return this.page(actor, method, p, [])
    }
    this.prune()
    let offset = 0
    if (p.cursor) {
      const saved = this.cursors.get(String(p.cursor))
      if (
        !saved ||
        saved.owner !== actor.installation_id ||
        saved.target !== target.worktree_id ||
        saved.key !== this.key(method, p)
      )
        throw new ChannelError('stale_cursor')
      offset = Number(saved.extra.history_offset)
    }
    const rows = [],
      count = method.endsWith('.commit') ? 1 : Number(p.limit)
    let more = false,
      size = 1024
    // One Git process reads the whole page plus the row that says whether there is more.
    const fields = decodeGit(
      await this.r.git.run(target.path, {
        kind: 'history',
        commit,
        offset,
        limit: method.endsWith('.commit') ? 1 : count + 1,
        ...(p.path ? { path: String(p.path) } : {}),
      })
    ).split('\0')
    if (fields.length % 7 !== 1 || fields[fields.length - 1]!.trim())
      throw new ChannelError('unsupported_commit_metadata')
    for (let i = 0; i + 7 < fields.length; i += 7) {
      const f = fields.slice(i, i + 7)
      if (!/^[a-f0-9]{40,64}$/.test(f[0]!.trim()) || !/^(?:[a-f0-9]{40,64}(?: |$))*$/.test(f[1]!))
        throw new ChannelError('unsupported_commit_metadata')
      const row = {
        commit: f[0]!.trim(),
        parents: f[1]!.split(' ').filter(Boolean),
        author: f[2]!,
        email: f[3]!,
        authored_at: f[4]!,
        subject: f[5]!,
        message: f[6]!,
      }
      const bytes = Buffer.byteLength(JSON.stringify(row)) + 1
      if (bytes > 30000) throw new ChannelError('output_limit')
      if (method.endsWith('.commit')) return row
      if (rows.length === count || size + bytes > 32768) {
        more = true
        break
      }
      rows.push(row)
      size += bytes
    }
    let cursor: string | null = null
    if (more) {
      cursor = randomUUID()
      this.cursors.set(cursor, {
        owner: actor.installation_id,
        target: target.worktree_id,
        key: this.key(method, p),
        rows: [],
        offset: 0,
        expires: Date.now() + ttl,
        extra: { history_offset: offset + rows.length },
        omissions: [],
      })
    }
    return { entries: rows, cursor, incomplete: false, omissions: [] }
  }
  private async compare(
    actor: AuthorityContext,
    target: Target,
    method: string,
    p: Record<string, unknown>
  ) {
    let base = p.base as RepositoryComparisonBase,
      head = p.head as RepositoryRevision
    const mode = p.mode as Comparison['mode']
    if (base.kind === 'working') throw new ChannelError('invalid_revision')
    if (
      base.kind === 'empty' &&
      (head.kind !== 'working' || head.head !== null || mode === 'merge-base')
    )
      throw new ChannelError('invalid_revision')
    if (head.kind === 'working') await this.observation(actor, target, head)
    if (mode === 'merge-base') {
      const commit = head.kind === 'commit' ? head.commit : head.head
      if (!commit || base.kind !== 'commit') throw new ChannelError('invalid_revision')
      base = {
        kind: 'commit',
        commit: await this.r.git.text(target.path, {
          kind: 'merge-base',
          base: base.commit,
          head: commit,
        }),
      }
    }
    if ((mode === 'staged' || mode === 'unstaged') && head.kind !== 'working')
      throw new ChannelError('invalid_revision')
    const continued = this.continuation(actor, method, p)
    if (continued) return continued
    const baseObject =
      base.kind === 'empty'
        ? await this.r.git.text(target.path, { kind: 'empty.tree' })
        : base.commit
    const fields = decodeGit(
      await this.r.git.run(target.path, {
        kind: 'changes',
        base: baseObject,
        ...(head.kind === 'commit' ? { head: head.commit } : {}),
        staged: mode === 'staged',
        unstaged: mode === 'unstaged',
      })
    )
      .split('\0')
      .filter(Boolean)
    const rows: { path: string; status: string; index?: string; worktree?: string }[] = []
    for (let i = 0; i < fields.length; i += 2)
      if (safePath(fields[i + 1]!)) rows.push({ status: fields[i]!, path: fields[i + 1]! })
    if (head.kind === 'working') {
      const o = await this.observation(actor, target, head)
      for (const status of o.status) {
        const row = rows.find((r) => r.path === status.path)
        if (row) {
          row.index = status.index
          row.worktree = status.worktree
        } else if (status.index === '?' && mode !== 'staged')
          rows.push({ path: status.path, status: 'A', index: '?', worktree: '?' })
      }
      for (const row of rows) this.checkObservedPath(target, o.snapshot, row.path)
    }
    this.prune()
    const id = randomUUID()
    this.comparisons.set(id, {
      owner: actor.installation_id,
      target: target.worktree_id,
      base,
      baseObject,
      head,
      mode,
      paths: new Set(rows.map((r) => r.path)),
      patches: new Map(),
      expires: Date.now() + ttl,
    })
    return this.page(actor, method, p, rows, { comparison_id: id, base, head, mode })
  }
  private async patch(actor: AuthorityContext, target: Target, p: Record<string, unknown>) {
    this.prune()
    const comparison = this.comparisons.get(String(p.comparison_id)),
      path = String(p.path)
    if (
      !comparison ||
      comparison.owner !== actor.installation_id ||
      comparison.target !== target.worktree_id
    )
      throw new ChannelError('comparison_expired')
    if (!comparison.paths.has(path)) throw new ChannelError('not_found')
    const captured = comparison.patches.get(path)
    if (captured) {
      this.content(target, captured.content_id)
      return captured
    }
    let bytes: Buffer
    if (comparison.head.kind === 'working') {
      const o = await this.observation(actor, target, comparison.head)
      this.checkObservedPath(target, o.snapshot, path)
      if (o.status.some((s) => s.path === path && s.index === '?')) {
        const result = await this.blobBytes(actor, target, comparison.head, path, 1024 * 1024)
        if (!result.bytes || result.bytes.includes(0))
          throw new ChannelError('unsupported_binary_patch')
        const text = decodeGit(result.bytes),
          lines = text.split('\n')
        if (text.endsWith('\n')) lines.pop()
        bytes = Buffer.from(
          `--- /dev/null\n+++ ${JSON.stringify('b/' + path)}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => '+' + l).join('\n')}\n${text.endsWith('\n') ? '' : '\\ No newline at end of file\n'}`
        )
      } else
        bytes = await this.r.git.run(target.path, {
          kind: 'patch',
          base: comparison.baseObject,
          staged: comparison.mode === 'staged',
          unstaged: comparison.mode === 'unstaged',
          path,
        })
      this.checkObservedPath(target, o.snapshot, path)
      await this.observation(actor, target, comparison.head)
    } else
      bytes = await this.r.git.run(target.path, {
        kind: 'patch',
        base: comparison.baseObject,
        head: comparison.head.commit,
        path,
      })
    const capturedPatch = {
      content_id: this.retain(target, bytes),
      size: bytes.length,
      binary: false,
      requires_larger_load: false,
      too_large: false,
    }
    comparison.patches.set(path, capturedPatch)
    return capturedPatch
  }
  private async blame(actor: AuthorityContext, target: Target, p: Record<string, unknown>) {
    const revision = p.revision as RepositoryRevision,
      path = String(p.path)
    if (p.cursor && revision.kind === 'working') {
      const o = await this.observation(actor, target, revision)
      this.checked(target, path)
      this.checkObservedPath(target, o.snapshot, path)
    }
    const continued = this.continuation(actor, 'repository.v1.blame', p)
    if (continued) return continued
    const result = await this.blobBytes(actor, target, revision, path, 1024 * 1024)
    if (!result.bytes) throw new ChannelError('input_limit')
    if (result.bytes.includes(0)) throw new ChannelError('unsupported_binary')
    const text = decodeGit(result.bytes),
      content_id = this.retain(target, result.bytes),
      lines = text.split('\n')
    if (text.endsWith('\n')) lines.pop()
    const start = Number(p.start),
      count = Math.min(Number(p.count), Math.max(0, lines.length - start + 1))
    if (!count) return { content_id, entries: [], cursor: null, incomplete: false, omissions: [] }
    if (revision.kind === 'working') {
      const o = await this.observation(actor, target, revision)
      if (!revision.head || o.status.some((s) => s.path === path && s.index === '?'))
        return this.page(
          actor,
          'repository.v1.blame',
          { ...p, limit: count },
          lines.slice(start - 1, start - 1 + count).map((text, i) => ({
            line: start + i,
            original_line: start + i,
            commit: null,
            author: 'Uncommitted',
            text,
          })),
          { content_id }
        )
      if ((await this.head(target)) !== revision.head) throw new ChannelError('stale_revision')
    }
    const output = decodeGit(
      await this.r.git.run(target.path, {
        kind: 'blame',
        commit: revision.kind === 'commit' ? revision.commit : revision.head!,
        path,
        start,
        count,
        ...(revision.kind === 'working' ? { contents: result.bytes } : {}),
      })
    )
    const entries = []
    let entry = { line: 0, original_line: 0, commit: null as string | null, author: '', text: '' }
    for (const line of output.split('\n')) {
      const m = line.match(/^([a-f0-9]{40,64}) (\d+) (\d+)(?: \d+)?$/)
      if (m)
        entry = {
          line: Number(m[3]),
          original_line: Number(m[2]),
          commit: /^0+$/.test(m[1]!) ? null : m[1]!,
          author: '',
          text: '',
        }
      else if (line.startsWith('author ')) entry.author = line.slice(7)
      else if (line.startsWith('\t')) entries.push({ ...entry, text: line.slice(1) })
    }
    if (revision.kind === 'working') await this.observation(actor, target, revision)
    return this.page(actor, 'repository.v1.blame', { ...p, limit: count }, entries, { content_id })
  }
  private async search(
    actor: AuthorityContext,
    target: Target,
    method: string,
    p: Record<string, unknown>
  ): Promise<unknown> {
    const saved = p.cursor ? this.cursors.get(String(p.cursor)) : undefined
    if (
      p.cursor &&
      (!saved ||
        saved.owner !== actor.installation_id ||
        saved.target !== target.worktree_id ||
        saved.key !== this.key(method, p))
    )
      throw new ChannelError('stale_cursor')
    if (saved && (saved.offset < saved.rows.length || !saved.scan))
      return this.continuation(actor, method, p)
    const revision = p.revision as RepositoryRevision
    let files =
      saved?.scan?.files ??
      (revision.kind === 'commit'
        ? await this.commitTree(target, revision.commit, '', true)
        : (await this.observation(actor, target, revision)).files)
    if (!saved && p.scope === 'changed') {
      let paths: Set<string>
      if (revision.kind === 'working')
        paths = new Set((await this.observation(actor, target, revision)).status.map((s) => s.path))
      else {
        const detail = (await this.history(actor, target, 'repository.v1.commit', {
          ...p,
          cursor: undefined,
        })) as { parents: string[] }
        if (detail.parents[0]) {
          const fields = decodeGit(
            await this.r.git.run(target.path, {
              kind: 'changes',
              base: detail.parents[0],
              head: revision.commit,
            })
          )
            .split('\0')
            .filter(Boolean)
          paths = new Set(fields.filter((_v, i) => i % 2 === 1))
        } else paths = new Set(files.map((f) => f.path))
      }
      files = files.filter((f) => paths.has(f.path))
    }
    const start = Date.now(),
      omissions = new Set<string>(),
      rows: unknown[] = []
    let next = saved?.scan?.next ?? 0,
      bytes = 0
    const pageParams = { ...p, cursor: undefined }
    const finish = () =>
      this.page(
        actor,
        method,
        pageParams,
        rows,
        {},
        [...omissions],
        next < files.length ? { files, next } : undefined
      )
    // All regular expressions, including glob matching, run off the event loop in a killable worker.
    const worker = new Worker(searchWorker, {
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 },
    })
    this.workers.add(worker)
    try {
      const call = (data: unknown) =>
        new Promise<any>((resolve, reject) => {
          const cleanup = () => {
            clearTimeout(timer)
            worker.off('message', message)
            worker.off('error', failure)
            worker.off('exit', exit)
          }
          const message = (value: any) => {
            cleanup()
            resolve(value)
          }
          const failure = () => {
            cleanup()
            reject(new ChannelError('search_worker_failed'))
          }
          const exit = () => failure()
          const timer = setTimeout(
            () => {
              cleanup()
              void worker.terminate()
              reject(new ChannelError('search_deadline'))
            },
            Math.max(1, 1000 - (Date.now() - start))
          )
          worker.once('message', message)
          worker.once('error', failure)
          worker.once('exit', exit)
          worker.postMessage(data)
        })
      const init = await call({
        init: true,
        query: p.query,
        mode: p.mode,
        case_sensitive: p.case_sensitive,
        path_glob: p.path_glob,
      })
      if (init.error) throw new ChannelError('unsupported_search_syntax')
      if (p.path_glob && !saved) {
        // Match in the terminable worker before consuming file/byte budgets or reading blobs.
        const filtered = await call({ filter_paths: files.map((file) => file.path) })
        files = files.filter((_file, index) => filtered.included[index])
      }
      for (; next < files.length; next++) {
        const file = files[next]!
        if (file.kind !== 'file') continue
        if (bytes >= 32 * 1024 * 1024 || Date.now() - start >= 750 || rows.length >= 1000) {
          omissions.add('scan limit; continue with cursor to cover remaining files')
          break
        }
        if (file.size !== null && file.size > 1024 * 1024) {
          omissions.add('files over 1 MiB skipped')
          continue
        }
        let content: Buffer | null = null,
          content_id: string | null = null
        if (p.mode !== 'filename') {
          if (file.size !== null && bytes + file.size > 32 * 1024 * 1024) {
            omissions.add('scan limit; continue with cursor to cover remaining files')
            break
          }
          if (revision.kind === 'working') {
            const snapshot = (await this.observation(actor, target, revision)).snapshot
            this.checkObservedPath(target, snapshot, file.path)
            content = this.readFile(target, file.path, 1024 * 1024).bytes
            this.checkObservedPath(target, snapshot, file.path)
          } else
            content = await this.r.git.run(
              target.path,
              { kind: 'blob', object: file.oid! },
              undefined,
              Math.max(1, 1000 - (Date.now() - start))
            )
          if (!content) {
            omissions.add('files over 1 MiB skipped')
            continue
          }
          bytes += content.length
          try {
            decodeGit(content)
          } catch {
            omissions.add('binary files skipped')
            continue
          }
          if (content.includes(0)) {
            omissions.add('binary files skipped')
            continue
          }
        }
        const found = await call({
          path: file.path,
          text: content ? decodeGit(content) : '',
          max: 1000 - rows.length,
        })
        if (found.matches.length && content) content_id = this.retain(target, content)
        for (const match of found.matches)
          rows.push({ path: file.path, line: match.line, text: match.text, content_id })
        if (found.truncated) omissions.add('matches or line text truncated')
      }
      if (revision.kind === 'working') await this.observation(actor, target, revision)
      return finish()
    } catch (e) {
      if (e instanceof ChannelError && ['search_deadline', 'git_timeout'].includes(e.code)) {
        // The outer read budget rechecks observation/authority after the worker budget expires.
        omissions.add(
          'search execution deadline; incomplete coverage; refine query or continue with cursor'
        )
        return finish()
      }
      throw e
    } finally {
      this.workers.delete(worker)
      await worker.terminate()
    }
  }
  private unwatch(id: string) {
    const s = this.subscriptions.get(id)
    if (!s) return
    if (s.timer) clearInterval(s.timer)
    if (s.pending) clearTimeout(s.pending)
    for (const w of s.watchers) w.close()
    s.detach?.()
    this.subscriptions.delete(id)
    if (
      s.changes &&
      ![...this.subscriptions.values()].some(
        (other) => other.changes && other.target.worktree_id === s.target.worktree_id
      )
    )
      this.changes.idle(s.target.worktree_id)
  }
  private async changeBaseline(target: Target) {
    const snapshot = await this.workingState(target)
    return baselineOf(snapshot, snapshot.monitor.gitdir)
  }
  private async watchFingerprint(target: Target) {
    const monitor = await this.monitor(target)
    await this.configureMonitor(target, monitor)
    const refs = [
      (await this.r.git.run(target.path, { kind: 'refs' })).toString('base64'),
      (await this.r.git.run(target.path, { kind: 'worktrees' })).toString('base64'),
    ]
    return {
      cheap: hash(
        JSON.stringify([
          monitor.reliable ? monitor.signature() : (await this.workingState(target)).fingerprint,
          ...refs,
        ])
      ),
      refs,
    }
  }
  /**
   * The monitor's signature moves on things no reader sees: an index rewritten by another
   * tool's `git status`, ignored files, a directory's time after a temporary file came and
   * went. Only HEAD, the visible files with their stamps, their states and the refs count.
   */
  private async watchVisible(target: Target, watched: { cheap: string; refs: string[] }) {
    let snapshot: WorkingSnapshot
    try {
      snapshot = await this.workingState(target)
    } catch (error) {
      // Too large or too busy to enumerate: every hint counts, as before.
      if (error instanceof ChannelError && ['scan_limit', 'stale_revision'].includes(error.code))
        return watched.cheap
      throw error
    }
    return hash(
      JSON.stringify([
        snapshot.head,
        snapshot.status,
        snapshot.files.map((file) => [
          file.path,
          file.kind,
          file.oid,
          snapshot.stamps.get(file.path),
        ]),
        ...watched.refs,
      ])
    )
  }
  private async subscribe(
    actor: AuthorityContext,
    target: Target,
    cursor?: { stream_id: string; revision: number } | null
  ) {
    const changes = cursor !== undefined
    const renewed = (other: Subscription) =>
      other.owner.installation_id === actor.installation_id &&
      other.target.worktree_id === target.worktree_id
    for (const [key, s] of this.subscriptions) if (s.expires < Date.now()) this.unwatch(key)
    // The lease being renewed keeps publishing until this one takes over: dropped now, a batch
    // made while the new one is observed would reach nobody and force the client to reread.
    if ([...this.subscriptions.values()].filter((other) => !renewed(other)).length >= 16)
      throw new ChannelError('resource_busy')
    let stream: { stream_id: string; revision: number } | undefined, id: string, s: Subscription
    try {
      const watched = await this.watchFingerprint(target)
      id = randomUUID()
      s = {
        owner: actor,
        target,
        fingerprint: watched.cheap,
        visible: await this.watchVisible(target, watched),
        expires: Date.now() + 60000,
        watchers: [],
        checking: false,
        changes,
      }
      stream = changes
        ? await this.changes.open(target.worktree_id, () => this.changeBaseline(target))
        : undefined
      // Initial fingerprinting yields to token revocation, opt-out and shutdown.
      // Recheck before allocating timers/handles, not just when publishing the first hint.
      if (this.stopped) throw new ChannelError('resource_busy')
      this.checkRead(target)
      this.checkPublication(actor, { worktree_id: target.worktree_id })
    } catch (error) {
      // A failed renewal ends the lease it was renewing, as it always has.
      for (const [key, current] of this.subscriptions) if (renewed(current)) this.unwatch(key)
      throw error
    }
    for (const [key, current] of this.subscriptions) if (renewed(current)) this.unwatch(key)
    if (this.subscriptions.size >= 16) throw new ChannelError('resource_busy')
    this.subscriptions.set(id, s)
    // Decided as the subscription takes over, so no batch falls between the answer and it.
    const follows = changes
      ? this.changes.follow(target.worktree_id, actor.installation_id, cursor ?? null)
      : false
    const position = changes ? this.changes.position(target.worktree_id) : undefined
    if (changes) this.changes.watched(target.worktree_id)
    const notify = (reason: 'filesystem' | 'reconciliation' | 'reconnect' | 'overflow') => {
      this.r.core.authority.check(actor, 'publish', target.worktree_id)
      this.config(target.project_id)
      if (target.kind === 'external' && !this.config(target.project_id).external_read)
        throw new ChannelError('unauthorized')
      this.r.core.append(
        'catalog',
        'repository.invalidated',
        { kind: 'installation', installation_id: actor.installation_id },
        {
          project_id: target.project_id,
          worktree_id: target.worktree_id,
          reason,
          generation: randomUUID(),
        }
      )
    }
    const publish = async (reason: 'change' | 'overflow' | 'unavailable') => {
      const batch = await this.changes.advance(
        target.worktree_id,
        () => this.changeBaseline(target),
        reason
      )
      if (!batch) return
      // One revision, sent to every change watcher of this worktree.
      for (const [key, other] of this.subscriptions) {
        if (!other.changes || other.target.worktree_id !== target.worktree_id) continue
        try {
          this.r.core.authority.check(other.owner, 'publish', target.worktree_id)
          if (target.kind === 'external' && !this.config(target.project_id).external_read)
            throw new ChannelError('unauthorized')
          this.r.core.append(
            'catalog',
            'repository.changed',
            { kind: 'installation', installation_id: other.owner.installation_id },
            {
              project_id: target.project_id,
              worktree_id: target.worktree_id,
              stream_id: batch.stream_id,
              revision: batch.revision,
              ...batch.body,
            }
          )
          this.changes.sent(target.worktree_id, other.owner.installation_id, batch.revision)
        } catch {
          this.unwatch(key)
        }
      }
    }
    const attach = async () => {
      const monitor = await this.monitor(target)
      if (s.monitor === monitor || !this.subscriptions.has(id)) return
      s.detach?.()
      s.monitor = monitor
      s.detach = monitor.listen((overflow) => (overflow ? run('overflow') : schedule()))
    }
    const reconcile = async (reason: 'filesystem' | 'reconciliation' | 'overflow') => {
      if (this.stopped || !this.subscriptions.has(id)) return
      if (s.expires < Date.now()) {
        this.unwatch(id)
        return
      }
      if (s.checking || this.active >= 4) {
        // Never lose overflow or a change hint while another read owns the job budget.
        if (reason === 'overflow' || s.dirty !== 'overflow') s.dirty = reason
        return
      }
      reason = s.dirty === 'overflow' ? 'overflow' : (s.dirty ?? reason)
      s.dirty = undefined
      s.checking = true
      this.active++
      try {
        if (s.expires < Date.now()) {
          this.unwatch(id)
          return
        }
        this.r.core.authority.check(actor, 'resource', target.worktree_id)
        await this.validate(target)
        if (changes) await attach()
        const watched = await this.watchFingerprint(target)
        if (this.stopped || !this.subscriptions.has(id)) return
        if (s.expires < Date.now()) {
          this.unwatch(id)
          return
        }
        if (changes) {
          // A stream watcher diffs what clients show, so any hint is worth a look; an unchanged
          // view sends no batch.
          if (watched.cheap !== s.fingerprint || reason === 'overflow' || reason === 'filesystem') {
            s.fingerprint = watched.cheap
            await publish(reason === 'overflow' ? 'overflow' : 'change')
          }
        } else if (watched.cheap !== s.fingerprint || reason === 'overflow') {
          s.fingerprint = watched.cheap
          const visible = await this.watchVisible(target, watched)
          if (this.stopped || !this.subscriptions.has(id)) return
          if (visible !== s.visible || reason === 'overflow') {
            s.visible = visible
            notify(reason)
          }
        }
      } catch (error) {
        // A moved/missing directory is itself an invalidation. Do not silently abandon the UI.
        // notify still rechecks owner/project authority; revocation/removal publishes nothing.
        if (
          error instanceof ChannelError &&
          ['repository_unavailable', 'stale_resource', 'git_timeout', 'output_limit'].includes(
            error.code
          )
        ) {
          try {
            if (changes) await publish('unavailable')
            else notify(reason)
          } catch {
            /* authorization may have disappeared too */
          }
        }
        this.unwatch(id)
      } finally {
        s.checking = false
        this.active--
        if (s.dirty && this.subscriptions.has(id) && !this.stopped && !s.pending)
          s.pending = setTimeout(() => {
            s.pending = undefined
            run(s.dirty ?? 'reconciliation')
          }, 100)
      }
    }
    const run = (reason: 'filesystem' | 'reconciliation' | 'overflow') => {
      const task = this.r.git.detached(15000, () => reconcile(reason))
      this.reconciliations.add(task)
      void task.finally(() => this.reconciliations.delete(task)).catch(() => {})
    }
    const schedule = () => {
      if (!s.pending)
        s.pending = setTimeout(() => {
          s.pending = undefined
          run('filesystem')
        }, 100)
    }
    const project = this.r.projects.get(target.project_id)
    // Fixed watcher budget. Nonrecursive platforms rely on reconciliation for nested changes.
    for (const path of [
      ...new Set([target.path, project.git_common_dir!, join(target.path, '.git')]),
    ]) {
      try {
        const w = watch(path, schedule)
        w.on('error', () => {
          run('overflow')
        })
        s.watchers.push(w)
      } catch {
        /* reconciliation is authoritative */
      }
    }
    s.timer = setInterval(() => {
      run('reconciliation')
    }, 2000)
    if (!stream) {
      notify('reconnect')
      return {
        subscription_id: id,
        expires_at: new Date(s.expires).toISOString(),
        refresh_required: true,
      }
    }
    // Hear nested edits at once, and describe anything that happened while nobody watched.
    await attach()
    schedule()
    return {
      subscription_id: id,
      expires_at: new Date(s.expires).toISOString(),
      refresh_required: !follows,
      changes: position ?? stream,
    }
  }
  request(actor: AuthorityContext, method: string, p: Record<string, unknown>): Promise<unknown> {
    // The injected runner controls the whole-read budget as well as individual
    // Git processes. Normal construction still uses 15s; search/blame keep their
    // separate, tighter execution budgets below.
    return this.r.git.bounded(this.r.git.timeoutMs, () => this.dispatch(actor, method, p))
  }
  private async dispatch(
    actor: AuthorityContext,
    method: string,
    p: Record<string, unknown>
  ): Promise<unknown> {
    if (this.stopped) throw new ChannelError('resource_busy')
    this.r.core.authority.check(actor, 'resource', String(p.worktree_id ?? p.project_id))
    if (this.active >= 4) throw new ChannelError('resource_busy')
    this.active++
    try {
      let result: unknown
      if (method === 'repository.v1.worktrees') result = await this.catalog(actor, method, p)
      else {
        const target = await this.validate(this.get(String(p.worktree_id)))
        const revision = p.revision as RepositoryRevision | undefined
        if (revision?.kind === 'working') await this.observation(actor, target, revision)
        switch (method) {
          case 'repository.v1.editing.get': {
            let enabled = true
            try {
              this.fileRoot(target.worktree_id)
            } catch (error) {
              if (error instanceof ChannelError && error.code === 'unauthorized') enabled = false
              else throw error
            }
            result = { worktree_id: target.worktree_id, enabled }
            break
          }
          case 'repository.v1.resolve':
            result = {
              kind: 'commit',
              commit: await this.r.git.text(target.path, { kind: 'resolve', ref: String(p.ref) }),
            }
            break
          case 'repository.v1.divergence':
            result = await this.divergence(actor, target, p)
            break
          case 'repository.v1.refs':
            result = await this.refs(actor, target, method, p)
            break
          case 'repository.v1.observe': {
            const includeIgnored = Boolean(p.include_ignored)
            const before = await this.workingState(target, includeIgnored),
              after = await this.workingState(target, includeIgnored)
            if (before.fingerprint !== after.fingerprint) throw new ChannelError('stale_revision')
            this.prune()
            const revision = {
              kind: 'working' as const,
              observation_id: randomUUID(),
              head: after.head,
              observed_at: new Date().toISOString(),
            }
            const observation: Observation = {
              target: target.worktree_id,
              owner: actor.installation_id,
              revision,
              fingerprint: after.fingerprint,
              files: after.files,
              status: await this.changeDetails(target, after.status, after.tracked),
              expires: Date.now() + ttl,
              includeIgnored,
              snapshot: after,
              ...(target.kind === 'external'
                ? {
                    registration: this.registrationIdentity(
                      await this.deletionRegistration(target)
                    ),
                  }
                : {}),
            }
            if (this.leaseSize(observation) > 8 * 1024 * 1024) throw new ChannelError('scan_limit')
            this.observations.set(revision.observation_id, observation)
            this.prune(after)
            result = { revision, atomic: false }
            break
          }
          case 'repository.v1.status':
            result = this.page(
              actor,
              method,
              p,
              (await this.observation(actor, target, revision!)).status.map((row) => {
                if (p.include_change_details) return row
                const {
                  kind: _kind,
                  stage: _stage,
                  change_id: _id,
                  changed_at: _at,
                  time_basis: _basis,
                  ...raw
                } = row
                return raw
              })
            )
            break
          case 'repository.v1.tree': {
            const continued = this.continuation(actor, method, p)
            if (continued) {
              result = continued
              break
            }
            let entries: TreeEntry[]
            if (revision!.kind === 'commit')
              entries = await this.commitTree(target, revision!.commit, String(p.path))
            else {
              const o = await this.observation(actor, target, revision!)
              const path = String(p.path ?? '')
              if (path && o.snapshot.byPath.get(path)?.kind !== 'directory')
                throw new ChannelError('unsafe_path')
              this.checked(target, path)
              this.checkObservedPath(target, o.snapshot, path)
              entries = o.snapshot.children.get(path) ?? []
            }
            result = this.page(
              actor,
              method,
              p,
              revision!.kind === 'working'
                ? entries
                : entries.sort((a, b) => a.path.localeCompare(b.path))
            )
            break
          }
          case 'repository.v1.blob':
            result = await this.blob(actor, target, p)
            break
          case 'repository.v1.content': {
            const bytes = this.content(target, String(p.content_id)),
              offset = Number(p.offset)
            result = {
              offset,
              total: bytes.length,
              base64: bytes.subarray(offset, offset + Number(p.length)).toString('base64'),
            }
            break
          }
          case 'repository.v1.history':
          case 'repository.v1.commit':
            result = await this.history(actor, target, method, p)
            break
          case 'repository.v1.compare':
            result = await this.compare(actor, target, method, p)
            break
          case 'repository.v1.patch':
            result = await this.patch(actor, target, p)
            break
          case 'repository.v1.blame':
            result = await this.r.git.bounded(5000, () => this.blame(actor, target, p))
            break
          case 'repository.v1.search':
            result = await this.r.git.bounded(5000, () => this.search(actor, target, method, p))
            break
          case 'repository.v1.watch':
            result = await this.subscribe(
              actor,
              target,
              p.changes as { stream_id: string; revision: number } | null | undefined
            )
            break
          case 'repository.v1.unwatch': {
            const s = this.subscriptions.get(String(p.subscription_id))
            if (
              s &&
              (s.owner.installation_id !== actor.installation_id ||
                s.target.worktree_id !== target.worktree_id)
            )
              throw new ChannelError('unauthorized')
            this.unwatch(String(p.subscription_id))
            result = { removed: true }
            break
          }
          default:
            throw new ChannelError('unsupported_method')
        }
        if (revision?.kind === 'working') {
          const o = await this.observation(actor, target, revision)
          if (method === 'repository.v1.tree') {
            const path = String(p.path ?? '')
            this.checked(target, path)
            this.checkObservedPath(target, o.snapshot, path)
          }
          if (method === 'repository.v1.blame') {
            this.checked(target, String(p.path))
            this.checkObservedPath(target, o.snapshot, String(p.path))
          }
          if (
            ['repository.v1.tree', 'repository.v1.status', 'repository.v1.search'].includes(method)
          )
            for (const entry of (result as { entries: { path: string }[] }).entries)
              this.checkObservedPath(target, o.snapshot, entry.path)
        }
        await this.validate(target)
      }
      this.checkPublication(actor, p, result)
      return result
    } finally {
      this.active--
    }
  }
  revoked(installation: string) {
    this.clearObjectCache()
    for (const [id, s] of this.subscriptions)
      if (s.owner.installation_id === installation) this.unwatch(id)
    for (const [id, o] of this.observations)
      if (o.owner === installation) this.observations.delete(id)
    for (const [id, c] of this.cursors) if (c.owner === installation) this.cursors.delete(id)
    for (const [id, c] of this.comparisons)
      if (c.owner === installation) this.comparisons.delete(id)
  }
  async stop() {
    this.stopped = true
    for (const monitor of this.monitors.values()) monitor.close()
    this.monitors.clear()
    this.snapshots.clear()
    this.clearObjectCache()
    for (const id of this.subscriptions.keys()) this.unwatch(id)
    this.changes.clear()
    await Promise.all([...this.workers].map((w) => w.terminate()))
    await Promise.allSettled([...this.reconciliations])
    this.workers.clear()
  }
}

export const searchWorker = `
const { parentPort } = require('node:worker_threads');
let query, mode, sensitive, expression, glob;
parentPort.on('message', data => {
  if (data.init) {
    try {
      query = data.query; mode = data.mode; sensitive = data.case_sensitive;
      if (mode === 'regex') expression = new RegExp(query, sensitive ? '' : 'i');
      if (data.path_glob) {
        const escaped = data.path_glob.replace(/[.+^$(){}|[\]\\\\]/g, '\\\\$&').replace(/\\*\\*/g, '\\u0001').replace(/\\*/g, '[^/]*').replace(/\\?/g, '[^/]').replace(/\\u0001/g, '.*');
        glob = new RegExp('^' + escaped + '$');
      }
      parentPort.postMessage({ ok: true });
    } catch { parentPort.postMessage({ error: true }); }
    return;
  }
  if (data.filter_paths) {
    parentPort.postMessage({ included: data.filter_paths.map(path => !glob || glob.test(path)) });
    return;
  }
  const matches = []; let truncated = false;
  if (!glob || glob.test(data.path)) {
    const match = text => mode === 'regex' ? expression.test(text) : (sensitive ? text : text.toLowerCase()).includes(sensitive ? query : query.toLowerCase());
    if (mode === 'filename') { if (match(data.path)) matches.push({ line: 0, text: data.path }); }
    else {
      const lines = data.text.split('\\n');
      for (let i = 0; i < lines.length; i++) if (match(lines[i])) {
        if (matches.length >= data.max) { truncated = true; break; }
        if (lines[i].length > 4096) truncated = true;
        matches.push({ line: i + 1, text: lines[i].slice(0,4096) });
      }
    }
  }
  parentPort.postMessage({ matches, truncated });
});
`
