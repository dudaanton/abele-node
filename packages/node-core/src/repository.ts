import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  realpathSync,
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
  type RepositoryRevision,
  type WorktreeEntry,
  type Project,
  type RepositoryMethod,
  type RepositoryParams,
} from '@abele/node-protocol'
import type { ResourceServices } from './resources.js'
import { decodeGit, parseWorktrees, type GitCommand } from './git.js'

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
interface Target {
  worktree_id: string
  project_id: string
  path: string
  kind: WorktreeEntry['kind']
  workspace_id: string | null
  fingerprint: string
  active: number
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
}
interface Comparison {
  owner: string
  target: string
  base: RepositoryRevision
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
  expires: number
  watchers: FSWatcher[]
  timer?: NodeJS.Timeout
  pending?: NodeJS.Timeout
  checking: boolean
}

/** Read-only repository targets deliberately do not enter the managed-workspace/provider tables. */
export class RepositoryService {
  private observations = new Map<string, Observation>()
  private cursors = new Map<string, Continuation>()
  private comparisons = new Map<string, Comparison>()
  private subscriptions = new Map<string, Subscription>()
  private workers = new Set<Worker>()
  private reconciliations = new Set<Promise<void>>()
  private active = 0
  private stopped = false
  constructor(private r: ResourceServices) {
    const version = r.core.db
      .prepare("SELECT value FROM meta WHERE key='repository_schema_version'")
      .get() as { value: string } | undefined
    if (version && version.value !== '1') throw new Error('unsupported_repository_database_version')
    r.core.db.exec(`BEGIN IMMEDIATE;
      CREATE INDEX IF NOT EXISTS repository_workspace_path ON workspaces(project_id,json_extract(body,'$.path')) WHERE state!='removed';
      CREATE TABLE IF NOT EXISTS repository_projects(project_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, external_read INTEGER NOT NULL DEFAULT 0, default_branch TEXT);
      CREATE TABLE IF NOT EXISTS repository_targets(worktree_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, workspace_id TEXT, fingerprint TEXT NOT NULL, active INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS repository_contents(worktree_id TEXT NOT NULL, content_id TEXT NOT NULL, content BLOB NOT NULL, touched INTEGER NOT NULL, PRIMARY KEY(worktree_id,content_id));
      INSERT OR IGNORE INTO meta VALUES('repository_schema_version','1');
      COMMIT;
    `)
  }
  private projectFingerprint(p: Project) {
    return hash(
      JSON.stringify([stamp(p.root_path), p.git_common_dir ? stamp(p.git_common_dir) : null])
    )
  }
  registered(p: Project) {
    const fingerprint = this.projectFingerprint(p)
    const old = this.r.core.db
      .prepare('SELECT fingerprint FROM repository_projects WHERE project_id=?')
      .get(p.project_id) as { fingerprint: string } | undefined
    if (old && old.fingerprint !== fingerprint) this.removed(p.project_id)
    this.r.core.db
      .prepare('INSERT OR IGNORE INTO repository_projects(project_id,fingerprint) VALUES(?,?)')
      .run(p.project_id, fingerprint)
  }
  removed(id: string) {
    this.r.core.db.prepare('DELETE FROM repository_projects WHERE project_id=?').run(id)
    this.r.core.db.prepare('UPDATE repository_targets SET active=0 WHERE project_id=?').run(id)
    for (const [key, s] of this.subscriptions) if (s.target.project_id === id) this.unwatch(key)
  }
  settings(actor: AuthorityContext, p: Record<string, unknown>, operation?: string) {
    const core = this.r.core
    return core.commitOperation(actor, 'project.repository_settings', p, operation, () => {
      const project = this.r.projects.get(String(p.project_id))
      this.registered(project)
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
        for (const id of targets)
          core.db.prepare('DELETE FROM repository_contents WHERE worktree_id=?').run(id)
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
  private targetFingerprint(path: string) {
    return hash(JSON.stringify([stamp(path), stamp(join(path, '.git'))]))
  }
  private async validate(target: Target) {
    if (!target.active) throw new ChannelError('stale_resource')
    const project = this.r.projects.get(target.project_id),
      config = this.config(target.project_id)
    if (target.kind === 'external' && !config.external_read) throw new ChannelError('unauthorized')
    await this.r.projects.available(project)
    try {
      if (
        realpathSync(target.path) !== target.path ||
        lstatSync(target.path).isSymbolicLink() ||
        this.targetFingerprint(target.path) !== target.fingerprint
      )
        throw new Error()
      if (
        realpathSync(await this.r.git.text(target.path, { kind: 'root' })) !== target.path ||
        realpathSync(await this.r.git.text(target.path, { kind: 'common' })) !==
          project.git_common_dir
      )
        throw new Error()
      const records = parseWorktrees(await this.r.git.run(project.root_path, { kind: 'worktrees' }))
      if (!records.some((w) => w.path === target.path && !w.bare)) throw new Error()
    } catch {
      throw new ChannelError('repository_unavailable')
    }
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
  private get(id: string) {
    const row = this.r.core.db
      .prepare('SELECT * FROM repository_targets WHERE worktree_id=?')
      .get(id) as unknown as Target | undefined
    if (!row) throw new ChannelError('not_found')
    return row
  }
  private prune() {
    for (const map of [this.observations, this.cursors, this.comparisons]) {
      for (const [key, value] of map) if (value.expires < Date.now()) map.delete(key)
      const size = (value: unknown) =>
        Buffer.byteLength(
          JSON.stringify(value, (_key, v: unknown) =>
            v instanceof Map ? [...v] : v instanceof Set ? [...v] : v
          )
        )
      let bytes = [...map.values()].reduce((sum, value) => sum + size(value), 0)
      while (map.size >= 128 || bytes > 8 * 1024 * 1024) {
        const key = map.keys().next().value!
        bytes -= size(map.get(key))
        map.delete(key)
      }
    }
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
    omissions: string[] = []
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
    if (offset < rows.length) {
      cursor = randomUUID()
      this.cursors.set(cursor, {
        owner: actor.installation_id,
        target,
        key,
        rows,
        offset,
        expires: Date.now() + ttl,
        extra,
        omissions,
      })
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
      config = this.config(project.project_id)
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
        branch: record.branch,
        detached: record.detached,
        head: record.head && !/^0+$/.test(record.head) ? record.head : null,
        availability,
        locked: record.locked,
        prunable: record.prunable,
        dirty,
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
      !this.config(project.project_id).external_read
    )
      throw new ChannelError('unauthorized')
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
  private async workingState(target: Target, includeIgnored = false) {
    const head = await this.head(target),
      status = this.parseStatus(await this.r.git.run(target.path, { kind: 'status' }))
    const tracked = decodeGit(await this.r.git.run(target.path, { kind: 'tracked' }))
      .split('\0')
      .filter(Boolean)
    const paths = new Map<string, { kind: TreeEntry['kind']; oid: string | null }>()
    for (const f of tracked) {
      const m = f.match(/^(\d+) ([a-f0-9]+) \d\t([\s\S]*)$/)
      if (!m) throw new ChannelError('git_failed')
      if (safePath(m[3]!))
        paths.set(m[3]!, {
          kind: m[1] === '160000' ? 'submodule' : m[1] === '120000' ? 'symlink' : 'file',
          oid: m[2]!,
        })
    }
    for (const path of decodeGit(
      await this.r.git.run(target.path, {
        kind: includeIgnored ? 'untracked' : 'visible.untracked',
      })
    )
      .split('\0')
      .filter(Boolean))
      if (safePath(path)) paths.set(path, { kind: 'file', oid: null })
    if (paths.size > 10000) throw new ChannelError('scan_limit')
    const files: TreeEntry[] = [],
      stamps: unknown[] = []
    const submodules = [...paths].filter(([, d]) => d.kind === 'submodule').map(([path]) => path)
    for (const [path, data] of paths) {
      if (submodules.some((parent) => path.startsWith(parent + '/'))) continue
      try {
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
        this.checked(target, parent)
        const full = join(target.path, path),
          s = lstatSync(full)
        stamps.push([path, metadata(full)])
        files.push({
          path,
          name: path.split('/').at(-1)!,
          kind: s.isSymbolicLink() ? 'symlink' : data.kind,
          oid: data.oid,
          size: s.size,
        })
      } catch {
        stamps.push([path, null])
      }
    }
    const gitdir = await this.r.git.text(target.path, { kind: 'directory' })
    const internal = ['HEAD', 'index'].map((name) => {
      try {
        return metadata(join(gitdir, name))
      } catch {
        return null
      }
    })
    return {
      head,
      files,
      status,
      fingerprint: hash(JSON.stringify([head, status, stamps, internal])),
    }
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
    if ((await this.workingState(target, o.includeIgnored)).fingerprint !== o.fingerprint)
      throw new ChannelError('stale_revision')
    return o
  }
  private retain(target: Target, bytes: Buffer) {
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
  private async commitTree(target: Target, commit: string, path = '', recursive = false) {
    // Resolve directory one component at a time; links/gitlinks are never dereferenced.
    let object = commit,
      prefix = ''
    for (const part of path.split('/').filter(Boolean)) {
      const entries = this.parseTree(await this.r.git.run(target.path, { kind: 'tree', object }))
      const dir = entries.find((e) => e.name === part)
      if (!dir || dir.kind !== 'directory') throw new ChannelError('unsafe_path')
      object = dir.oid!
      prefix += part + '/'
    }
    return this.parseTree(
      await this.r.git.run(target.path, { kind: 'tree', object, recursive }),
      prefix
    )
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
      const entry = o.files.find((e) => e.path === path)
      if (!entry || entry.kind !== 'file') throw new ChannelError('unsafe_path')
      const result = this.readFile(target, path, limit)
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
      await this.r.git.text(target.path, { kind: 'blob.size', object: entry.oid! })
    )
    if (size > limit) return { size, bytes: null }
    return { size, bytes: await this.r.git.run(target.path, { kind: 'blob', object: entry.oid! }) }
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
    for (let i = 0; i <= count; i++) {
      const f = decodeGit(
        await this.r.git.run(target.path, {
          kind: 'history',
          commit,
          offset: offset + i,
          limit: 1,
          ...(p.path ? { path: String(p.path) } : {}),
        })
      ).split('\0')
      if (!f[0]?.trim()) break
      if (f.length !== 8) throw new ChannelError('unsupported_commit_metadata')
      const row = {
        commit: f[0].trim(),
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
    let base = p.base as RepositoryRevision,
      head = p.head as RepositoryRevision
    const mode = p.mode as Comparison['mode']
    if (base.kind !== 'commit') throw new ChannelError('invalid_revision')
    if (head.kind === 'working') await this.observation(actor, target, head)
    if (mode === 'merge-base') {
      const commit = head.kind === 'commit' ? head.commit : head.head
      if (!commit) throw new ChannelError('invalid_revision')
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
    const fields = decodeGit(
      await this.r.git.run(target.path, {
        kind: 'changes',
        base: base.commit,
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
    }
    this.prune()
    const id = randomUUID()
    this.comparisons.set(id, {
      owner: actor.installation_id,
      target: target.worktree_id,
      base,
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
    if (!comparison.paths.has(path) || comparison.base.kind !== 'commit')
      throw new ChannelError('not_found')
    const captured = comparison.patches.get(path)
    if (captured) {
      this.content(target, captured.content_id)
      return captured
    }
    let bytes: Buffer
    if (comparison.head.kind === 'working') {
      const o = await this.observation(actor, target, comparison.head)
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
          base: comparison.base.commit,
          staged: comparison.mode === 'staged',
          unstaged: comparison.mode === 'unstaged',
          path,
        })
      await this.observation(actor, target, comparison.head)
    } else
      bytes = await this.r.git.run(target.path, {
        kind: 'patch',
        base: comparison.base.commit,
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
    const continued = this.continuation(actor, 'repository.v1.blame', p)
    if (continued) return continued
    const revision = p.revision as RepositoryRevision,
      path = String(p.path)
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
    const continued = this.continuation(actor, method, p)
    if (continued) return continued
    const revision = p.revision as RepositoryRevision
    let files =
      revision.kind === 'commit'
        ? await this.commitTree(target, revision.commit, '', true)
        : (await this.observation(actor, target, revision)).files
    if (p.scope === 'changed') {
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
    let scanned = 0,
      bytes = 0
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
            Math.max(1, 5000 - (Date.now() - start))
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
      if (p.path_glob) {
        // Match in the terminable worker before consuming file/byte budgets or reading blobs.
        const filtered = await call({ filter_paths: files.map((file) => file.path) })
        files = files.filter((_file, index) => filtered.included[index])
      }
      for (const file of files) {
        if (file.kind !== 'file') continue
        if (
          ++scanned > 2048 ||
          bytes >= 32 * 1024 * 1024 ||
          Date.now() - start >= 5000 ||
          rows.length >= 1000
        ) {
          omissions.add('scan limit; refine query to cover remaining files')
          break
        }
        if (file.size !== null && file.size > 1024 * 1024) {
          omissions.add('files over 1 MiB skipped')
          continue
        }
        let content: Buffer | null = null,
          content_id: string | null = null
        if (p.mode !== 'filename') {
          if (revision.kind === 'working')
            content = this.readFile(target, file.path, 1024 * 1024).bytes
          else
            content = await this.r.git.run(
              target.path,
              { kind: 'blob', object: file.oid! },
              undefined,
              Math.max(1, 5000 - (Date.now() - start))
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
      return this.page(actor, method, p, rows, {}, [...omissions])
    } catch (e) {
      if (e instanceof ChannelError && ['search_deadline', 'git_timeout'].includes(e.code)) {
        // The outer read budget rechecks observation/authority after the worker budget expires.
        return this.page(actor, method, p, rows, {}, [
          ...omissions,
          '5-second deadline; incomplete coverage',
        ])
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
    this.subscriptions.delete(id)
  }
  private async watchFingerprint(target: Target) {
    return hash(
      JSON.stringify([
        (await this.workingState(target)).fingerprint,
        (await this.r.git.run(target.path, { kind: 'refs' })).toString('base64'),
        (await this.r.git.run(target.path, { kind: 'worktrees' })).toString('base64'),
      ])
    )
  }
  private async subscribe(actor: AuthorityContext, target: Target) {
    for (const [key, s] of this.subscriptions)
      if (
        s.expires < Date.now() ||
        (s.owner.installation_id === actor.installation_id &&
          s.target.worktree_id === target.worktree_id)
      )
        this.unwatch(key)
    if (this.subscriptions.size >= 16) throw new ChannelError('resource_busy')
    const id = randomUUID(),
      s: Subscription = {
        owner: actor,
        target,
        fingerprint: await this.watchFingerprint(target),
        expires: Date.now() + 60000,
        watchers: [],
        checking: false,
      }
    this.subscriptions.set(id, s)
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
    const reconcile = async (reason: 'filesystem' | 'reconciliation' | 'overflow') => {
      if (s.checking || this.stopped || this.active >= 4) return
      s.checking = true
      this.active++
      try {
        if (s.expires < Date.now()) {
          this.unwatch(id)
          return
        }
        this.r.core.authority.check(actor, 'resource', target.worktree_id)
        await this.validate(target)
        const fingerprint = await this.watchFingerprint(target)
        if (this.stopped || !this.subscriptions.has(id)) return
        if (s.expires < Date.now()) {
          this.unwatch(id)
          return
        }
        if (fingerprint !== s.fingerprint || reason === 'overflow' || reason === 'filesystem') {
          s.fingerprint = fingerprint
          notify(reason)
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
            notify(reason)
          } catch {
            /* authorization may have disappeared too */
          }
        }
        this.unwatch(id)
      } finally {
        s.checking = false
        this.active--
      }
    }
    const run = (reason: 'filesystem' | 'reconciliation' | 'overflow') => {
      const task = this.r.git.bounded(15000, () => reconcile(reason))
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
    notify('reconnect')
    return {
      subscription_id: id,
      expires_at: new Date(s.expires).toISOString(),
      refresh_required: true,
    }
  }
  request(actor: AuthorityContext, method: string, p: Record<string, unknown>): Promise<unknown> {
    return this.r.git.bounded(15000, () => this.dispatch(actor, method, p))
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
          case 'repository.v1.resolve':
            result = {
              kind: 'commit',
              commit: await this.r.git.text(target.path, { kind: 'resolve', ref: String(p.ref) }),
            }
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
            this.observations.set(revision.observation_id, {
              target: target.worktree_id,
              owner: actor.installation_id,
              revision,
              fingerprint: after.fingerprint,
              files: after.files,
              status: after.status,
              expires: Date.now() + ttl,
              includeIgnored,
            })
            this.prune()
            result = { revision, atomic: false }
            break
          }
          case 'repository.v1.status':
            result = this.page(
              actor,
              method,
              p,
              (await this.observation(actor, target, revision!)).status
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
              const o = await this.observation(actor, target, revision!),
                prefix = p.path ? String(p.path) + '/' : '',
                dirs = new Map<string, TreeEntry>()
              if (p.path) {
                if (
                  o.files.some(
                    (f) =>
                      f.kind === 'submodule' &&
                      (p.path === f.path || String(p.path).startsWith(f.path + '/'))
                  )
                )
                  throw new ChannelError('unsafe_path')
                this.checked(target, String(p.path))
              }
              entries = []
              for (const f of o.files)
                if (f.path.startsWith(prefix)) {
                  const rest = f.path.slice(prefix.length)
                  if (!rest.includes('/')) entries.push(f)
                  else {
                    const name = rest.split('/')[0]!
                    dirs.set(name, {
                      path: prefix + name,
                      name,
                      kind: 'directory',
                      oid: null,
                      size: null,
                    })
                  }
                }
              entries.push(...dirs.values())
            }
            result = this.page(
              actor,
              method,
              p,
              entries.sort((a, b) => a.path.localeCompare(b.path))
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
            result = await this.subscribe(actor, target)
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
        if (revision?.kind === 'working') await this.observation(actor, target, revision)
        await this.validate(target)
      }
      this.checkPublication(actor, p, result)
      return result
    } finally {
      this.active--
    }
  }
  async stop() {
    this.stopped = true
    for (const id of this.subscriptions.keys()) this.unwatch(id)
    await Promise.all([...this.workers].map((w) => w.terminate()))
    await Promise.allSettled([...this.reconciliations])
    this.workers.clear()
  }
}

const searchWorker = `
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
