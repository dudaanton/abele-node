/** The node's side of recorded runs: where a project's runs go, the recorder over every DAP session,
 * and the owner's bounded views of runs and their values (`trace.v1.*`). */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { ChannelError, type AuthorityContext } from '@abele/channel-protocol'
import {
  TRACE_V1_CAPABILITY,
  TraceMethodSchemas,
  type DebuggerSnapshot,
  type TraceMethod,
  type TraceRunResult,
  type TraceStep,
  type TraceTrail,
  type TraceValueMeta,
  type TraceValueResult,
} from '@abele/node-protocol'
import type { NodeCore } from '../index.js'
import type { DapSession } from '../debugger/driver.js'
import { TracePoints, TraceRecorder, tracePointsFile } from './recorder.js'
import { TraceStore, type TraceStoredStep, type TraceStoredValue } from './store.js'
import {
  diffValues,
  leavesOf,
  matches,
  pageOf,
  shapeOf,
  sliceOf,
  TRACE_CAPS,
  TRACE_PARSE_LIMIT,
  type TraceLeaf,
  type TraceShapeNode,
} from './values.js'

/** Stays under the channel's record size with room for the envelope. */
const PAGE_BYTES = 192 * 1024
const DEFAULT_FOLDER = '.abele/runs'

/** A few derived results by content hash, so a panel and an agent reading the same value share. */
class Lru<T> {
  private readonly map = new Map<string, T>()
  constructor(private readonly size: number) {}
  get(key: string, make: () => T): T {
    const hit = this.map.get(key)
    if (hit !== undefined) {
      this.map.delete(key)
      this.map.set(key, hit)
      return hit
    }
    const made = make()
    this.map.set(key, made)
    if (this.map.size > this.size) this.map.delete(this.map.keys().next().value!)
    return made
  }
}

const fail = (error: unknown): never => {
  if (error instanceof ChannelError) throw error
  const message = error instanceof Error ? error.message : String(error)
  if (/^trace_[a-z_]+$/.test(message)) throw new ChannelError(message)
  if (error instanceof SyntaxError) throw new ChannelError('trace_value_unreadable')
  throw new ChannelError('trace_failed', message.slice(0, 256))
}

export class TraceService {
  /** Worker-only read facade; no NodeCore, debugger, recorder or credentials. */
  static readOperation(store: TraceStore, method: string, p: Record<string, any>): unknown {
    const service = Object.create(TraceService.prototype) as TraceService
    Object.assign(service, {
      store: () => store,
      shapes: new Lru<TraceShapeNode>(64),
      leaves: new Lru<TraceLeaf[]>(16),
    })
    if (method === 'list') return store.list().map(summary)
    if (method === 'value') return service.value(p)
    if (method === 'find') return { hits: service.find('', p.run_id, p) }
    if (method === 'follow') return service.follow('', p.run_id, p.value, p.loose)
    if (method === 'mark') {
      const step = store.read(p.run_id).steps.find((s) => s.id === p.step)
      if (!step) throw new ChannelError('trace_step_not_found')
      if (p.name && !step.values.some((v) => v.name === p.name))
        throw new ChannelError('trace_value_not_found')
      return {
        mark: store.mark(p.run_id, {
          step: p.step,
          comment: p.comment,
          ...(p.name ? { name: p.name } : {}),
          ...(p.path ? { path: p.path } : {}),
          ...(p.tags ? { tags: p.tags } : {}),
        }),
      }
    }
    throw new Error('trace_invalid_operation')
  }
  readonly points: TracePoints
  readonly recorder: TraceRecorder
  private readonly stores = new Map<string, TraceStore>()
  private readonly shapes = new Lru<TraceShapeNode>(64)
  private readonly leaves = new Lru<TraceLeaf[]>(16)
  private readonly settingsFile: string
  constructor(private readonly core: NodeCore) {
    this.settingsFile = join(core.stateDir, 'trace', 'folders.json')
    this.points = new TracePoints(tracePointsFile(core.stateDir))
    this.recorder = new TraceRecorder({
      service: core.debugger,
      points: this.points,
      storeFor: (s) => this.store(s.target.project_id),
      rootFor: (s) => this.root(s.target.project_id),
      log: (message, detail) => console.debug(message, detail),
    })
  }

  capabilities() {
    return this.core.debugger.enabled ? { trace_v1: TRACE_V1_CAPABILITY } : {}
  }
  methods(): string[] {
    return this.core.debugger.enabled ? Object.keys(TraceMethodSchemas) : []
  }
  /** Every DAP session records while it has record points. */
  attach(session: DapSession) {
    return this.recorder.attach(session)
  }
  close() {
    this.recorder.close()
    for (const store of this.stores.values()) void store.close()
  }

  private root(project: string): string {
    const row = this.core.db
      .prepare('SELECT root_path FROM projects WHERE project_id=?')
      .get(project) as { root_path?: string } | undefined
    if (!row?.root_path) throw new ChannelError('not_found')
    return String(row.root_path)
  }
  private folders(): Record<string, string> {
    try {
      return existsSync(this.settingsFile)
        ? (JSON.parse(readFileSync(this.settingsFile, 'utf8')) as Record<string, string>)
        : {}
    } catch {
      return {}
    }
  }
  folder(project: string): { folder: string; chosen: boolean } {
    const root = this.root(project)
    const chosen = this.folders()[project]
    const folder = chosen || DEFAULT_FOLDER
    return { folder: isAbsolute(folder) ? folder : resolve(root, folder), chosen: !!chosen }
  }
  private setFolder(project: string, folder: string) {
    this.root(project)
    const all = this.folders()
    if (folder.trim()) all[project] = folder.trim()
    else delete all[project]
    mkdirSync(join(this.core.stateDir, 'trace'), { recursive: true, mode: 0o700 })
    writeFileSync(`${this.settingsFile}.tmp`, JSON.stringify(all, null, 2), { mode: 0o600 })
    renameSync(`${this.settingsFile}.tmp`, this.settingsFile)
    void this.stores.get(project)?.close()
    this.stores.delete(project)
    return this.folder(project)
  }
  store(project: string): TraceStore {
    const { folder } = this.folder(project)
    const cached = this.stores.get(project)
    if (cached?.root === folder) return cached
    void cached?.close()
    const store = new TraceStore(folder)
    // Runs in a project folder never show up as files to commit: the folder ignores itself.
    try {
      mkdirSync(folder, { recursive: true, mode: 0o700 })
      const ignore = join(folder, '.gitignore')
      if (!existsSync(ignore)) writeFileSync(ignore, '*\n', { mode: 0o600 })
    } catch (error) {
      console.debug('[trace] Runs folder unavailable', error)
    }
    this.stores.set(project, store)
    return store
  }

  private snapshot(session: string): DebuggerSnapshot {
    return this.core.debugger.snapshot(session).snapshot
  }

  request(actor: AuthorityContext, method: string, raw: unknown): unknown {
    this.core.authority.check(actor, 'request')
    if (!this.core.debugger.enabled || !Object.hasOwn(TraceMethodSchemas, method))
      throw new ChannelError('unsupported_method')
    const parsed = TraceMethodSchemas[method as TraceMethod].safeParse(raw)
    if (!parsed.success) throw new ChannelError('invalid_params')
    try {
      const result = this.handle(method as TraceMethod, parsed.data as Record<string, any>)
      return result instanceof Promise ? result.catch(fail) : result
    } catch (error) {
      return fail(error)
    }
  }

  private handle(method: TraceMethod, p: Record<string, any>): unknown {
    switch (method) {
      case 'trace.v1.points.list':
        this.snapshot(p.debug_session_id)
        return { points: this.points.list(p.debug_session_id) }
      case 'trace.v1.points.set':
        this.snapshot(p.debug_session_id)
        return { points: this.points.set(p.debug_session_id, p.upsert, p.remove) }
      case 'trace.v1.status': {
        const s = this.snapshot(p.debug_session_id)
        return {
          recording: this.recorder.recording(p.debug_session_id) ?? null,
          ...this.folder(s.target.project_id),
        }
      }
      case 'trace.v1.folder.get':
        return this.folder(p.project_id)
      case 'trace.v1.folder.set':
        return this.setFolder(p.project_id, p.folder)
      case 'trace.v1.runs':
        if (this.store(p.project_id).hasLargeTimeline())
          return this.store(p.project_id)
            .readOperation('list', {})
            .then((runs) => ({ runs, ...this.folder(p.project_id) }))
        return { runs: this.store(p.project_id).list().map(summary), ...this.folder(p.project_id) }
      case 'trace.v1.run':
        return this.run(p.project_id, p.run_id, p.from ?? 0, p.limit ?? 5000, p.kind, p.through)
      case 'trace.v1.value':
        if (
          this.store(p.project_id).large(p.run_id) ||
          this.store(p.project_id)
            .read(p.run_id)
            .steps.some(
              (step) => step.id === p.step && step.values.some((value) => value.bytes > 65536)
            )
        )
          return this.store(p.project_id).readOperation('value', p)
        return this.value(p)
      case 'trace.v1.find':
        if (p.value === undefined && p.key === undefined) throw new ChannelError('invalid_params')
        if (this.store(p.project_id).large(p.run_id))
          return this.store(p.project_id).readOperation('find', p)
        return { hits: this.find(p.project_id, p.run_id, p) }
      case 'trace.v1.follow':
        if (this.store(p.project_id).large(p.run_id))
          return this.store(p.project_id).readOperation('follow', p)
        return this.follow(p.project_id, p.run_id, p.value, p.loose)
      case 'trace.v1.mark': {
        if (this.store(p.project_id).large(p.run_id))
          return this.store(p.project_id).readOperation('mark', p)
        const { steps } = this.store(p.project_id).read(p.run_id)
        const step = steps.find((s) => s.id === p.step)
        if (!step) throw new ChannelError('trace_step_not_found')
        if (p.name && !step.values.some((v) => v.name === p.name))
          throw new ChannelError('trace_value_not_found')
        return {
          mark: this.store(p.project_id).mark(p.run_id, {
            step: p.step,
            ...(p.name ? { name: p.name } : {}),
            ...(p.path ? { path: p.path } : {}),
            comment: p.comment,
            ...(p.tags ? { tags: p.tags } : {}),
          }),
        }
      }
      case 'trace.v1.rename':
        this.store(p.project_id).rename(p.run_id, p.name)
        return { renamed: true }
      case 'trace.v1.delete':
        if (this.recorder.isRecording(p.run_id)) throw new ChannelError('trace_run_recording')
        this.store(p.project_id).delete(p.run_id)
        return { deleted: true }
    }
  }

  private run(
    project: string,
    id: string,
    from: number,
    limit: number,
    kinds?: string[],
    through?: number
  ): TraceRunResult | Promise<TraceRunResult> {
    const store = this.store(project)
    return store.large(id)
      ? store.page(id, from, limit, kinds, through)
      : traceRunPage(store, id, from, limit, kinds, through)
  }

  private stored(project: string, run: string, step: string, name: string) {
    const store = this.store(project)
    const { steps } = store.read(run)
    const at = steps.findIndex((s) => s.id === step)
    const value = steps[at]?.values.find((v) => v.name === name)
    if (!value) throw new ChannelError(at < 0 ? 'trace_step_not_found' : 'trace_value_not_found')
    return { store, steps, at, value, step }
  }

  private text(store: TraceStore, run: string, value: TraceStoredValue) {
    if (value.failed) throw new ChannelError('trace_value_failed', value.failed)
    if (value.masked) throw new ChannelError('trace_value_masked')
    return store.text(run, value)
  }

  private value(p: Record<string, any>): TraceValueResult {
    const { store, steps, at, value } = this.stored(p.project_id, p.run_id, p.step, p.name)
    const meta = metaOf(value, previous(steps, at, value.name))
    const kind: keyof typeof TRACE_CAPS = p.cap === 'agent' ? 'agent' : 'panel'
    const text = () => this.text(store, p.run_id, value)
    switch (p.view) {
      case 'shape':
        return {
          value: meta,
          shape: this.shapes.get(value.sha256, () => shapeOf(text(), value.format)),
        }
      case 'page':
        return {
          value: meta,
          page: pageOf(text(), value.format, p.from ?? 0, TRACE_CAPS[kind], kind),
        }
      case 'slice':
        return {
          value: meta,
          page: sliceOf(text(), value.format, p.path ?? '$', TRACE_CAPS[kind], kind, p.from ?? 0),
        }
      case 'changes': {
        const other = p.against
          ? this.stored(p.project_id, p.run_id, p.against.step, p.against.name)
          : previous(steps, at, value.name)
        if (!other) throw new ChannelError('trace_nothing_before')
        const d = diffValues(
          this.text(store, p.run_id, other.value),
          other.value.format,
          text(),
          value.format,
          TRACE_CAPS[kind].lines
        )
        return {
          value: meta,
          changes: { against: { step: other.step, name: other.value.name }, ...d },
        }
      }
    }
    throw new ChannelError('invalid_params')
  }

  private leavesFor(store: TraceStore, run: string, value: TraceStoredValue) {
    if (value.failed || value.masked || value.bytes > TRACE_PARSE_LIMIT) return []
    return this.leaves.get(value.sha256, () => {
      try {
        return leavesOf(store.text(run, value), value.format)
      } catch {
        return []
      }
    })
  }

  private find(project: string, run: string, needle: Record<string, any>) {
    const store = this.store(project)
    const out: { step: string; name: string; path: string }[] = []
    for (const s of store.read(run).steps)
      for (const v of s.values)
        for (const l of this.leavesFor(store, run, v))
          if (matches(l, needle)) {
            out.push({ step: s.id, name: v.name, path: l.path })
            if (out.length >= TRACE_CAPS.panel.lines) return out
          }
    return out
  }

  private follow(project: string, run: string, value: unknown, loose?: boolean): TraceTrail {
    const store = this.store(project)
    const steps = store.read(run).steps
    const stops: TraceTrail['stops'] = []
    let prev: TraceLeaf | undefined
    let lastSeen = -1
    steps.forEach((s, i) => {
      for (const v of s.values) {
        const hit = this.leavesFor(store, run, v).find((l) =>
          matches(l, { value: value as string | number | boolean, loose: loose ?? true })
        )
        if (!hit) continue
        const change =
          prev && prev.type !== hit.type
            ? `${prev.type} → ${hit.type}`
            : prev && prev.path !== hit.path
              ? 'moved'
              : undefined
        stops.push({ step: s.id, name: v.name, path: hit.path, ...(change ? { change } : {}) })
        prev = hit
        lastSeen = i
        if (stops.length >= TRACE_CAPS.panel.lines) return
        break
      }
    })
    return {
      value: String(value),
      stops,
      ...(lastSeen >= 0 && lastSeen < steps.length - 1 ? { lost_after: steps[lastSeen]!.id } : {}),
    }
  }
}

function summary(r: ReturnType<TraceStore['list']>[number]) {
  return {
    id: r.id,
    name: r.name,
    debug_session_id: r.session,
    started_at: r.started_at,
    ...(r.length_ms !== undefined ? { length_ms: r.length_ms } : {}),
    state: r.state,
    steps: r.steps,
    bytes: r.bytes,
  }
}

function previous(steps: TraceStoredStep[], at: number, name: string) {
  for (let i = at - 1; i >= 0; i--) {
    const v = steps[i]!.values.find((x) => x.name === name && !x.failed)
    if (v) return { value: v, step: steps[i]!.id }
  }
  return undefined
}

function metaOf(v: TraceStoredValue, before?: { value: TraceStoredValue }): TraceValueMeta {
  return {
    name: v.name,
    format: v.format,
    bytes: v.bytes,
    brief: v.brief ?? '',
    ...(before && !v.failed && before.value.sha256 === v.sha256 ? { same: true } : {}),
    ...(v.masked ? { masked: true } : {}),
    ...(v.failed ? { failed: v.failed } : {}),
  }
}

function stepOut(s: TraceStoredStep, lastBy: Map<string, string>): TraceStep {
  const values = s.values.map((v) => {
    const prevSha = lastBy.get(v.name)
    if (!v.failed) lastBy.set(v.name, v.sha256)
    return {
      ...metaOf(v),
      ...(prevSha && !v.failed && prevSha === v.sha256 ? { same: true } : {}),
    }
  })
  return {
    id: s.id,
    kind: s.kind,
    ts: s.ts,
    at: s.at,
    label: s.label,
    ...(s.point ? { point: s.point } : {}),
    ...(s.place ? { place: s.place } : {}),
    ...(s.stack ? { stack: s.stack } : {}),
    ...(s.paused_ms !== undefined ? { paused_ms: s.paused_ms } : {}),
    ...(s.status !== undefined ? { status: s.status } : {}),
    ...(s.host ? { host: s.host } : {}),
    ...(s.direction ? { direction: s.direction } : {}),
    ...(s.duration_ms !== undefined ? { duration_ms: s.duration_ms } : {}),
    ...(s.chain ? { chain: s.chain } : {}),
    ...(s.by_time ? { by_time: true } : {}),
    ...(s.sent ? { sent: true } : {}),
    values,
  }
}

export function traceRunPage(
  store: TraceStore,
  id: string,
  from: number,
  limit: number,
  kinds?: string[],
  through?: number
): TraceRunResult {
  const { run, steps: written } = store.read(id)
  if (through !== undefined && through > written.length)
    throw new ChannelError('trace_prefix_unavailable')
  const prefix = through === undefined ? written : written.slice(0, through)
  // Freeze the written prefix before chronological sorting. Later completed
  // exchanges may have earlier timestamps and must not shift existing pages.
  if (through !== undefined) run.steps = prefix.length
  // A sent request is written when its answer is in, at the time it went: in time it heads the
  // steps it caused, even if the first probe shares its millisecond. Otherwise
  // equal-time steps keep their write order.
  const steps = [...prefix].sort(
    (a, b) => a.at - b.at || Number(b.kind === 'http') - Number(a.kind === 'http')
  )
  const requests = steps.filter(
    (s) => s.kind === 'http' && s.direction && s.duration_ms !== undefined
  )
  const parents = new Set(steps.filter((s) => s.kind === 'http').map((s) => s.chain))
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!
    if (step.kind !== 'probe' || (step.chain && parents.has(step.chain))) continue
    const request = requests
      .filter((r) => r.at <= step.at && r.at + r.duration_ms! >= step.at)
      .sort((a, b) =>
        a.direction === b.direction ? b.at - a.at : a.direction === 'incoming' ? -1 : 1
      )[0]
    if (request?.chain) steps[i] = { ...step, chain: request.chain, by_time: true }
    else if (step.chain) {
      const { chain: _chain, by_time: _byTime, ...unlinked } = step
      steps[i] = unlinked
    }
  }
  const marks = store.marks(id)
  const marked = new Set(marks.map((m) => m.step))
  const lastBy = new Map<string, string>()
  const hits = new Map<string, number>()
  const last = new Map<string, string>()
  const all: TraceStep[] = steps.map((s) => {
    if (s.point) {
      hits.set(s.point, (hits.get(s.point) ?? 0) + 1)
      last.set(
        s.point,
        s.values
          .map((v) => (v.failed ? `${v.name} ✕` : `${v.name} ${v.brief ?? ''}`.trim()))
          .join(' · ')
      )
    }
    return {
      ...stepOut(s, lastBy),
      ...(marked.has(s.id) ? { marked: true } : {}),
    }
  })
  const shown = kinds?.length ? all.filter((s) => kinds.includes(s.kind)) : all
  const out: TraceStep[] = []
  let bytes = 0
  let i = from
  for (; i < shown.length && out.length < limit; i++) {
    const size = Buffer.byteLength(JSON.stringify(shown[i]))
    if (bytes + size > PAGE_BYTES && out.length) break
    out.push(shown[i]!)
    bytes += size
  }
  return {
    run: summary(run),
    points: run.points.map((p) => ({
      ...p,
      hits: hits.get(p.breakpoint_id) ?? 0,
      ...(last.has(p.breakpoint_id) ? { last: last.get(p.breakpoint_id)! } : {}),
    })),
    steps: out,
    ...(i < shown.length ? { next: i } : {}),
    marks,
    folder: store.root,
  }
}
