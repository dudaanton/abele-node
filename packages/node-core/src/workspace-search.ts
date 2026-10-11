import { createHash, randomUUID } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { ChannelError, type AuthorityContext } from '@abele/channel-protocol'
import type { ResourceServices } from './resources.js'
import { searchWorker } from './repository.js'
type Match = { path: string; line: number; text: string; content_id: string | null }
interface Cursor {
  owner: string
  workspace: string
  key: string
  rows: Match[]
  offset: number
  omissions: string[]
  expires: number
}
/** Same bounded, terminable matcher as Git search; plain files remain target-relative. */
export class WorkspaceSearchService {
  private cursors = new Map<string, Cursor>()
  private workers = new Set<Worker>()
  private stopped = false
  constructor(private r: ResourceServices) {}
  private check(actor: AuthorityContext, id: string) {
    this.r.core.authority.check(actor, 'publish', id)
    const w = this.r.workspaces.get(id),
      p = this.r.projects.get(w.project_id)
    if (w.kind !== 'root' || p.repository_path) throw new ChannelError('invalid_params')
    this.r.repository.checkWorkspaceIdentity(w.project_id)
    this.r.files.list(id, '', undefined, 1)
  }
  async request(actor: AuthorityContext, p: Record<string, unknown>) {
    if (this.stopped) throw new ChannelError('resource_busy')
    const id = String(p.workspace_id)
    this.check(actor, id)
    for (const [id, c] of this.cursors) if (c.expires < Date.now()) this.cursors.delete(id)
    const { cursor: _cursor, limit: _limit, ...query } = p
    const key = createHash('sha256').update(JSON.stringify(query)).digest('hex')
    const page = (rows: Match[], offset: number, omissions: string[]) => {
      this.check(actor, id)
      const entries: Match[] = []
      let bytes = 1024
      for (const row of rows.slice(offset, offset + Number(p.limit))) {
        bytes += Buffer.byteLength(JSON.stringify(row))
        if (bytes > 32768) break
        entries.push(row)
      }
      offset += entries.length
      let cursor: string | null = null
      if (offset < rows.length) {
        if (this.cursors.size >= 32) throw new ChannelError('resource_busy')
        cursor = randomUUID()
        this.cursors.set(cursor, {
          owner: actor.installation_id,
          workspace: id,
          key,
          rows,
          offset,
          omissions,
          expires: Date.now() + 600000,
        })
      }
      return { entries, cursor, incomplete: omissions.length > 0, omissions }
    }
    if (p.cursor) {
      const c = this.cursors.get(String(p.cursor))
      if (!c || c.owner !== actor.installation_id || c.workspace !== id || c.key !== key)
        throw new ChannelError('stale_cursor')
      return page(c.rows, c.offset, c.omissions)
    }
    if (this.workers.size >= 4) throw new ChannelError('resource_busy')
    const deadline = Date.now() + 5000,
      omissions = new Set<string>(),
      files: string[] = []
    let inspected = 0
    const walk = (path: string, depth: number) => {
      if (depth > 32 || inspected++ >= 10000 || files.length >= 10000 || Date.now() > deadline) {
        omissions.add('scan limit')
        return
      }
      let after: string | undefined
      do {
        const listing = this.r.files.list(id, path, after, 256)
        for (const e of listing.entries) {
          if (e.name.toLowerCase() === '.git') continue
          if (e.kind === 'directory') walk(e.path, depth + 1)
          else if (e.kind === 'file') files.push(e.path)
          if (files.length >= 10000 || Date.now() > deadline) {
            omissions.add('scan limit')
            return
          }
        }
        after = listing.next ?? undefined
      } while (after)
    }
    walk('', 0)
    const worker = new Worker(searchWorker, {
      eval: true,
      resourceLimits: { maxOldGenerationSizeMb: 32, stackSizeMb: 2 },
    })
    this.workers.add(worker)
    const call = (data: unknown) =>
      new Promise<any>((resolve, reject) => {
        const cleanup = () => {
          clearTimeout(timer)
          worker.off('message', message)
          worker.off('error', failure)
          worker.off('exit', failure)
        }
        const message = (value: unknown) => {
          cleanup()
          resolve(value)
        }
        const failure = () => {
          cleanup()
          reject(new ChannelError('search_worker_failed'))
        }
        const timer = setTimeout(
          () => {
            cleanup()
            void worker.terminate()
            reject(new ChannelError('search_deadline'))
          },
          Math.max(1, deadline - Date.now())
        )
        worker.once('message', message)
        worker.once('error', failure)
        worker.once('exit', failure)
        worker.postMessage(data)
      })
    const rows: Match[] = []
    let scanned = 0,
      bytes = 0
    try {
      const init = await call({
        init: true,
        query: p.query,
        mode: p.mode,
        case_sensitive: p.case_sensitive,
        path_glob: p.path_glob,
      })
      if (init.error) throw new ChannelError('unsupported_search_syntax')
      const filtered = await call({ filter_paths: files })
      for (let i = 0; i < files.length; i++) {
        if (!filtered.included[i]) continue
        if (
          Date.now() > deadline ||
          scanned++ >= 1000 ||
          bytes >= 4 * 1024 * 1024 ||
          rows.length >= 1000
        ) {
          omissions.add('search budget; incomplete coverage')
          break
        }
        this.check(actor, id)
        const path = files[i]!,
          content = p.mode === 'filename' ? null : this.r.files.read(id, path)
        if (
          content?.binary ||
          content?.too_large ||
          (content?.size && content.size > 1024 * 1024)
        ) {
          omissions.add('binary or large file omitted')
          continue
        }
        const text = content ? this.r.files.bytes(id, content.content_id!).toString('utf8') : ''
        bytes += Buffer.byteLength(text)
        const found = await call({ path, text, max: 1000 - rows.length })
        for (const match of found.matches)
          rows.push({
            path,
            line: match.line,
            text: match.text,
            content_id: content?.content_id ?? null,
          })
        if (found.truncated) omissions.add('matches or line text truncated')
      }
    } catch (e) {
      if (!(e instanceof ChannelError) || e.code !== 'search_deadline') throw e
      omissions.add('5-second deadline; incomplete coverage')
    } finally {
      this.workers.delete(worker)
      await worker.terminate()
    }
    return page(rows, 0, [...omissions])
  }
  async stop() {
    this.stopped = true
    await Promise.all([...this.workers].map((w) => w.terminate()))
    this.workers.clear()
    this.cursors.clear()
  }
}
