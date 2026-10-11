import { createHash, randomUUID } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { ChannelError, type AuthorityContext } from '@abele/channel-protocol'
import {
  ProjectSchema,
  ExecutionTargetSchema,
  WorktreePageSchema,
  type ExecutionTarget,
  type Project,
} from '@abele/node-protocol'
import { canonical } from './index.js'
import type { ResourceServices } from './resources.js'
export interface ResolvedExecutionTarget {
  project_id: string
  target: ExecutionTarget
  path: string
  fingerprint: string
  canonical_key: string
  generation: string
}
interface SessionExecution extends ResolvedExecutionTarget {
  project: Project
  legacy?: boolean
}
const targetId = (target: ExecutionTarget) =>
  target.kind === 'workspace'
    ? 'workspace:' + target.workspace_id
    : 'worktree:' + target.worktree_id
const identity = (path: string) => {
  const s = lstatSync(path)
  if (!s.isDirectory() || s.isSymbolicLink() || realpathSync(path) !== path)
    throw new ChannelError('stale_resource')
  return createHash('sha256').update(`${s.dev}:${s.ino}`).digest('hex')
}
/** Target binding is separate from permission and never accepts a caller-supplied cwd. */
export class ExecutionTargetService {
  constructor(private r: ResourceServices) {
    r.core.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS execution_target_grants(project_id TEXT NOT NULL, target_id TEXT NOT NULL, body TEXT NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY(project_id,target_id));
      CREATE TABLE IF NOT EXISTS session_execution_targets(session_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_target_leases(canonical_key TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT NOT NULL, project_id TEXT NOT NULL, path TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS execution_target_reservations(canonical_key TEXT PRIMARY KEY, project_id TEXT NOT NULL, path TEXT NOT NULL, worktree_id TEXT NOT NULL, principal_id TEXT NOT NULL, operation_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS session_target_switches(session_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, body TEXT NOT NULL);
      COMMIT;`)
    // A preflight without a durable effect intent cannot have launched removal.
    // Interrupted effects remain reserved rather than admitting execution into an uncertain target.
    r.core.db
      .prepare(
        'DELETE FROM execution_target_reservations AS r WHERE NOT EXISTS (SELECT 1 FROM repository_deletions d WHERE d.principal_id=r.principal_id AND d.operation_id=r.operation_id)'
      )
      .run()
    // Fake-provider leases have no OS cleanup obligation. Real leases survive until reconcile proves cleanup.
    r.core.db
      .prepare(
        "DELETE FROM execution_target_leases WHERE session_id IN (SELECT session_id FROM sessions WHERE json_extract(body,'$.provider')='fake')"
      )
      .run()
  }
  bound(session: string): ResolvedExecutionTarget | undefined {
    const row = this.r.core.db
      .prepare('SELECT body FROM session_execution_targets WHERE session_id=?')
      .get(session) as { body: string } | undefined
    return row ? (JSON.parse(row.body) as ResolvedExecutionTarget) : undefined
  }
  private save(session: string, binding: ResolvedExecutionTarget) {
    this.r.core.db
      .prepare(
        'INSERT INTO session_execution_targets VALUES(?,?,?) ON CONFLICT(session_id) DO UPDATE SET project_id=excluded.project_id,body=excluded.body'
      )
      .run(session, binding.project_id, JSON.stringify(binding))
  }
  private syncIdentity(target: ExecutionTarget) {
    if (target.kind === 'worktree') return this.r.repository.executionIdentity(target.worktree_id)
    const w = this.r.workspaces.get(target.workspace_id),
      project = this.r.projects.get(w.project_id)
    if (w.kind !== 'root' || project.repository_path) throw new ChannelError('invalid_params')
    this.r.files.list(w.workspace_id, '', undefined, 1)
    return { project_id: project.project_id, path: w.path, fingerprint: identity(w.path) }
  }
  async resolve(target: ExecutionTarget): Promise<ResolvedExecutionTarget> {
    target = ExecutionTargetSchema.parse(target)
    const resolved =
      target.kind === 'worktree'
        ? await this.r.repository.executionTarget(target.worktree_id)
        : this.syncIdentity(target)
    const project = this.r.projects.get(resolved.project_id)
    await this.r.projects.available(project)
    return { ...resolved, target, canonical_key: identity(resolved.path), generation: randomUUID() }
  }
  check(binding: ResolvedExecutionTarget, approval = true) {
    const current = this.syncIdentity(binding.target),
      project = this.r.projects.get(binding.project_id)
    if (
      current.project_id !== binding.project_id ||
      current.path !== binding.path ||
      current.fingerprint !== binding.fingerprint ||
      identity(current.path) !== binding.canonical_key
    )
      throw new ChannelError('stale_resource')
    if (approval) {
      if (project.trust !== 'trusted') throw new ChannelError('project_untrusted')
      const grant = this.r.core.db
        .prepare(
          'SELECT body,enabled FROM execution_target_grants WHERE project_id=? AND target_id=?'
        )
        .get(binding.project_id, targetId(binding.target)) as
        { body: string; enabled: number } | undefined
      if (
        !grant?.enabled ||
        (JSON.parse(grant.body) as ResolvedExecutionTarget).fingerprint !== binding.fingerprint
      )
        throw new ChannelError('unauthorized')
    }
    return project
  }
  pathForSession(session: string) {
    const binding = this.bound(session)
    if (binding) return binding.path
    const current = this.r.core.session(session)
    return current.workspace_id ? this.r.workspaces.get(current.workspace_id).path : undefined
  }
  checkSession(session: string) {
    const binding = this.bound(session)
    if (binding) this.check(binding)
  }
  leasedPath(path: string) {
    return !!this.r.core.db.prepare('SELECT 1 FROM execution_target_leases WHERE path=?').get(path)
  }
  reserveDeletion(
    actor: AuthorityContext,
    project: string,
    path: string,
    worktree: string,
    operation: string
  ) {
    const key = identity(path)
    this.r.core.transaction(() => {
      this.r.core.authority.check(actor, 'mutate', worktree)
      if (!this.canLease({ path, canonical_key: key }, '') || this.leasedPath(path))
        throw new ChannelError('resource_busy')
      this.r.core.db
        .prepare('INSERT INTO execution_target_reservations VALUES(?,?,?,?,?,?)')
        .run(key, project, path, worktree, actor.installation_id, operation)
    })
    return () =>
      this.r.core.transaction(() =>
        this.r.core.db
          .prepare(
            'DELETE FROM execution_target_reservations WHERE canonical_key=? AND principal_id=? AND operation_id=?'
          )
          .run(key, actor.installation_id, operation)
      )
  }
  checkDeletionReservation(actor: AuthorityContext, path: string, operation: string) {
    const key = identity(path)
    const reserved = this.r.core.db
      .prepare(
        'SELECT 1 FROM execution_target_reservations WHERE canonical_key=? AND path=? AND principal_id=? AND operation_id=?'
      )
      .get(key, path, actor.installation_id, operation)
    if (!reserved || this.leasedPath(path)) throw new ChannelError('resource_busy')
  }
  projectBusy(project: string) {
    return (
      !!this.r.core.db
        .prepare('SELECT 1 FROM execution_target_reservations WHERE project_id=?')
        .get(project) ||
      !!this.r.core.db
        .prepare('SELECT 1 FROM execution_target_leases WHERE project_id=?')
        .get(project) ||
      !!this.r.core.db
        .prepare(
          "SELECT 1 FROM provider_runs r JOIN workspace_leases l ON l.session_id=r.session_id JOIN workspaces w ON w.workspace_id=l.workspace_id WHERE w.project_id=? AND r.state='active'"
        )
        .get(project)
    )
  }
  busy(session: string, queued = true) {
    return (
      !!this.r.core.db
        .prepare("SELECT 1 FROM provider_runs WHERE session_id=? AND state='active'")
        .get(session) ||
      !!this.r.core.db
        .prepare('SELECT 1 FROM execution_target_leases WHERE session_id=?')
        .get(session) ||
      (queued &&
        !!this.r.core.db
          .prepare(
            "SELECT 1 FROM inputs WHERE session_id=? AND state IN ('accepted','queued','dispatching','delivered')"
          )
          .get(session))
    )
  }
  canLease(binding: Pick<ResolvedExecutionTarget, 'path' | 'canonical_key'>, session: string) {
    return (
      !this.r.core.db
        .prepare('SELECT 1 FROM execution_target_reservations WHERE canonical_key=? OR path=?')
        .get(binding.canonical_key, binding.path) &&
      !this.r.core.db
        .prepare('SELECT 1 FROM execution_target_leases WHERE canonical_key=? AND session_id<>?')
        .get(binding.canonical_key, session) &&
      !this.r.core.db
        .prepare(
          "SELECT 1 FROM workspace_leases l JOIN workspaces w ON w.workspace_id=l.workspace_id WHERE json_extract(w.body,'$.path')=? AND l.session_id<>?"
        )
        .get(binding.path, session)
    )
  }
  lease(binding: ResolvedExecutionTarget, session: string, run: string) {
    if (!this.canLease(binding, session)) return false
    this.r.core.db
      .prepare('INSERT INTO execution_target_leases VALUES(?,?,?,?,?)')
      .run(binding.canonical_key, session, run, binding.project_id, binding.path)
    return true
  }
  async state(actor: AuthorityContext, session: string) {
    this.r.core.authority.check(actor, 'resource', session)
    const bound = this.bound(session)
    if (bound) return { project_id: bound.project_id, target: bound.target }
    const current = this.r.core.session(session)
    if (!current.workspace_id) throw new ChannelError('workspace_required')
    const w = this.r.workspaces.get(current.workspace_id)
    let cursor: string | undefined
    do {
      const page = WorktreePageSchema.parse(
        await this.r.repository.request(actor, 'repository.v1.worktrees', {
          project_id: w.project_id,
          limit: 256,
          ...(cursor ? { cursor } : {}),
        })
      )
      const entry = page.entries.find((e) => e.workspace_id === w.workspace_id)
      if (entry)
        return {
          project_id: w.project_id,
          target: { kind: 'worktree' as const, worktree_id: entry.worktree_id },
        }
      cursor = page.cursor ?? undefined
    } while (cursor)
    throw new ChannelError('stale_resource')
  }
  async runtime(session: string): Promise<SessionExecution> {
    const binding = this.bound(session)
    if (binding) {
      const resolved = await this.resolve(binding.target)
      if (
        resolved.fingerprint !== binding.fingerprint ||
        resolved.project_id !== binding.project_id
      )
        throw new ChannelError('stale_resource')
      return { ...binding, project: this.check(binding) }
    }
    const current = this.r.core.session(session)
    if (!current.workspace_id) throw new ChannelError('workspace_required')
    const w = this.r.workspaces.get(current.workspace_id),
      project = await this.r.workspaces.bound(w)
    return {
      project_id: project.project_id,
      target: { kind: 'workspace', workspace_id: w.workspace_id },
      path: w.path,
      fingerprint: identity(w.path),
      canonical_key: identity(w.path),
      generation: 'legacy',
      project,
      legacy: true,
    }
  }
  private continuation(session: string) {
    if (this.r.core.session(session).native_session_id)
      throw new ChannelError('provider_target_continuation_unsupported')
  }
  private changed(
    session: string,
    from: ExecutionTarget,
    destination: ResolvedExecutionTarget,
    by: 'owner' | 'agent',
    actor: import('@abele/channel-protocol').JournalEvent['actor']
  ) {
    this.save(session, { ...destination, generation: randomUUID() })
    const current = this.r.core.session(session)
    if (current.workspace_id) {
      const updated = { ...current, workspace_id: null }
      this.r.core.db.prepare('DELETE FROM workspace_leases WHERE session_id=?').run(session)
      this.r.core.db
        .prepare('UPDATE sessions SET body=? WHERE session_id=?')
        .run(JSON.stringify(updated), session)
      this.r.core.append(session, 'session.updated', actor, updated)
      this.r.core.append('catalog', 'session.updated', actor, updated)
    }
    const event = {
      session_id: session,
      project_id: destination.project_id,
      from,
      to: destination.target,
      by,
    }
    this.r.core.append(session, 'session.worktree.changed', actor, event)
    this.r.core.append('catalog', 'session.worktree.changed', actor, event)
  }
  checkScheduled(session: string, run: string) {
    const row = this.r.core.db
      .prepare('SELECT body FROM session_target_switches WHERE session_id=? AND run_id=?')
      .get(session, run) as { body: string } | undefined
    if (!row) throw new ChannelError('stale_run')
    this.check((JSON.parse(row.body) as { destination: ResolvedExecutionTarget }).destination)
  }
  /** Called only once cleanup is confirmed, inside the same state transaction as run settlement. */
  settle(session: string, run: string) {
    this.r.core.db
      .prepare('DELETE FROM execution_target_leases WHERE session_id=? AND run_id=?')
      .run(session, run)
    const row = this.r.core.db
      .prepare('SELECT body FROM session_target_switches WHERE session_id=? AND run_id=?')
      .get(session, run) as { body: string } | undefined
    if (!row) return
    const pending = JSON.parse(row.body) as {
      from: ExecutionTarget
      generation: string
      destination: ResolvedExecutionTarget
    }
    this.r.core.db.prepare('DELETE FROM session_target_switches WHERE session_id=?').run(session)
    try {
      const binding = this.bound(session)
      if (
        !binding ||
        binding.generation !== pending.generation ||
        canonical(binding.target) !== canonical(pending.from)
      )
        throw new ChannelError('stale_revision')
      this.check(pending.destination)
      if (
        canonical(binding.target) === canonical(pending.destination.target) &&
        binding.fingerprint === pending.destination.fingerprint
      )
        return
      this.continuation(session)
      this.changed(session, pending.from, pending.destination, 'agent', {
        kind: 'provider',
        provider: this.r.core.session(session).provider,
        session_id: session,
      })
    } catch (e) {
      this.r.core.append(
        session,
        'session.worktree.switch.failed',
        { kind: 'node' },
        {
          target: pending.destination.target,
          code: e instanceof ChannelError ? e.code : 'stale_resource',
        }
      )
    }
  }
  async schedule(
    actor: AuthorityContext,
    session: string,
    run: string,
    generation: string,
    target: ExecutionTarget,
    active: () => boolean
  ) {
    if (!active()) throw new ChannelError('stale_run')
    const binding = this.bound(session)
    if (!binding || binding.generation !== generation) throw new ChannelError('stale_run')
    const destination = await this.resolve(target)
    if (
      canonical(binding.target) !== canonical(destination.target) ||
      binding.fingerprint !== destination.fingerprint
    )
      this.continuation(session)
    if (!active()) throw new ChannelError('stale_run')
    if (destination.project_id !== binding.project_id) throw new ChannelError('unauthorized')
    this.check(destination)
    this.r.core.authority.check(actor, 'execute', session)
    return this.r.core.transaction(() => {
      if (!active() || this.bound(session)?.generation !== generation)
        throw new ChannelError('stale_run')
      const existing = this.r.core.db
        .prepare('SELECT run_id,body FROM session_target_switches WHERE session_id=?')
        .get(session) as { run_id: string; body: string } | undefined
      if (
        existing &&
        (existing.run_id !== run ||
          canonical(
            (JSON.parse(existing.body) as { destination: ResolvedExecutionTarget }).destination
              .target
          ) !== canonical(target))
      )
        throw new ChannelError('resource_busy')
      if (!existing)
        this.r.core.db
          .prepare('INSERT INTO session_target_switches VALUES(?,?,?)')
          .run(session, run, JSON.stringify({ from: binding.target, generation, destination }))
      return { state: 'pending', target }
    })
  }
  detach(session: string) {
    if (this.busy(session)) throw new ChannelError('resource_busy')
    this.r.core.db.prepare('DELETE FROM session_execution_targets WHERE session_id=?').run(session)
    this.r.core.db.prepare('DELETE FROM session_target_switches WHERE session_id=?').run(session)
  }
  async request(
    actor: AuthorityContext,
    method: string,
    p: Record<string, unknown>,
    operation?: string
  ): Promise<unknown> {
    const core = this.r.core
    if (method === 'session.worktree.get') return this.state(actor, String(p.session_id))
    const previous = core.operationReceipt(actor, method, p, operation)
    if (previous) return previous.result
    if (method === 'session.create') {
      const binding = await this.resolve(p.target as ExecutionTarget)
      this.check(binding)
      return core.commitOperation(actor, method, p, operation, () => {
        this.check(binding)
        const session = core.acceptSession(actor, p, false, binding)
        this.save(session.session_id, binding)
        return session
      })
    }
    if (method === 'project.trust')
      return core.commitOperation(actor, method, p, operation, () => {
        const project = this.r.projects.get(String(p.project_id))
        if (this.projectBusy(project.project_id)) throw new ChannelError('resource_busy')
        const updated = ProjectSchema.parse({
          ...project,
          trust: p.trust,
          ...(p.trust === 'untrusted' ? { use_repository_claude_permissions: false } : {}),
        })
        core.db
          .prepare('UPDATE projects SET body=? WHERE project_id=?')
          .run(JSON.stringify(updated), project.project_id)
        if (p.trust === 'untrusted')
          core.db
            .prepare('UPDATE execution_target_grants SET enabled=0 WHERE project_id=?')
            .run(project.project_id)
        core.append(
          'catalog',
          'project.registered',
          { kind: 'installation', installation_id: actor.installation_id },
          updated
        )
        return updated
      })
    if (method === 'project.execution') {
      const project = this.r.projects.get(String(p.project_id)),
        target = p.target as ExecutionTarget
      const old = core.db
        .prepare('SELECT body FROM execution_target_grants WHERE project_id=? AND target_id=?')
        .get(project.project_id, targetId(target)) as { body: string } | undefined
      const binding =
        !p.enabled && old
          ? (JSON.parse(old.body) as ResolvedExecutionTarget)
          : await this.resolve(target)
      if (binding.project_id !== project.project_id) throw new ChannelError('unauthorized')
      return core.commitOperation(actor, method, p, operation, () => {
        if (this.leasedPath(binding.path)) throw new ChannelError('resource_busy')
        if (p.enabled) {
          this.check(binding, false)
          if (this.r.projects.get(project.project_id).trust !== 'trusted')
            throw new ChannelError('project_untrusted')
        }
        core.db
          .prepare(
            'INSERT INTO execution_target_grants VALUES(?,?,?,?) ON CONFLICT(project_id,target_id) DO UPDATE SET body=excluded.body,enabled=excluded.enabled'
          )
          .run(project.project_id, targetId(target), JSON.stringify(binding), p.enabled ? 1 : 0)
        const result = { project_id: project.project_id, target, enabled: Boolean(p.enabled) }
        core.append(
          'catalog',
          'project.execution.changed',
          { kind: 'installation', installation_id: actor.installation_id },
          result
        )
        return result
      })
    }
    if (method === 'session.worktree.set') {
      const session = String(p.session_id)
      if (this.busy(session)) throw new ChannelError('resource_busy')
      const from = await this.state(actor, session)
      if (canonical(from.target) !== canonical(p.expected_target))
        throw new ChannelError('stale_revision')
      const destination = await this.resolve(p.target as ExecutionTarget)
      if (destination.project_id !== from.project_id) throw new ChannelError('unauthorized')
      const initialBinding = this.bound(session)
      if (
        canonical(from.target) !== canonical(destination.target) ||
        (initialBinding && initialBinding.fingerprint !== destination.fingerprint)
      )
        this.continuation(session)
      this.check(destination)
      return core.commitOperation(actor, method, p, operation, () => {
        if (this.busy(session)) throw new ChannelError('resource_busy')
        const current = this.bound(session)
        if (current && canonical(current.target) !== canonical(p.expected_target))
          throw new ChannelError('stale_revision')
        this.check(destination)
        if (
          canonical(from.target) !== canonical(destination.target) ||
          (current && current.fingerprint !== destination.fingerprint)
        ) {
          this.continuation(session)
          this.changed(session, from.target, destination, 'owner', {
            kind: 'installation',
            installation_id: actor.installation_id,
          })
        }
        return { session_id: session, target: destination.target }
      })
    }
    throw new ChannelError('unsupported_method')
  }
}
