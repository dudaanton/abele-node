/** Recording a run over a debugger session. A record point is an ordinary breakpoint plus what to
 * take there; when the program stops on record points only, the recorder takes their values
 * whole, writes a step and lets the program go on. A stop on any ordinary breakpoint stays a stop.
 * A session records whenever it has a record point: there is no separate record switch. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'
import type { DebuggerSnapshot } from '@abele/node-protocol'
import type { DebuggerService } from '../debugger/index.js'
import type { DapSession, RecordedStop } from '../debugger/driver.js'
import { parseTake } from './capture.js'
import type { TracePointCopy, TraceRunWriter, TraceStore } from './store.js'

export interface TracePoint {
  breakpoint_id: string
  take: string[]
  note?: string
}

const MAX_POINTS = 256
const MAX_TAKES = 32

/** Record points by debugger session, kept beside the node's state so a restart keeps them. */
export class TracePoints {
  private readonly bySession = new Map<string, Map<string, TracePoint>>()
  private readonly listeners = new Set<(session: string) => void>()
  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8')) as Record<string, TracePoint[]>
        for (const [session, points] of Object.entries(saved))
          this.bySession.set(session, new Map(points.map((p) => [p.breakpoint_id, p])))
      } catch {
        // An unreadable file starts empty rather than stopping the node.
      }
    }
  }
  onChange(listener: (session: string) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  list(session: string): TracePoint[] {
    return [...(this.bySession.get(session)?.values() ?? [])]
  }
  get(session: string, breakpoint: string) {
    return this.bySession.get(session)?.get(breakpoint)
  }
  set(session: string, upsert: TracePoint[], remove: string[]) {
    const points = new Map(this.bySession.get(session) ?? [])
    for (const id of remove) points.delete(id)
    for (const p of upsert) {
      if (p.take.length > MAX_TAKES) throw new Error('trace_too_many_takes')
      points.set(p.breakpoint_id, {
        breakpoint_id: p.breakpoint_id,
        take: p.take.map((t) => t.trim()).filter(Boolean),
        ...(p.note?.trim() ? { note: p.note.trim().slice(0, 200) } : {}),
      })
    }
    if (points.size > MAX_POINTS) throw new Error('trace_too_many_points')
    if (points.size) this.bySession.set(session, points)
    else this.bySession.delete(session)
    this.save()
    for (const l of this.listeners) l(session)
    return this.list(session)
  }
  private save() {
    if (!this.file) return
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const tmp = `${this.file}.tmp`
    writeFileSync(
      tmp,
      JSON.stringify(Object.fromEntries([...this.bySession].map(([s, m]) => [s, [...m.values()]]))),
      { mode: 0o600 }
    )
    renameSync(tmp, this.file)
  }
}

export interface TraceRecorderHost {
  service: DebuggerService
  points: TracePoints
  /** Where this session's runs go: the project's runs folder. */
  storeFor(snapshot: DebuggerSnapshot): TraceStore
  /** The project folder, so places in the code read relative to it. */
  rootFor?(snapshot: DebuggerSnapshot): string | undefined
  now?: () => number
  log?: (message: string, detail?: unknown) => void
}

interface Live {
  session: DapSession
  writer?: TraceRunWriter
  startedAt: number
  handled: Set<string>
  queue: Promise<void>
  off: () => void
}

const terminal: Record<string, 'done' | 'cut' | undefined> = {
  terminated: 'done',
  detached: 'done',
  failed: 'cut',
  'connection-lost': 'cut',
}

export class TraceRecorder {
  private readonly live = new Map<string, Live>()
  private readonly offPoints: () => void
  constructor(private readonly host: TraceRecorderHost) {
    this.offPoints = host.points.onChange((session) => {
      const l = this.live.get(session)
      if (l) this.ensureRun(l)
    })
  }
  private now() {
    return (this.host.now ?? Date.now)()
  }

  /** Watches one live DAP session for as long as it lives. */
  attach(session: DapSession): () => void {
    const l: Live = {
      session,
      startedAt: this.now(),
      handled: new Set(),
      queue: Promise.resolve(),
      off: () => {},
    }
    this.live.set(session.id, l)
    l.off = this.host.service.subscribe(session.id, () => this.observe(l))
    this.ensureRun(l)
    this.observe(l)
    return () => this.detach(l, 'done')
  }

  /** The run being recorded in this session, if any. */
  recording(session: string) {
    const l = this.live.get(session)
    return l?.writer
      ? {
          run_id: l.writer.id,
          steps: l.writer.steps,
          started_at: new Date(l.writer.startedAt).toISOString(),
        }
      : undefined
  }

  /** Whether a run is being written now, in any session. */
  isRecording(run: string) {
    return [...this.live.values()].some((l) => l.writer?.id === run)
  }

  /** Lets queued captures finish; for tests and shutdown. */
  async settled(session: string) {
    await this.live.get(session)?.queue
  }

  close() {
    for (const l of [...this.live.values()]) this.detach(l, 'cut')
    this.offPoints()
  }

  private pointCopies(l: Live, snapshot: DebuggerSnapshot): TracePointCopy[] {
    return this.host.points.list(l.session.id).flatMap((p) => {
      const bp = snapshot.breakpoints.find((b) => b.breakpoint_id === p.breakpoint_id)
      if (!bp) return []
      return [
        {
          breakpoint_id: p.breakpoint_id,
          file: this.place(snapshot, l.session.sources.get(bp.source_id) ?? bp.source_id),
          line: bp.resolved_line ?? bp.line,
          take: p.take,
          ...(bp.condition ? { when: bp.condition } : {}),
          ...(p.note ? { note: p.note } : {}),
        },
      ]
    })
  }

  private place(snapshot: DebuggerSnapshot, path: string) {
    const root = this.host.rootFor?.(snapshot)
    if (root && isAbsolute(path)) {
      const r = relative(root, path)
      if (r && !r.startsWith('..') && !isAbsolute(r)) return r
    }
    return path
  }

  private ensureRun(l: Live) {
    if (l.writer) return
    const snapshot = l.session.snapshot
    if (terminal[snapshot.lifecycle]) return
    const points = this.pointCopies(l, snapshot)
    if (!points.length) return
    try {
      l.writer = this.host.storeFor(snapshot).create({
        session: l.session.id,
        started: new Date(l.startedAt),
        points,
      })
    } catch (error) {
      this.host.log?.('[trace] Could not start a run', error)
    }
  }

  private detach(l: Live, state: 'done' | 'cut') {
    if (this.live.get(l.session.id) !== l) return
    this.live.delete(l.session.id)
    l.off()
    const writer = l.writer
    if (writer)
      void l.queue
        .then(() => writer.close(state, this.now() - writer.startedAt))
        .catch((error) => this.host.log?.('[trace] Could not close the run', error))
  }

  private observe(l: Live) {
    if (this.live.get(l.session.id) !== l) return
    const snapshot = l.session.snapshot
    const end = terminal[snapshot.lifecycle]
    if (end) return this.detach(l, end)
    // A breakpoint that arrives after its record point starts the run too.
    if (!l.writer) this.ensureRun(l)
    for (const thread of snapshot.threads) {
      if (thread.status !== 'stopped' || !thread.stop) continue
      const key = `${snapshot.incarnation}:${snapshot.stop_epoch}:${thread.thread_id}`
      if (l.handled.has(key)) continue
      l.handled.add(key)
      if (l.handled.size > 1024) l.handled.delete(l.handled.values().next().value!)
      const hits = thread.stop.hit_breakpoint_ids
      const points = hits.map((id) => this.host.points.get(l.session.id, id))
      if (hits.length && points.every(Boolean)) {
        const stoppedAt = this.now()
        const id = thread.thread_id
        l.queue = l.queue.then(() => this.capture(l, id, points as TracePoint[], stoppedAt))
      } else if (thread.stop.reason === 'exception' && l.writer) {
        l.writer.append({
          kind: 'error',
          at: this.now() - l.writer.startedAt,
          label: thread.stop.description ?? 'Exception',
          values: [],
        })
      }
    }
  }

  private async capture(l: Live, thread: number, points: TracePoint[], stoppedAt: number) {
    this.ensureRun(l)
    const writer = l.writer
    const takes = new Map<string, string>()
    for (const p of points)
      for (const t of p.take) {
        const { name, expression } = parseTake(t)
        if (!takes.has(name)) takes.set(name, expression)
      }
    let stop: RecordedStop | undefined
    let failure: string | undefined
    try {
      stop = await l.session.recordStop(
        thread,
        [...takes].map(([name, expression]) => ({ name, expression }))
      )
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      this.host.log?.('[trace] Record point could not be read', error)
    }
    const resumedAt = this.now()
    try {
      await l.session.continue(thread)
    } catch (error) {
      // Left stopped: whoever looks at the session sees where it stands.
      this.host.log?.('[trace] Could not let the program go on', error)
    }
    if (!writer) return
    const snapshot = l.session.snapshot
    const top = stop?.frames[0]
    const point = this.pointCopies(l, snapshot).find(
      (p) => p.breakpoint_id === points[0]?.breakpoint_id
    )
    const file = top?.path ? this.place(snapshot, top.path) : point?.file
    const line = top?.line || point?.line
    const values = stop
      ? stop.values.map((v) =>
          v.error !== undefined || v.text === undefined
            ? writer.failed(v.name, v.error ?? 'Not taken')
            : writer.value(v.name, v.text)
        )
      : [...takes.keys()].map((name) => writer.failed(name, failure ?? 'Not taken'))
    writer.append({
      kind: 'probe',
      at: stoppedAt - writer.startedAt,
      ...(points[0] ? { point: points[0].breakpoint_id } : {}),
      label:
        points.map((p) => p.note).find(Boolean) ??
        (file ? `${file.split('/').pop()}:${line}` : 'Record point'),
      ...(file && line ? { place: { file, line, ...(top?.name ? { fn: top.name } : {}) } } : {}),
      ...(stop
        ? {
            stack: stop.frames.map(
              (f) => `${f.name} ${f.path ? this.place(snapshot, f.path) : '?'}:${f.line}`
            ),
          }
        : {}),
      paused_ms: Math.max(0, resumedAt - stoppedAt),
      values,
    })
  }
}

export const tracePointsFile = (stateDir: string) => join(stateDir, 'trace', 'points.json')
