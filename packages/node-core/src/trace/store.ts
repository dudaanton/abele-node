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
} from 'node:fs'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
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
  chain?: string
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

const pad = (n: number, w = 2) => String(n).padStart(w, '0')
const runId = (d: Date) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(
    d.getUTCMinutes()
  )}${pad(d.getUTCSeconds())}-${randomBytes(3).toString('hex')}`

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
  private size = 0
  constructor(
    private readonly dir: string,
    private readonly meta: TraceRunMeta
  ) {}
  get id() {
    return this.meta.id
  }
  get steps() {
    return this.count
  }
  get startedAt() {
    return Date.parse(this.meta.started_at)
  }

  /** Stores a value whole and says how a step refers to it. */
  value(name: string, text: string, format: TraceFormat = formatOf(text)): TraceStoredValue {
    const bytes = Buffer.byteLength(text)
    const sha256 = createHash('sha256').update(text).digest('hex')
    const brief = briefOf(text.length > TRACE_PARSE_LIMIT ? text.slice(0, 4096) : text, format)
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

  append(step: Omit<TraceStoredStep, 'id' | 'ts'> & { ts?: string }): TraceStoredStep {
    const full: TraceStoredStep = {
      id: `t${pad(++this.count, 4)}`,
      ts: step.ts ?? new Date(this.startedAt + step.at).toISOString(),
      ...step,
    }
    appendFileSync(join(this.dir, 'timeline.jsonl'), `${JSON.stringify(full)}\n`, { mode: 0o600 })
    this.meta.steps = this.count
    this.meta.bytes = this.size
    return full
  }

  close(state: 'done' | 'cut', lengthMs: number) {
    this.meta.state = state
    this.meta.length_ms = lengthMs
    this.meta.ended_at = new Date(this.startedAt + lengthMs).toISOString()
    this.meta.steps = this.count
    this.meta.bytes = this.size
    writeAtomic(join(this.dir, 'run.json'), JSON.stringify(this.meta, null, 2))
  }
}

export class TraceStore {
  constructor(readonly root: string) {}

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
      name: input.name ?? started.toISOString().replace('T', ' ').slice(0, 19),
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
    if (meta.state === 'recording') meta.steps = readJsonl(join(dir, 'timeline.jsonl')).length
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
    return { run, steps: readJsonl<TraceStoredStep>(join(this.dir(id), 'timeline.jsonl')) }
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
