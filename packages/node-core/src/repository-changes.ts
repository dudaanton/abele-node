import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RepositoryTreeChange } from '@abele/node-protocol'

export interface ChangeEntry {
  path: string
  name: string
  kind: 'file' | 'directory' | 'symlink' | 'submodule'
  oid: string | null
  size: number | null
}
export interface ChangeStatus {
  index: string
  worktree: string
  path: string
  original_path?: string
}
/** One observed working tree, reduced to what a client's tree and decorations show. */
export interface ChangeBaseline {
  entries: Map<string, { entry: ChangeEntry; identity: string | null; signature: string }>
  status: Map<string, ChangeStatus>
  head: string | null
  branch: string | null
  detached: boolean
}
export interface ChangeDiff {
  entries: RepositoryTreeChange[]
  git: {
    head: string | null
    branch: string | null
    detached: boolean
    status: { path: string; entry: ChangeStatus | null }[]
  } | null
}

/** Reduces a working snapshot; HEAD's branch is read from the worktree's own git directory. */
export function baselineOf(
  snapshot: {
    byPath: Map<string, ChangeEntry>
    stamps: Map<string, string | null>
    status: ChangeStatus[]
    head: string | null
  },
  gitdir: string
): ChangeBaseline {
  const entries: ChangeBaseline['entries'] = new Map()
  for (const [path, entry] of snapshot.byPath) {
    const stamp = snapshot.stamps.get(path) ?? null
    entries.set(path, {
      entry: { path, name: entry.name, kind: entry.kind, oid: entry.oid, size: entry.size },
      identity: stamp ? stamp.split(':').slice(0, 2).join(':') : null,
      // A folder's own timestamps move with every child; only its children describe it.
      signature: entry.kind === 'directory' ? 'directory' : JSON.stringify([entry, stamp]),
    })
  }
  const status = new Map<string, ChangeStatus>()
  for (const row of snapshot.status)
    status.set(row.path, {
      index: row.index,
      worktree: row.worktree,
      path: row.path,
      ...(row.original_path === undefined ? {} : { original_path: row.original_path }),
    })
  let branch: string | null = null,
    detached = false
  try {
    const value = readFileSync(join(gitdir, 'HEAD'), 'utf8').trim()
    if (value.startsWith('ref: ')) branch = value.slice(5)
    else detached = true
  } catch {
    /* An unreadable HEAD reads as no branch; the next observation corrects it. */
  }
  return { entries, status, head: snapshot.head, branch, detached }
}

const parentOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '')
const depth = (path: string) => path.split('/').length
const byDepth = (a: string, b: string) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0)
const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Describes `after` as edits to `before`, in the order a client applies them: renames (an
 * unchanged inode under a new name, folders first, each `from` naming where the client has the
 * row by then), then removals, additions and edits. A removed or added folder stands for
 * everything under it. Returns null when the description would exceed `limit` rows, which
 * the caller turns into an explicit request to reread.
 */
export function diffBaselines(
  before: ChangeBaseline,
  after: ChangeBaseline,
  limit: number
): ChangeDiff | null {
  type Row = ChangeBaseline['entries'] extends Map<string, infer R> ? R : never
  const current = new Map<string, Row>(before.entries)
  const located = new Map<string, string>()
  for (const [path, row] of current)
    if (row.identity && !after.entries.has(path)) located.set(row.entry.kind + row.identity, path)
  const entries: RepositoryTreeChange[] = []
  const renamed: RepositoryTreeChange[] = []
  for (const path of [...after.entries.keys()].sort(byDepth)) {
    if (current.has(path)) continue
    const row = after.entries.get(path)!
    const key = row.identity ? row.entry.kind + row.identity : null
    const from = key ? located.get(key) : undefined
    if (!from || !current.has(from) || after.entries.has(from)) continue
    const parent = parentOf(path)
    if (parent && !current.has(parent)) continue
    if (current.get(from)!.entry.kind !== row.entry.kind) continue
    // Move the row and, for a folder, everything the client holds under it.
    for (const [old, moved] of [...current]) {
      if (old !== from && !old.startsWith(from + '/')) continue
      current.delete(old)
      const next = path + old.slice(from.length)
      const entry = { ...moved.entry, path: next, name: next.split('/').at(-1)! }
      current.set(next, old === from ? row : { ...moved, entry })
      if (moved.identity) located.set(moved.entry.kind + moved.identity, next)
    }
    renamed.push({ change: 'renamed', from, entry: row.entry })
  }
  entries.push(...renamed)
  for (const path of [...current.keys()].sort(byPath)) {
    if (after.entries.has(path)) continue
    const parent = parentOf(path)
    if (parent && current.has(parent) && !after.entries.has(parent)) continue
    entries.push({ change: 'deleted', path, kind: current.get(path)!.entry.kind })
  }
  const modified: RepositoryTreeChange[] = []
  for (const path of [...after.entries.keys()].sort(byPath)) {
    const row = after.entries.get(path)!
    const old = current.get(path)
    if (!old) {
      const parent = parentOf(path)
      if (parent && after.entries.has(parent) && !current.has(parent)) continue
      entries.push({ change: 'added', entry: row.entry })
    } else if (old.entry.kind !== row.entry.kind) {
      if (old.entry.kind === 'directory' || row.entry.kind === 'directory') {
        entries.push({ change: 'deleted', path, kind: old.entry.kind })
        entries.push({ change: 'added', entry: row.entry })
      } else modified.push({ change: 'modified', entry: row.entry })
    } else if (row.entry.kind !== 'directory' && old.signature !== row.signature)
      modified.push({ change: 'modified', entry: row.entry })
  }
  entries.push(...modified)
  const status: { path: string; entry: ChangeStatus | null }[] = []
  for (const path of [...new Set([...before.status.keys(), ...after.status.keys()])].sort(byPath)) {
    const old = before.status.get(path),
      next = after.status.get(path)
    if (JSON.stringify(old ?? null) !== JSON.stringify(next ?? null))
      status.push({ path, entry: next ?? null })
  }
  if (entries.length + status.length > limit) return null
  const git =
    status.length ||
    before.head !== after.head ||
    before.branch !== after.branch ||
    before.detached !== after.detached
      ? { head: after.head, branch: after.branch, detached: after.detached, status }
      : null
  return { entries, git }
}

export type ChangeBody =
  | ({ complete: true } & ChangeDiff)
  | { complete: false; reason: 'overflow' | 'limit' | 'unavailable' }
interface ChangeStream {
  stream_id: string
  revision: number
  /** The state the last batch described; null when it is unknown and the next batch must say so. */
  baseline: ChangeBaseline | null
  queue: Promise<unknown>
  idleSince: number | null
  /** Per installation, the revision up to which every batch was sent to it without a gap. */
  sent: Map<string, number>
}

/**
 * One numbered stream per worktree, shared by every change watcher of it. Batches are diffs
 * against the last published state, not a replay of filesystem hints, so a missed or merged
 * hint delays a change but never loses it. Work on one stream is serialised.
 */
export class ChangeStreams {
  limit = 1024
  private streams = new Map<string, ChangeStream>()
  constructor(private readonly newId: () => string) {}
  async open(worktree: string, compute: () => Promise<ChangeBaseline>) {
    this.sweep()
    let stream = this.streams.get(worktree)
    if (!stream) {
      const created: ChangeStream = {
        stream_id: this.newId(),
        revision: 0,
        baseline: null,
        queue: Promise.resolve(),
        // Idle until a watcher is registered, so a failed watch cannot pin it.
        idleSince: Date.now(),
        sent: new Map(),
      }
      created.queue = compute().then(
        (baseline) => {
          created.baseline = baseline
        },
        () => {}
      )
      this.streams.set(worktree, created)
      stream = created
    }
    await stream.queue
    return { stream_id: stream.stream_id, revision: stream.revision }
  }
  /**
   * Whether a client of `installation` standing at `cursor` has every later batch on its way,
   * so it can keep its tree; then records the stream's revision as where this client stands.
   */
  follow(
    worktree: string,
    installation: string,
    cursor: { stream_id: string; revision: number } | null
  ) {
    const stream = this.streams.get(worktree)
    if (!stream) return false
    const follows =
      !!cursor &&
      cursor.stream_id === stream.stream_id &&
      (cursor.revision === stream.revision ||
        (cursor.revision < stream.revision && stream.sent.get(installation) === stream.revision))
    stream.sent.set(installation, stream.revision)
    return follows
  }
  /** One batch was handed to `installation`'s journal. */
  sent(worktree: string, installation: string, revision: number) {
    const stream = this.streams.get(worktree)
    if (!stream) return
    if (stream.sent.get(installation) === revision - 1) stream.sent.set(installation, revision)
    else stream.sent.delete(installation)
  }
  position(worktree: string) {
    const stream = this.streams.get(worktree)
    return stream ? { stream_id: stream.stream_id, revision: stream.revision } : undefined
  }
  watched(worktree: string) {
    const stream = this.streams.get(worktree)
    if (stream) stream.idleSince = null
  }
  idle(worktree: string) {
    const stream = this.streams.get(worktree)
    if (stream) stream.idleSince = Date.now()
  }
  drop(worktree: string) {
    this.streams.delete(worktree)
  }
  clear() {
    this.streams.clear()
  }
  private sweep() {
    for (const [worktree, stream] of this.streams)
      if (stream.idleSince !== null && stream.idleSince + 10 * 60 * 1000 < Date.now())
        this.streams.delete(worktree)
    for (const [worktree, stream] of this.streams) {
      if (this.streams.size < 32) break
      if (stream.idleSince !== null) this.streams.delete(worktree)
    }
  }
  /** The next batch, or null when nothing a client shows has changed. */
  refreshFiles(
    worktree: string,
    paths: Iterable<string>,
    stat: (path: string) => { stamp: string; size: number } | null
  ) {
    const stream = this.streams.get(worktree)
    if (!stream) return Promise.resolve(null)
    const task = stream.queue.then(() => {
      if (!stream.baseline) return null
      const updates = new Map<
        string,
        ChangeBaseline['entries'] extends Map<string, infer Row> ? Row : never
      >()
      const entries: RepositoryTreeChange[] = []
      for (const path of paths) {
        const old = stream.baseline.entries.get(path)
        if (old?.entry.kind !== 'file') continue
        const current = stat(path)
        if (!current) continue // removals/type changes require the full reconciliation
        const entry = { ...old.entry, size: current.size }
        const signature = JSON.stringify([entry, current.stamp])
        if (signature === old.signature) continue
        updates.set(path, {
          entry,
          signature,
          identity: current.stamp.split(':').slice(0, 2).join(':'),
        })
        entries.push({ change: 'modified', entry })
      }
      if (
        !entries.length ||
        entries.length > this.limit ||
        Buffer.byteLength(JSON.stringify(entries)) > 192 * 1024
      )
        return null
      for (const [path, row] of updates) stream.baseline.entries.set(path, row)
      // File metadata can reach open views before the expensive whole-tree/Git scan.
      // That scan follows and publishes status, membership and any other changes.
      return {
        stream_id: stream.stream_id,
        revision: ++stream.revision,
        body: { complete: true as const, entries, git: null },
      }
    })
    stream.queue = task.catch(() => {})
    return task
  }
  advance(
    worktree: string,
    compute: () => Promise<ChangeBaseline>,
    reason: 'change' | 'overflow' | 'unavailable'
  ): Promise<{ stream_id: string; revision: number; body: ChangeBody } | null> {
    const stream = this.streams.get(worktree)
    if (!stream) return Promise.resolve(null)
    const batch = (body: ChangeBody) => ({
      stream_id: stream.stream_id,
      revision: ++stream.revision,
      body,
    })
    const task = stream.queue.then(async () => {
      if (reason !== 'change') {
        // Capture before announcing, so the client's reread is never older than the baseline.
        stream.baseline = await compute().catch(() => null)
        return batch({ complete: false, reason })
      }
      const next = await compute()
      const previous = stream.baseline
      stream.baseline = next
      if (!previous) return batch({ complete: false, reason: 'unavailable' })
      const diff = diffBaselines(previous, next, this.limit)
      // A journal record holds 256 KiB; long paths can outgrow it before the row count does.
      if (!diff || Buffer.byteLength(JSON.stringify(diff)) > 192 * 1024)
        return batch({ complete: false, reason: 'limit' })
      return diff.entries.length || diff.git ? batch({ complete: true, ...diff }) : null
    })
    stream.queue = task.catch(() => {})
    return task
  }
}
