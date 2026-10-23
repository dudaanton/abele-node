import { ChannelError, type AuthorityContext } from '@abele/channel-protocol'
import { randomUUID } from 'node:crypto'
import { relative, isAbsolute, extname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { decodeGit } from '../git.js'
import { LspMethodSchemas } from '@abele/node-protocol'
import type { ResourceServices } from '../resources.js'
import { LspService } from './service.js'
import { install, status, servers } from './servers.js'

export class NodeLsp {
  async releaseRoot(root: string) {
    this.roots.delete(root)
    await this.service.releaseRoot(root)
  }
  readonly service: LspService
  private roots = new Map<string, { id: string; repository: boolean; project: string }>()
  private requests = new Map<string, AbortController>()
  private connections = new Map<AbortSignal, { owner: string; release: () => void }>()
  private stopped = false
  private edited = new Map<string, Set<string>>()
  private refreshes = new Set<Promise<void>>()
  constructor(private r: ResourceServices) {
    this.service = new LspService(r.core.stateDir, {
      idleMs: Number(process.env.ABELE_LSP_IDLE_MS) || 30 * 60 * 1000,
      memoryMB: Number(process.env.ABELE_LSP_MEMORY_MB) || undefined,
      trusted: (root) => this.trusted(root),
      read: (root, path) => {
        const ref = this.roots.get(root)
        if (!ref) throw new ChannelError('unsafe_path')
        const content = r.files.read(ref.id, path, ref.repository)
        if (content.binary || content.too_large || !content.content_id || content.size > 512 * 1024)
          throw new ChannelError('output_limit')
        return r.files.bytes(ref.id, content.content_id, ref.repository).toString('utf8')
      },
      check: (root, path) => {
        const ref = this.roots.get(root)
        if (!ref || r.files.readRoot(ref.id, ref.repository) !== root)
          throw new ChannelError('unsafe_path')
        return r.files.readTarget(ref.id, path, ref.repository)
      },
      diagnostics: (root, path, diagnostics) => {
        if (this.stopped) return
        const ref = this.roots.get(root)
        if (!ref) return
        r.core.transaction(() => {
          r.core.append(
            'catalog',
            'lsp.diagnostics',
            { kind: 'node' },
            {
              ...(ref.repository ? { worktree_id: ref.id } : { workspace_id: ref.id }),
              path,
              diagnostics,
            }
          )
        })
      },
      error: (root, message) => {
        console.warn('[Abele LSP]', { root, message })
        const ref = this.roots.get(root)
        if (!this.stopped)
          r.core.transaction(() =>
            r.core.append(
              'catalog',
              'lsp.status',
              { kind: 'node' },
              {
                ...(ref
                  ? ref.repository
                    ? { worktree_id: ref.id }
                    : { workspace_id: ref.id }
                  : {}),
                message,
              }
            )
          )
      },
    })
  }
  root(id: string, repository = false) {
    const root = this.r.files.readRoot(id, repository)
    const project = repository
      ? this.r.repository.executionIdentity(id).project_id
      : this.r.workspaces.get(id).project_id
    this.roots.set(root, { id, repository, project })
    return root
  }
  private trusted(root: string) {
    try {
      const ref = this.roots.get(root)
      return (
        !!ref &&
        this.r.files.readRoot(ref.id, ref.repository) === root &&
        this.r.projects.get(ref.project).trust === 'trusted'
      )
    } catch {
      return false
    }
  }
  async enforceTrust(project: string) {
    await Promise.all(
      [...this.roots.entries()]
        .filter(([, ref]) => ref.project === project)
        .map(([root]) => this.service.enforceTrust(root))
    )
  }
  sessionRoot(session: string) {
    const binding = this.r.targets.bound(session)
    if (binding)
      return binding.target.kind === 'worktree'
        ? this.root(binding.target.worktree_id, true)
        : this.root(binding.target.workspace_id)
    const id = this.r.core.session(session).workspace_id
    if (!id) throw new ChannelError('workspace_required')
    return this.root(id)
  }
  async request(actor: AuthorityContext, method: string, raw: unknown, signal?: AbortSignal) {
    this.r.core.authority.check(actor, 'resource')
    const schema = LspMethodSchemas[method as keyof typeof LspMethodSchemas]
    if (!schema) throw new ChannelError('unsupported_method')
    const parsed = schema.safeParse(raw)
    if (!parsed.success) throw new ChannelError('invalid_params')
    const p = parsed.data as Record<string, any>
    const owner = this.connectionOwner(actor, signal)
    const key = owner + ':' + p.request_id
    if (method === 'lsp.v1.cancel') {
      this.requests.get(key)?.abort()
      return { cancelled: true }
    }
    if (this.requests.has(key) && p.request_id) throw new ChannelError('resource_busy')
    if (this.requests.size >= 128) throw new ChannelError('resource_busy')
    const controller = new AbortController()
    if (p.request_id) this.requests.set(key, controller)
    try {
      return await this.dispatch(
        actor,
        method,
        p,
        signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        owner
      )
    } catch (error) {
      if (error instanceof ChannelError) throw error
      const detail = error instanceof Error ? error.message : 'unknown failure'
      const candidate = detail.split(':')[0]!
      const reason = /^(lsp_[a-z_]+|cancelled|untrusted_folder|unsafe_path|stale_revision)$/.test(
        candidate
      )
        ? candidate
        : 'lsp_failed'
      const code =
        reason.startsWith('lsp_') && reason !== 'lsp_timeout' ? 'lsp_unavailable' : reason
      console.warn('[Abele LSP] request unavailable', {
        method,
        reason,
        detail: detail.slice(0, 512),
      })
      throw new ChannelError(
        code,
        code === 'lsp_unavailable'
          ? 'Language analysis is unavailable. Retry after checking the language server.'
          : code,
        { reason }
      )
    } finally {
      if (p.request_id) this.requests.delete(key)
    }
  }
  private connectionOwner(actor: AuthorityContext, signal?: AbortSignal) {
    // Direct in-process callers have no channel lifetime; transport callers always pass it.
    if (!signal) return actor.installation_id
    if (signal.aborted) throw new ChannelError('cancelled')
    const existing = this.connections.get(signal)
    if (existing) return existing.owner
    const owner = randomUUID()
    const release = () => {
      this.connections.delete(signal)
      this.service.releaseOwner(owner)
    }
    this.connections.set(signal, { owner, release })
    signal.addEventListener('abort', release, { once: true })
    return owner
  }
  private async dispatch(
    actor: AuthorityContext,
    method: string,
    p: Record<string, any>,
    signal: AbortSignal,
    owner: string
  ) {
    if (method === 'lsp.v1.install') {
      this.r.core.authority.check(actor, 'mutate')
      return install(this.r.core.stateDir, p.languages, signal)
    }
    if (p.workspace_id && p.worktree_id) throw new ChannelError('invalid_params')
    const root = p.workspace_id
      ? this.root(p.workspace_id)
      : p.worktree_id
        ? this.root(p.worktree_id, true)
        : undefined
    if (method === 'lsp.v1.status') {
      const rows = await status(this.r.core.stateDir, root, !!root && this.trusted(root))
      return rows.map((row) => {
        const failure = root && !row.reason && this.service.failureMessage(root, row.language)
        return failure
          ? {
              ...row,
              diagnostic: [row.diagnostic, 'Last language analysis request failed: ' + failure]
                .filter(Boolean)
                .join('; '),
            }
          : row
      })
    }
    if (!root) throw new ChannelError('workspace_required')
    this.r.core.authority.check(actor, 'resource', String(p.workspace_id ?? p.worktree_id))
    if (method === 'lsp.v1.open')
      return this.service.open(root, p.path, p.text, p.version, signal, owner)
    if (method === 'lsp.v1.close') return this.service.closeDocument(root, p.path, owner)
    return this.service.query(
      root,
      p.path,
      method.slice('lsp.v1.'.length),
      p.position,
      signal,
      owner
    )
  }
  observe(session: string, type: string, data: any) {
    if (this.stopped) return
    const u = type === 'session.update' ? data?.update : null
    const raw = data?.input ?? data?.arguments
    const name = String(data?.name ?? '').toLowerCase()
    const paths =
      data?.tool === 'fileChange' && Array.isArray(data.changes)
        ? data.changes.map((c: any) => c.path)
        : u?.tool_kind === 'edit'
          ? (u.locations?.map((l: any) => l.path) ?? [])
          : raw && /edit|write|patch/.test(name)
            ? [raw.file_path ?? raw.path]
            : []
    if (paths.length) {
      const set = this.edited.get(session) ?? new Set<string>()
      for (const path of paths) if (typeof path === 'string' && set.size < 64) set.add(path)
      this.edited.set(session, set)
    }
  }
  afterEdit(session: string) {
    const job = this.refreshAfterEdit(session)
    this.refreshes.add(job)
    void job.then(
      () => this.refreshes.delete(job),
      () => this.refreshes.delete(job)
    )
    return job
  }
  private async refreshAfterEdit(session: string) {
    if (this.stopped) return
    try {
      const root = this.sessionRoot(session)
      // No consumer: avoid a Git subprocess and its deadline on every chat turn.
      // Discover again next turn so installing a server takes effect immediately.
      if (!this.service.canRefresh(root)) {
        this.edited.delete(session)
        return
      }
      const paths = new Set(this.edited.get(session) ?? [])
      if (existsSync(join(root, '.git'))) {
        try {
          const fields = decodeGit(await this.r.git.run(root, { kind: 'status' }))
            .split('\0')
            .filter(Boolean)
          for (let i = 0; i < fields.length && paths.size < 64; i++) {
            const field = fields[i]!
            const path = field.slice(3)
            const extension = extname(path).slice(1)
            if (
              Object.values(servers).some((s) =>
                (s.extensions as readonly string[]).includes(extension)
              )
            )
              paths.add(path)
            if (/[RC]/.test(field.slice(0, 2))) i++
          }
        } catch {
          /* Explicit tool locations and opened files still work without Git. */
        }
      }
      if (this.stopped || this.sessionRoot(session) !== root) return
      this.edited.delete(session)
      const opened = new Set<string>()
      for (const raw of paths) {
        const path = isAbsolute(raw) ? relative(root, raw) : raw
        try {
          await this.service.open(root, path, undefined, undefined, undefined, null)
          opened.add(path)
        } catch {
          /* not a supported confined file */
        }
      }
      await this.service.refresh(root, opened)
    } catch {
      /* unavailable root */
    }
  }
  stop() {
    this.stopped = true
    for (const [signal, { release }] of this.connections)
      signal.removeEventListener('abort', release)
    this.connections.clear()
    for (const c of this.requests.values()) c.abort()
    this.requests.clear()
    return Promise.all([this.service.stop(), ...this.refreshes]).then(() => {})
  }
}
