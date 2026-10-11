import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  realpathSync,
  readdirSync,
  mkdirSync,
  watch,
  type FSWatcher,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { ChannelError, type AuthorityContext } from '@abele/channel-protocol'
import {
  NodePathMethodSchemas,
  NODE_PATH_MUTATIONS,
  ProjectSchema,
  FileOperationMethodSchemas,
  type FileOperationMethod,
} from '@abele/node-protocol'
import type { ResourceServices } from './resources.js'
import { canonical } from './index.js'
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
const identity = (path: string) => {
  const s = lstatSync(path)
  if (s.isSymbolicLink() || !s.isDirectory() || realpathSync(path) !== path)
    throw new ChannelError('unsafe_path')
  return `${s.dev}:${s.ino}`
}
interface Directory {
  owner: string
  path: string
  identity: string
  expires: number
  entries: { name: string; path: string }[]
  omissions: string[]
}
interface Cursor {
  directory: string
  offset: number
}
interface Lease {
  owner: AuthorityContext
  workspace: string
  root: string
  identity: string
  fingerprint: string
  expires: number
  timer: NodeJS.Timeout
  watcher?: FSWatcher
  pending?: NodeJS.Timeout
}
/** Owner picker handles are not agent filesystem authority. Effects never replay unknown intents. */
export class NodePathService {
  fault?: () => void
  private directories = new Map<string, Directory>()
  private cursors = new Map<string, Cursor>()
  private leases = new Map<string, Lease>()
  private stopped = false
  constructor(private r: ResourceServices) {
    r.core.db.exec(
      `CREATE TABLE IF NOT EXISTS node_path_effects(principal_id TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, PRIMARY KEY(principal_id,operation_id));`
    )
  }
  handles(method: string) {
    return (
      Object.hasOwn(NodePathMethodSchemas, method) &&
      ![
        'repository.v1.divergence',
        'project.trust',
        'project.execution',
        'session.worktree.get',
        'session.worktree.set',
      ].includes(method)
    )
  }
  private prune() {
    for (const [id, d] of this.directories) if (d.expires < Date.now()) this.directories.delete(id)
    for (const [id, c] of this.cursors)
      if (!this.directories.has(c.directory)) this.cursors.delete(id)
  }
  private directory(actor: AuthorityContext, id: string) {
    this.prune()
    const d = this.directories.get(id)
    if (!d) throw new ChannelError('stale_resource')
    if (d.owner !== actor.installation_id) throw new ChannelError('unauthorized')
    try {
      if (identity(d.path) !== d.identity) throw new Error()
    } catch {
      throw new ChannelError('stale_resource')
    }
    return d
  }
  private browse(actor: AuthorityContext, p: Record<string, unknown>) {
    this.prune()
    let id: string,
      offset = 0,
      d: Directory
    if (p.cursor) {
      const c = this.cursors.get(String(p.cursor))
      if (!c) throw new ChannelError('stale_cursor')
      id = c.directory
      offset = c.offset
      d = this.directory(actor, id)
      if (p.path !== undefined && String(p.path) !== d.path) throw new ChannelError('stale_cursor')
    } else {
      if (this.directories.size >= 64) throw new ChannelError('resource_busy')
      let path: string
      try {
        path = realpathSync(String(p.path ?? homedir()))
      } catch {
        throw new ChannelError('repository_unavailable')
      }
      const pin = identity(path),
        entries: Directory['entries'] = [],
        omissions: string[] = []
      const names = readdirSync(path, { encoding: 'utf8' }).sort()
      if (names.length > 10000) throw new ChannelError('scan_limit')
      for (const name of names) {
        try {
          const full = join(path, name),
            s = lstatSync(full)
          if (!s.isSymbolicLink() && s.isDirectory() && !name.includes('\ufffd'))
            entries.push({ name, path: full })
        } catch {
          omissions.push('inaccessible entry')
        }
      }
      if (identity(path) !== pin) throw new ChannelError('stale_resource')
      id = randomUUID()
      d = {
        owner: actor.installation_id,
        path,
        identity: pin,
        expires: Date.now() + 60000,
        entries,
        omissions,
      }
      this.directories.set(id, d)
    }
    const entries: Directory['entries'] = []
    let bytes = 1024
    for (const entry of d.entries.slice(offset, offset + Number(p.limit))) {
      bytes += Buffer.byteLength(JSON.stringify(entry))
      if (bytes > 32768) break
      entries.push(entry)
    }
    offset += entries.length
    let cursor: string | null = null
    if (offset < d.entries.length) {
      if (this.cursors.size >= 256) throw new ChannelError('resource_busy')
      cursor = randomUUID()
      this.cursors.set(cursor, { directory: id, offset })
    }
    return {
      directory_id: id,
      path: d.path,
      parent_path: dirname(d.path) === d.path ? null : dirname(d.path),
      entries,
      cursor,
      incomplete: d.omissions.length > 0,
      omissions: d.omissions,
    }
  }
  private effectIntent(
    actor: AuthorityContext,
    method: string,
    p: Record<string, unknown>,
    operation: string
  ) {
    const request_hash = hash({ method, params: p })
    return this.r.core.reserveOperation(actor, method, p, operation, () => {
      this.r.core.db
        .prepare('INSERT INTO node_path_effects VALUES(?,?,?)')
        .run(actor.installation_id, operation, request_hash)
    })
  }
  private receipt(
    actor: AuthorityContext,
    method: string,
    p: Record<string, unknown>,
    operation: string,
    result: unknown
  ) {
    return this.r.core.commitOperation(actor, method, p, operation, () => {
      this.r.core.db
        .prepare('DELETE FROM node_path_effects WHERE principal_id=? AND operation_id=?')
        .run(actor.installation_id, operation)
      return result
    })
  }
  snapshot(root: string) {
    return this.fingerprint(root)
  }
  private fingerprint(root: string) {
    const records: unknown[] = [],
      walk = (path: string, depth: number) => {
        if (depth > 32 || records.length >= 10000) throw new ChannelError('scan_limit')
        for (const name of readdirSync(path).sort()) {
          if (name.toLowerCase() === '.git') continue
          const full = join(path, name),
            s = lstatSync(full)
          records.push([full, s.dev, s.ino, s.mode, s.size, s.mtimeMs, s.ctimeMs])
          if (s.isDirectory() && !s.isSymbolicLink()) walk(full, depth + 1)
          if (records.length >= 10000) throw new ChannelError('scan_limit')
        }
      }
    walk(root, 0)
    return hash(records)
  }
  private unwatch(id: string) {
    const l = this.leases.get(id)
    if (!l) return
    clearInterval(l.timer)
    if (l.pending) clearTimeout(l.pending)
    l.watcher?.close()
    this.leases.delete(id)
  }
  private notify(l: Lease, reason: 'filesystem' | 'reconciliation' | 'reconnect' | 'overflow') {
    this.r.core.authority.check(l.owner, 'publish', l.workspace)
    const w = this.r.workspaces.get(l.workspace)
    this.r.projects.get(w.project_id)
    this.r.core.append(
      'catalog',
      'workspace.invalidated',
      { kind: 'installation', installation_id: l.owner.installation_id },
      { workspace_id: l.workspace, reason, generation: randomUUID() }
    )
  }
  private subscribe(actor: AuthorityContext, workspace: string) {
    for (const [id, l] of this.leases)
      if (
        l.expires < Date.now() ||
        (l.owner.installation_id === actor.installation_id && l.workspace === workspace)
      )
        this.unwatch(id)
    if (this.leases.size >= 16) throw new ChannelError('resource_busy')
    const w = this.r.workspaces.get(workspace),
      project = this.r.projects.get(w.project_id)
    if (project.repository_path || w.kind !== 'root') throw new ChannelError('invalid_params')
    if (w.state !== 'ready') throw new ChannelError('resource_busy')
    const id = randomUUID(),
      pin = identity(w.path),
      fingerprint = this.fingerprint(w.path)
    const check = (reason: 'filesystem' | 'reconciliation' | 'overflow') => {
      const l = this.leases.get(id)
      if (!l) return
      if (l.expires < Date.now()) {
        this.unwatch(id)
        return
      }
      try {
        this.r.core.authority.check(actor, 'resource', workspace)
        if (identity(l.root) !== l.identity) {
          this.notify(l, 'overflow')
          this.unwatch(id)
          return
        }
        const current = this.fingerprint(l.root)
        if (current !== l.fingerprint || reason !== 'reconciliation') {
          l.fingerprint = current
          this.notify(l, reason)
        }
      } catch {
        try {
          this.notify(l, 'overflow')
        } catch {
          /* revoked */
        }
        this.unwatch(id)
      }
    }
    const l: Lease = {
      owner: actor,
      workspace,
      root: w.path,
      identity: pin,
      fingerprint,
      expires: Date.now() + 60000,
      timer: setInterval(() => check('reconciliation'), 2000),
    }
    this.leases.set(id, l)
    try {
      l.watcher = watch(w.path, () => {
        if (!l.pending)
          l.pending = setTimeout(() => {
            l.pending = undefined
            check('filesystem')
          }, 100)
      })
      l.watcher.on('error', () => check('overflow'))
    } catch {
      /* bounded reconciliation remains authoritative */
    }
    this.notify(l, 'reconnect')
    return {
      subscription_id: id,
      expires_at: new Date(l.expires).toISOString(),
      refresh_required: true,
    }
  }
  async request(
    actor: AuthorityContext,
    method: string,
    p: Record<string, unknown>,
    operation?: string
  ): Promise<unknown> {
    if (this.stopped) throw new ChannelError('resource_busy')
    this.r.core.authority.check(actor, 'resource', String(p.project_id ?? p.workspace_id ?? ''))
    // Deletion owns receipt/pending-intent reconciliation under its repository lock.
    if (method === 'repository.v1.worktree.delete')
      return this.r.repository.deleteWorktree(actor, p, operation)
    if ((NODE_PATH_MUTATIONS as readonly string[]).includes(method)) {
      const previous = this.r.core.operationReceipt(actor, method, p, operation)
      if (previous) return previous.result
      const pending = this.r.core.db
        .prepare(
          'SELECT request_hash FROM node_path_effects WHERE principal_id=? AND operation_id=?'
        )
        .get(actor.installation_id, operation!) as { request_hash: string } | undefined
      if (pending)
        throw new ChannelError(
          pending.request_hash === hash({ method, params: p })
            ? 'outcome_unknown'
            : 'idempotency_mismatch'
        )
    }
    if (Object.hasOwn(FileOperationMethodSchemas, method))
      return this.r.mutations.fileOperation(actor, method as FileOperationMethod, p, operation)
    switch (method) {
      case 'filesystem.v1.directories':
        return this.browse(actor, p)
      case 'filesystem.v1.mkdir': {
        const d = this.directory(actor, String(p.directory_id)),
          fd = openSync(d.path, constants.O_RDONLY | constants.O_NOFOLLOW)
        try {
          const s = fstatSync(fd)
          if (`${s.dev}:${s.ino}` !== d.identity) throw new ChannelError('stale_resource')
          const path = join(d.path, String(p.name))
          try {
            lstatSync(path)
            throw new ChannelError('stale_resource')
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
          }
          const previous = this.effectIntent(actor, method, p, operation!)
          if (previous) return previous.result
          this.directory(actor, String(p.directory_id))
          // On Linux anchor the child lookup to the inspected descriptor, not a replaceable path.
          mkdirSync(process.platform === 'linux' ? `/proc/self/fd/${fd}/${String(p.name)}` : path, {
            mode: 0o700,
          })
          fsyncSync(fd)
          this.fault?.()
          if (identity(d.path) !== d.identity) throw new ChannelError('outcome_unknown')
          return this.receipt(actor, method, p, operation!, { path })
        } finally {
          closeSync(fd)
        }
      }
      case 'project.git_init': {
        const project = this.r.projects.get(String(p.project_id))
        return this.r.git.serialize(project.root_path, async () => {
          const previous = this.r.core.operationReceipt(actor, method, p, operation)
          if (previous) return previous.result
          const registration = this.r.repository.checkWorkspaceIdentity(project.project_id)
          const pin = identity(project.root_path)
          const checkRegistration = () => {
            const current = this.r.projects.get(project.project_id)
            if (
              current.root_path !== project.root_path ||
              this.r.repository.checkWorkspaceIdentity(project.project_id) !== registration ||
              identity(project.root_path) !== pin
            )
              throw new ChannelError('stale_resource')
          }
          const checkLifecycle = () => {
            checkRegistration()
            const current = this.r.projects.get(project.project_id)
            if (this.r.targets.projectBusy(current.project_id))
              throw new ChannelError('resource_busy')
            if (current.repository_path || current.git_common_dir)
              throw new ChannelError('git_required')
            return current
          }
          checkLifecycle()
          await this.r.projects.available(project)
          checkLifecycle()
          try {
            await this.r.git.text(project.root_path, { kind: 'root' })
            throw new ChannelError('git_required')
          } catch (e) {
            if (!(e instanceof ChannelError) || e.code !== 'git_failed') throw e
          }
          checkLifecycle()
          const reserved = this.effectIntent(actor, method, p, operation!)
          if (reserved) return reserved.result
          await this.r.git.run(
            project.root_path,
            { kind: 'init', branch: String(p.initial_branch) },
            () => {
              this.r.core.authority.check(actor, 'mutate', project.project_id)
              checkLifecycle()
            }
          )
          this.fault?.()
          const beforeInspection = checkLifecycle()
          const inspected = await this.r.projects.inspect(
            project.root_path,
            beforeInspection.trust,
            true
          )
          return this.r.core.commitOperation(actor, method, p, operation, () => {
            const current = checkLifecycle()
            if (
              inspected.root_path !== current.root_path ||
              inspected.repository_path !== current.root_path ||
              !inspected.git_common_dir
            )
              throw new ChannelError('repository_unavailable')
            const updated = ProjectSchema.parse({
              ...current,
              repository_path: inspected.repository_path,
              git_common_dir: inspected.git_common_dir,
            })
            this.r.core.db
              .prepare('UPDATE projects SET body=? WHERE project_id=?')
              .run(JSON.stringify(updated), project.project_id)
            this.r.repository.registered(updated)
            this.r.core.db
              .prepare('DELETE FROM node_path_effects WHERE principal_id=? AND operation_id=?')
              .run(actor.installation_id, operation!)
            this.r.core.append(
              'catalog',
              'project.registered',
              { kind: 'installation', installation_id: actor.installation_id },
              updated
            )
            return updated
          })
        })
      }
      case 'project.worktree_selection':
        return this.r.repository.select(actor, p, operation)
      case 'workspace.search':
        return this.r.search.request(actor, p)
      case 'workspace.watch':
        return this.subscribe(actor, String(p.workspace_id))
      case 'workspace.unwatch': {
        const l = this.leases.get(String(p.subscription_id))
        if (
          l &&
          (l.owner.installation_id !== actor.installation_id || l.workspace !== p.workspace_id)
        )
          throw new ChannelError('unauthorized')
        this.unwatch(String(p.subscription_id))
        return { removed: true }
      }
      default:
        throw new ChannelError('unsupported_method')
    }
  }
  stop() {
    this.stopped = true
    for (const id of this.leases.keys()) this.unwatch(id)
    this.directories.clear()
    this.cursors.clear()
  }
}
