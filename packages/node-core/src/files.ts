import { createHash, randomUUID } from 'node:crypto'
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  realpathSync,
  readSync,
  readdirSync,
} from 'node:fs'
import { join, sep } from 'node:path'
import { ChannelError, type AuthorityContext } from '@abele/channel-protocol'
import {
  RelativePathSchema,
  DiffSnapshotSchema,
  FileContentSchema,
  ReviewBatchSchema,
  selectedContext,
  type DiffSnapshot,
  type ReviewBatch,
} from '@abele/node-protocol'
import type { ResourceServices } from './resources.js'
import { decodeGit } from './git.js'
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const maxContent = 16 * 1024 * 1024
const same = (
  a: NonNullable<ReturnType<typeof lstatSync>>,
  b: NonNullable<ReturnType<typeof lstatSync>>
) => a.dev === b.dev && a.ino === b.ino

/** Symlinks are metadata only, including links within the workspace. */
export class WorkspaceFileService {
  beforeOpen?: () => void
  constructor(private r: ResourceServices) {}
  private root(id: string, repository = false) {
    if (repository) return this.r.repository.fileRoot(id)
    const w = this.r.workspaces.get(id)
    this.r.projects.get(w.project_id)
    if (w.state !== 'ready') throw new ChannelError('resource_busy')
    try {
      if (realpathSync(w.path) !== w.path || lstatSync(w.path).isSymbolicLink()) throw new Error()
    } catch {
      throw new ChannelError('unsafe_path')
    }
    return w.path
  }
  private checked(root: string, path: string, allowLink = false) {
    if (!RelativePathSchema.safeParse(path).success) throw new ChannelError('unsafe_path')
    // Protocol separators are '/'; a backslash is a native filename byte on POSIX, not traversal.
    // A non-POSIX adapter must not interpret that byte as an alternative separator.
    if (sep !== '/' && path.includes(sep)) throw new ChannelError('unsupported_name')
    let target = root
    try {
      const parts = path ? path.split('/') : []
      for (let i = 0; i < parts.length; i++) {
        target = join(target, parts[i]!)
        const s = lstatSync(target)
        if (s.isSymbolicLink() && !(allowLink && i === parts.length - 1))
          throw new ChannelError('unsafe_path')
        if (i < parts.length - 1 && !s.isDirectory()) throw new ChannelError('unsafe_path')
      }
      return target
    } catch (e) {
      if (e instanceof ChannelError) throw e
      throw new ChannelError('not_found')
    }
  }
  writeTarget(id: string, path: string, create = false, repository = false) {
    const root = this.root(id, repository)
    if (create) {
      if (!path || !RelativePathSchema.safeParse(path).success)
        throw new ChannelError('unsafe_path')
      const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''
      const directory = this.checked(root, parent)
      if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory)
        throw new ChannelError('unsafe_path')
      const target = join(directory, path.split('/').at(-1)!)
      try {
        lstatSync(target)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return target
        throw new ChannelError('unsafe_path')
      }
    }
    const target = this.checked(root, path)
    if (!lstatSync(target).isFile() || realpathSync(target) !== target)
      throw new ChannelError('unsafe_path')
    return target
  }
  stat(id: string, path: string) {
    const root = this.root(id),
      target = this.checked(root, path, true),
      s = lstatSync(target)
    return {
      name: path.split('/').at(-1)!,
      path,
      kind: s.isSymbolicLink()
        ? 'symlink'
        : s.isDirectory()
          ? 'directory'
          : s.isFile()
            ? 'file'
            : 'other',
      size: s.size,
    }
  }
  list(id: string, path: string, after: string | undefined, limit: number) {
    const root = this.root(id),
      target = this.checked(root, path)
    const before = lstatSync(target)
    if (!before.isDirectory()) throw new ChannelError('unsafe_path')
    const names = readdirSync(target, { encoding: 'buffer' })
      .map((b) => decodeGit(b))
      .sort()
      .filter((n) => after === undefined || n > after)
    const entries = []
    let size = 0
    for (const name of names.slice(0, limit)) {
      const entry = this.stat(id, path ? path + '/' + name : name)
      size += Buffer.byteLength(JSON.stringify(entry))
      if (size > 128 * 1024) break
      entries.push(entry)
    }
    if (realpathSync(target) !== target || !same(before, lstatSync(target)))
      throw new ChannelError('unsafe_path')
    return { entries, next: entries.length < names.length ? (entries.at(-1)?.name ?? null) : null }
  }
  read(id: string, path: string, repository = false) {
    const root = this.root(id, repository),
      target = this.checked(root, path),
      before = lstatSync(target)
    if (!before.isFile()) throw new ChannelError('unsafe_path')
    let fd: number | undefined
    try {
      this.beforeOpen?.()
      fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      const s = fstatSync(fd)
      const resolved = this.checked(root, path)
      const canonical = realpathSync(resolved)
      const fresh = lstatSync(canonical)
      // Recheck the current resolved path against the actual opened inode before reading.
      // This detects observed replacements, not fully interleaved same-user filesystem races.
      if (
        !s.isFile() ||
        !same(before, s) ||
        resolved !== target ||
        canonical !== target ||
        !fresh.isFile() ||
        !same(s, fresh)
      )
        throw new ChannelError('unsafe_path')
      if (s.size > maxContent)
        return FileContentSchema.parse({
          workspace_id: id,
          path,
          content_id: null,
          size: s.size,
          binary: false,
          large: true,
          too_large: true,
        })
      const bytes = Buffer.alloc(s.size)
      let count = 0
      while (count < bytes.length) {
        const n = readSync(fd, bytes, count, bytes.length - count, count)
        if (!n) break
        count += n
      }
      const end = fstatSync(fd)
      if (
        count !== s.size ||
        s.size !== end.size ||
        s.mtimeMs !== end.mtimeMs ||
        s.ctimeMs !== end.ctimeMs ||
        this.checked(root, path) !== target ||
        realpathSync(target) !== target ||
        !same(end, lstatSync(target))
      )
        throw new ChannelError('stale_revision')
      return this.retain(id, path, bytes, repository)
    } catch (e) {
      if (e instanceof ChannelError) throw e
      throw new ChannelError('unsafe_path')
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
  retain(id: string, path: string, bytes: Uint8Array, repository = false) {
    let binary = bytes.includes(0)
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      binary = true
    }
    const content_id = hash(bytes)
    if (repository) this.r.repository.retainEdited(id, bytes)
    else
      this.r.core.transaction(() =>
        this.r.core.db
          .prepare('INSERT OR IGNORE INTO workspace_contents VALUES(?,?,?)')
          .run(id, content_id, bytes)
      )
    return FileContentSchema.parse({
      workspace_id: id,
      path,
      content_id,
      size: bytes.length,
      binary,
      large: bytes.length > 256 * 1024,
      too_large: false,
    })
  }
  bytes(id: string, content: string, repository = false): Buffer {
    if (repository) return this.r.repository.editedBytes(id, content)
    const row = this.r.core.db
      .prepare('SELECT content FROM workspace_contents WHERE workspace_id=? AND content_id=?')
      .get(id, content) as { content: Uint8Array } | undefined
    if (!row) throw new ChannelError('not_found')
    return Buffer.from(row.content)
  }
  content(id: string, content: string, offset: number, length: number) {
    const bytes = this.bytes(id, content)
    return {
      offset,
      total: bytes.length,
      base64: bytes.subarray(offset, offset + length).toString('base64'),
    }
  }
}
export class DiffSnapshotStore {
  constructor(private r: ResourceServices) {}
  get(id: string, diff: string): DiffSnapshot {
    const row = this.r.core.db
      .prepare('SELECT body FROM diff_snapshots WHERE workspace_id=? AND diff_id=?')
      .get(id, diff) as { body: string } | undefined
    if (!row) throw new ChannelError('not_found')
    return DiffSnapshotSchema.parse(JSON.parse(row.body))
  }
  put(snapshot: DiffSnapshot) {
    this.r.core.transaction(() =>
      this.r.core.db
        .prepare('INSERT INTO diff_snapshots VALUES(?,?,?)')
        .run(snapshot.diff_id, snapshot.workspace_id, JSON.stringify(snapshot))
    )
    return snapshot
  }
}
export class GitViewService {
  constructor(private r: ResourceServices) {}
  private async workspace(id: string) {
    const w = this.r.workspaces.get(id),
      p = await this.r.workspaces.bound(w)
    if (!p.repository_path) throw new ChannelError('git_required')
    return w
  }
  async capture(id: string, mode: DiffSnapshot['mode'], commit?: string) {
    const w = await this.workspace(id)
    const head = await this.r.git.text(w.path, { kind: 'resolve', ref: 'HEAD' })
    const merge_base =
      mode === 'base'
        ? await this.r.git.text(w.path, { kind: 'merge-base', head, base: w.base_commit ?? head })
        : null
    const bytes = await this.r.git.run(w.path, {
      kind: 'view.diff',
      mode,
      head,
      ...(merge_base ? { base: merge_base } : {}),
      ...(commit ? { commit } : {}),
    })
    // Store exactly the patch produced by Git; reopening never consults mutable files.
    decodeGit(bytes)
    const content = this.r.files.retain(id, 'diff.patch', bytes)
    return this.r.snapshots.put(
      DiffSnapshotSchema.parse({
        diff_id: randomUUID(),
        workspace_id: id,
        mode,
        head_commit: head,
        base_commit: w.base_commit,
        merge_base,
        commit: commit ?? null,
        content_id: content.content_id,
        size: bytes.length,
        created_at: new Date().toISOString(),
      })
    )
  }
  async log(id: string, offset: number, limit: number) {
    const w = await this.workspace(id)
    const head = await this.r.git.text(w.path, { kind: 'resolve', ref: 'HEAD' })
    const result = []
    let bytes = 2
    for (let i = 0; i < limit; i++) {
      let parts: string[]
      try {
        // One bounded record at a time: an oversized later subject cannot discard a fitting prefix.
        // Pin HEAD for this page so a concurrent commit does not shift offsets between reads.
        parts = decodeGit(
          await this.r.git.run(w.path, { kind: 'log', head, offset: offset + i, limit: 1 })
        ).split('\0')
      } catch (error) {
        if (result.length && error instanceof ChannelError && error.code === 'output_limit') break
        throw error
      }
      if (!parts[0]?.trim()) break
      if (parts.length < 3) throw new ChannelError('git_failed')
      const row = { commit: parts[0].trim(), subject: parts[1]! }
      const size = Buffer.byteLength(JSON.stringify(row)) + 1
      if (bytes + size > 128 * 1024) {
        if (!result.length) throw new ChannelError('output_limit')
        break
      }
      result.push(row)
      bytes += size
    }
    // Leave envelope headroom. Consumers advance offset by returned row count, never requested limit.
    return result
  }
  async show(id: string, commit: string, path: string) {
    const w = await this.workspace(id)
    return this.r.files.retain(
      id,
      path,
      await this.r.git.run(w.path, { kind: 'show', commit, path })
    )
  }
}
export class ReviewBatchService {
  constructor(private r: ResourceServices) {}
  async submit(actor: AuthorityContext, raw: ReviewBatch, operation?: string) {
    const batch = ReviewBatchSchema.parse(raw),
      core = this.r.core
    const previous = core.operationReceipt(actor, 'review.submit', batch, operation)
    if (previous) return previous.result
    const session = core.session(batch.session_id)
    const stale: boolean[] = [],
      contexts: string[] = []
    for (const anchor of batch.anchors) {
      if (anchor.node_id !== core.node_id || anchor.workspace_id !== session.workspace_id)
        throw new ChannelError('invalid_anchor')
      const snap = this.r.snapshots.get(anchor.workspace_id, anchor.diff_id)
      const patch = decodeGit(this.r.files.bytes(anchor.workspace_id, snap.content_id))
      let context: string
      try {
        context = selectedContext(patch, anchor)
      } catch {
        throw new ChannelError('invalid_anchor')
      }
      if (hash(context) !== anchor.context_hash) throw new ChannelError('invalid_anchor')
      contexts.push(context)
      try {
        const current = await this.r.views.capture(
          anchor.workspace_id,
          snap.mode,
          snap.commit ?? undefined
        )
        stale.push(
          current.content_id !== snap.content_id ||
            current.head_commit !== snap.head_commit ||
            current.merge_base !== snap.merge_base
        )
      } catch (error) {
        // Freshness is advisory: valid saved context remains sendable if Git cannot re-capture it.
        // Authority and durable-storage failures still fail closed; commitOperation rechecks both.
        if (
          error instanceof ChannelError &&
          ['unauthorized', 'storage_unavailable'].includes(error.code)
        )
          throw error
        stale.push(true)
      }
    }
    const text =
      'Review batch (immutable snapshots; stale means the workspace changed):\n' +
      batch.anchors
        .map((a, i) => JSON.stringify({ ...a, stale: stale[i], selected_context: contexts[i] }))
        .join('\n')
    if (Buffer.byteLength(text) > 32768) throw new ChannelError('output_limit')
    return core.commitOperation(actor, 'review.submit', batch, operation, () => {
      if (core.session(batch.session_id).workspace_id !== session.workspace_id)
        throw new ChannelError('invalid_anchor')
      const result = core.acceptInput(actor, {
        session_id: batch.session_id,
        observed_seq: batch.observed_seq,
        text,
        script: [{ kind: 'echo' }],
      }) as { input_id: string; accepted_seq: number }
      core.append(
        batch.session_id,
        'review.submitted',
        { kind: 'installation', installation_id: actor.installation_id },
        { ...batch, stale, input_id: result.input_id }
      )
      return { ...result, stale }
    })
  }
}
