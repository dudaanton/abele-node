/** Recorded runs on disk, outside the node's database: one folder per run in a folder the owner
 * chose. `run.json` says what the run is, `timeline.jsonl` holds its steps in time, `blobs/`
 * every value whole by the hash of its content, `marks.jsonl` what was marked. Plain files, so a
 * run can be read, copied or deleted without the node. */
import { createHash, randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  statSync,
  openSync,
  closeSync,
  readSync,
} from 'node:fs'
import { Worker } from 'node:worker_threads'
import { appendFile, mkdir, writeFile, rename } from 'node:fs/promises'
import { promisify } from 'node:util'
import type { TraceRunResult } from '@abele/node-protocol'
import { ChannelError } from '@abele/channel-protocol'
import { join } from 'node:path'
import { gunzipSync, gzipSync, gzip } from 'node:zlib'
import { briefOf, formatOf, TRACE_PARSE_LIMIT, type TraceFormat } from './values.js'

/** A value this small lives in its step rather than in a file. */
export const TRACE_INLINE_BYTES = 256
/** A value this large is packed. */
export const TRACE_PACK_BYTES = 64 * 1024

export const TRACE_RUN_VERSION = 1

export interface TraceStoredValue {
  name: string
  format: TraceFormat
  bytes: number
  sha256: string
  /** How it reads in one line, worked out when it was written. */
  brief?: string
  inline?: string
  /** It could not be taken, and why. */
  failed?: string
  /** Blanked before writing: nothing is behind it. */
  masked?: boolean
}

export interface TraceStoredStep {
  id: string
  kind: 'probe' | 'error' | 'http' | 'browser-lost'
  ts: string
  /** Milliseconds from the start of the run. */
  at: number
  label: string
  /** The record point that took it. */
  point?: string
  place?: { file: string; line: number; fn?: string }
  stack?: string[]
  paused_ms?: number
  status?: number
  host?: string
  direction?: 'incoming' | 'outgoing'
  duration_ms?: number
  chain?: string
  /** Under its request only because it ran while the request was out. */
  by_time?: boolean
  /** A request sent from the project's saved requests, not by a browser. */
  sent?: boolean
  values: TraceStoredValue[]
}

export interface TracePointCopy {
  breakpoint_id: string
  file: string
  line: number
  take: string[]
  when?: string
  note?: string
}

export interface TraceRunMeta {
  version: typeof TRACE_RUN_VERSION
  id: string
  name: string
  session: string
  started_at: string
  ended_at?: string
  length_ms?: number
  state: 'recording' | 'done' | 'cut'
  steps: number
  bytes: number
  points: TracePointCopy[]
}

export interface TraceMark {
  step: string
  name?: string
  path?: string
  comment: string
  tags?: string[]
  at?: string
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SHA = /^[a-f0-9]{64}$/
const pack = promisify(gzip)
async function writeAtomicAsync(path: string, text: string | Buffer) {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, text, { mode: 0o600 })
  await rename(tmp, path)
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
const runId = (d: Date) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(
    d.getMinutes()
  )}${pad(d.getSeconds())}-${randomBytes(3).toString('hex')}`

function writeAtomic(path: string, text: string | Buffer) {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  const out: T[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      // A line cut by a crash mid-write: everything before it is whole.
    }
  }
  return out
}

/** Writes one run while it is being recorded. */
export class TraceRunWriter {
  private count = 0
  private committed = 0
  private size = 0
  private writes: Promise<unknown> = Promise.resolve()
  private readonly records = new Set<Promise<unknown>>()
  constructor(
    private readonly dir: string,
    private readonly meta: TraceRunMeta
  ) {}
  get id() {
    return this.meta.id
  }
  get steps() {
    return this.committed
  }
  get startedAt() {
    return Date.parse(this.meta.started_at)
  }

  /** Refresh configuration in place; the timeline, values and run identity stay intact. */
  updatePoints(points: TracePointCopy[]) {
    if (
      this.meta.state !== 'recording' ||
      JSON.stringify(points) === JSON.stringify(this.meta.points)
    )
      return
    this.meta.points = structuredClone(points)
    writeAtomic(join(this.dir, 'run.json'), JSON.stringify(this.meta, null, 2))
  }

  /** Stores a value whole and says how a step refers to it. */
  value(name: string, text: string, format: TraceFormat = formatOf(text)): TraceStoredValue {
    const bytes = Buffer.byteLength(text)
    const sha256 = createHash('sha256').update(text).digest('hex')
    const brief = briefOf(
      text.length > TRACE_PARSE_LIMIT ? text.slice(0, 4096) : text,
      format,
      true
    )
    if (bytes <= TRACE_INLINE_BYTES) return { name, format, bytes, sha256, brief, inline: text }
    const blobs = join(this.dir, 'blobs')
    const packed = bytes > TRACE_PACK_BYTES
    const file = join(blobs, packed ? `${sha256}.gz` : sha256)
    if (!existsSync(file)) {
      mkdirSync(blobs, { recursive: true, mode: 0o700 })
      writeAtomic(file, packed ? gzipSync(text) : text)
      this.size += bytes
    }
    return { name, format, bytes, sha256, brief }
  }

  failed(name: string, reason: string): TraceStoredValue {
    return { name, format: 'text', bytes: 0, sha256: '', failed: reason.slice(0, 512) }
  }

  async valueAsync(
    name: string,
    text: string,
    format: TraceFormat = formatOf(text)
  ): Promise<TraceStoredValue> {
    const bytes = Buffer.byteLength(text),
      sha256 = createHash('sha256').update(text).digest('hex')
    const brief = briefOf(
      text.length > TRACE_PARSE_LIMIT ? text.slice(0, 4096) : text,
      format,
      true
    )
    if (bytes <= TRACE_INLINE_BYTES) return { name, format, bytes, sha256, brief, inline: text }
    const blobs = join(this.dir, 'blobs'),
      packed = bytes > TRACE_PACK_BYTES
    const file = join(blobs, packed ? `${sha256}.gz` : sha256)
    const write = this.writes.then(async () => {
      if (existsSync(file)) return
      await mkdir(blobs, { recursive: true, mode: 0o700 })
      await writeAtomicAsync(file, packed ? await pack(text) : text)
      this.size += bytes
    })
    this.writes = write
    await write
    return { name, format, bytes, sha256, brief }
  }

  appendAsync(
    step: Omit<TraceStoredStep, 'id' | 'ts'> & { ts?: string }
  ): Promise<TraceStoredStep> {
    const full: TraceStoredStep = {
      id: `t${pad(++this.count, 4)}`,
      ts: step.ts ?? new Date(this.startedAt + step.at).toISOString(),
      ...step,
    }
    const write = this.writes.then(async () => {
      await appendFile(join(this.dir, 'timeline.jsonl'), `${JSON.stringify(full)}\n`, {
        mode: 0o600,
      })
      this.meta.steps = ++this.committed
      this.meta.bytes = this.size
      return full
    })
    this.writes = write
    return write
  }

  async closeAsync(state: 'done' | 'cut', lengthMs: number) {
    await this.flush()
    this.meta.state = state
    this.meta.length_ms = lengthMs
    this.meta.ended_at = new Date(this.startedAt + lengthMs).toISOString()
    this.meta.steps = this.committed
    this.meta.bytes = this.size
    try {
      await writeAtomicAsync(join(this.dir, 'run.json'), JSON.stringify(this.meta, null, 2))
    } catch (error) {
      // An ended run can be deleted while its last metadata write is draining.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || existsSync(this.dir)) throw error
    }
  }

  recordAsync<T>(work: () => Promise<T>): Promise<T> {
    const record = Promise.resolve().then(work)
    this.records.add(record)
    record.then(
      () => this.records.delete(record),
      () => this.records.delete(record)
    )
    return record
  }
  async flush() {
    while (this.records.size) await Promise.all(this.records)
    await this.writes
  }

  append(step: Omit<TraceStoredStep, 'id' | 'ts'> & { ts?: string }): TraceStoredStep {
    const full: TraceStoredStep = {
      id: `t${pad(++this.count, 4)}`,
      ts: step.ts ?? new Date(this.startedAt + step.at).toISOString(),
      ...step,
    }
    appendFileSync(join(this.dir, 'timeline.jsonl'), `${JSON.stringify(full)}\n`, { mode: 0o600 })
    this.meta.steps = ++this.committed
    this.meta.bytes = this.size
    return full
  }

  discardEmpty() {
    // Only the recorder's own empty writer can be discarded, never a nonempty run.
    if (!this.count) {
      rmSync(this.dir, { recursive: true, force: true })
      return true
    }
    return false
  }

  close(state: 'done' | 'cut', lengthMs: number) {
    this.meta.state = state
    this.meta.length_ms = lengthMs
    this.meta.ended_at = new Date(this.startedAt + lengthMs).toISOString()
    this.meta.steps = this.committed
    this.meta.bytes = this.size
    writeAtomic(join(this.dir, 'run.json'), JSON.stringify(this.meta, null, 2))
  }
}

export class TraceStore {
  private worker?: Worker
  private sequence = 0
  private readonly pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >()
  private readonly timelines = new Map<
    string,
    { ino: number; size: number; mtime: number; rows: TraceStoredStep[] }
  >()
  constructor(readonly root: string) {}

  large(id: string) {
    return (
      (statSync(join(this.dir(id), 'timeline.jsonl'), { throwIfNoEntry: false })?.size ?? 0) >
      128 * 1024
    )
  }
  hasLargeTimeline() {
    return (
      existsSync(this.root) &&
      readdirSync(this.root).some((id) => {
        try {
          return this.large(id)
        } catch {
          return false
        }
      })
    )
  }
  page(
    id: string,
    from: number,
    limit: number,
    kinds?: string[],
    through?: number
  ): Promise<TraceRunResult> {
    this.dir(id)
    return this.readOperation('run', { id, from, limit, kinds, through })
  }
  readOperation<T>(operation: string, params: Record<string, unknown>): Promise<T> {
    if (!this.worker) {
      const sibling = new URL('./page-worker.js', import.meta.url)
      const worker = (this.worker = new Worker(
        existsSync(sibling) ? sibling : new URL('../../dist/trace/page-worker.js', import.meta.url),
        { workerData: { root: this.root }, resourceLimits: { maxOldGenerationSizeMb: 256 } }
      ))
      worker.on('message', ({ seq, result, error, code }) => {
        const pending = this.pending.get(seq)
        this.pending.delete(seq)
        if (error) pending?.reject(code ? new ChannelError(code, error) : new Error(error))
        else pending?.resolve(result)
        if (!this.pending.size) worker.unref()
      })
      const failed = (error: Error) => {
        if (this.worker !== worker) return
        this.worker = undefined
        for (const p of this.pending.values()) p.reject(error)
        this.pending.clear()
      }
      worker.on('error', failed)
      worker.on('exit', () => failed(new Error('trace_reader_closed')))
    }
    this.worker.ref()
    if (this.pending.size >= 16) return Promise.reject(new Error('trace_reader_busy'))
    return new Promise((resolve, reject) => {
      const seq = ++this.sequence
      this.pending.set(seq, { resolve, reject })
      this.worker!.postMessage({ seq, operation, params })
    })
  }
  async close() {
    const worker = this.worker
    this.worker = undefined
    for (const pending of this.pending.values()) pending.reject(new Error('trace_reader_closed'))
    this.pending.clear()
    if (worker) await worker.terminate()
  }

  /** The parsed prefix is indexed once, then only newly appended complete lines
   * are read. Large-file callers use this in the reader worker, off the host loop. */
  private timeline(id: string): TraceStoredStep[] {
    const path = join(this.dir(id), 'timeline.jsonl'),
      info = statSync(path, { throwIfNoEntry: false })
    if (!info) {
      this.timelines.delete(id)
      return []
    }
    let cached = this.timelines.get(id)
    if (
      !cached ||
      cached.ino !== info.ino ||
      info.size < cached.size ||
      (info.size === cached.size && cached.mtime !== info.mtimeMs)
    ) {
      cached = { ino: info.ino, size: 0, mtime: info.mtimeMs, rows: [] }
      this.timelines.set(id, cached)
      if (this.timelines.size > 4) this.timelines.delete(this.timelines.keys().next().value!)
    }
    if (info.size > cached.size) {
      const fd = openSync(path, 'r'),
        buffer = Buffer.alloc(64 * 1024)
      let offset = cached.size,
        carry = Buffer.alloc(0)
      try {
        while (offset < info.size) {
          const count = readSync(fd, buffer, 0, Math.min(buffer.length, info.size - offset), offset)
          if (!count) break
          offset += count
          const data = Buffer.concat([carry, buffer.subarray(0, count)])
          let start = 0
          for (let i = 0; i < data.length; i++)
            if (data[i] === 10) {
              try {
                cached.rows.push(JSON.parse(data.subarray(start, i).toString('utf8')))
              } catch {
                /* Cut/corrupt line. */
              }
              cached.size += i - start + 1
              start = i + 1
            }
          carry = Buffer.from(data.subarray(start))
        }
      } finally {
        closeSync(fd)
      }
      // Do not index an unfinished tail: a writer may complete it on the next read.
    }
    cached.mtime = info.mtimeMs
    return cached.rows
  }

  private dir(id: string) {
    if (!RUN_ID.test(id) || !existsSync(join(this.root, id, 'run.json')))
      throw new Error('trace_run_not_found')
    return join(this.root, id)
  }

  create(input: { session: string; name?: string; started?: Date; points: TracePointCopy[] }) {
    const started = input.started ?? new Date()
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const id = runId(started)
    const dir = join(this.root, id)
    mkdirSync(dir, { mode: 0o700 })
    const meta: TraceRunMeta = {
      version: TRACE_RUN_VERSION,
      id,
      name:
        input.name ??
        `${started.getFullYear()}-${pad(started.getMonth() + 1)}-${pad(started.getDate())} ${pad(started.getHours())}:${pad(started.getMinutes())}:${pad(started.getSeconds())}`,
      session: input.session,
      started_at: started.toISOString(),
      state: 'recording',
      steps: 0,
      bytes: 0,
      points: input.points,
    }
    writeAtomic(join(dir, 'run.json'), JSON.stringify(meta, null, 2))
    writeFileSync(join(dir, 'timeline.jsonl'), '', { mode: 0o600 })
    return new TraceRunWriter(dir, meta)
  }

  private meta(id: string): TraceRunMeta {
    const dir = this.dir(id)
    const meta = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')) as TraceRunMeta
    // A run still marked as recording counts its steps from the timeline itself.
    if (meta.state === 'recording') meta.steps = this.timeline(id).length
    return meta
  }

  list(): TraceRunMeta[] {
    if (!existsSync(this.root)) return []
    const out: TraceRunMeta[] = []
    for (const name of readdirSync(this.root)) {
      try {
        out.push(this.meta(name))
      } catch {
        // Not a run: anything else the folder holds is left alone.
      }
    }
    return out.sort((a, b) => b.started_at.localeCompare(a.started_at) || b.id.localeCompare(a.id))
  }

  read(id: string): { run: TraceRunMeta; steps: TraceStoredStep[] } {
    const run = this.meta(id)
    return { run, steps: this.timeline(id) }
  }

  /** The whole text of a stored value. */
  text(id: string, value: TraceStoredValue): string {
    if (value.inline !== undefined) return value.inline
    if (value.failed || value.masked) throw new Error('trace_value_unavailable')
    if (!SHA.test(value.sha256)) throw new Error('trace_value_not_found')
    const dir = this.dir(id)
    const plain = join(dir, 'blobs', value.sha256)
    if (existsSync(plain)) return readFileSync(plain, 'utf8')
    const packed = `${plain}.gz`
    if (existsSync(packed)) return gunzipSync(readFileSync(packed)).toString('utf8')
    throw new Error('trace_value_not_found')
  }

  rename(id: string, name: string) {
    const meta = this.meta(id)
    meta.name = name.trim().slice(0, 200) || meta.name
    writeAtomic(join(this.dir(id), 'run.json'), JSON.stringify(meta, null, 2))
  }

  delete(id: string) {
    rmSync(this.dir(id), { recursive: true, force: true })
  }

  mark(id: string, mark: TraceMark) {
    const full = { ...mark, at: mark.at ?? new Date().toISOString() }
    appendFileSync(join(this.dir(id), 'marks.jsonl'), `${JSON.stringify(full)}\n`, { mode: 0o600 })
    return full
  }

  marks(id: string): TraceMark[] {
    return readJsonl<TraceMark>(join(this.dir(id), 'marks.jsonl'))
  }
}
