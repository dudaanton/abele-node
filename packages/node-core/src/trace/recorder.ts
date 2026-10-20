/** Recording a run over a debugger session. A record point is an ordinary breakpoint plus what to
 * take there; when the program stops on record points only, the recorder takes their values
 * whole, writes a step and lets the program go on. A stop on any ordinary breakpoint stays a stop.
 * A session records whenever it has a record point: there is no separate record switch. */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname, join, relative, isAbsolute } from 'node:path'
import type { DebuggerSnapshot } from '@abele/node-protocol'
import type { DebuggerService } from '../debugger/index.js'
import type { DapSession, RecordedStop } from '../debugger/driver.js'
import { parseTake } from './capture.js'
import type { TracePointCopy, TraceRunWriter, TraceStore } from './store.js'
import type { ProgramHttpEvent } from './program-http.js'

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
  /** Requests out now, sent into this run: what the points take meanwhile stands under them. */
  chains: Map<string, { steps: number; request?: { method: string; url: string } }>
  httpOff?: () => void
  httpPoll?: () => void
  http: ProgramHttpEvent[]
  httpSteps: Map<string, string>
  configuration: number
}

/** A request sent into a recording while it is out: steps taken meanwhile go under it, and it
 * writes itself into the run when its answer is in. */
export interface TraceChain {
  readonly id: string
  readonly runId: string
  /** Steps the record points took while it was out. */
  readonly steps: number
  /** Writes the request as a step at the time it went, heading the steps under it. */
  close(step: {
    label: string
    status?: number
    host?: string
    values: { name: string; text?: string; failed?: string }[]
  }): string | undefined
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
      if (l) {
        l.configuration++
        if (!host.points.list(session).length) this.finish(l, 'done')
        else this.ensureRun(l)
      }
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
      chains: new Map(),
      http: [],
      httpSteps: new Map(),
      configuration: 0,
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

  /** Opens a request's chain in the run this session writes; none when nothing is recorded. */
  chain(session: string, request?: { method: string; url: string }): TraceChain | undefined {
    const l = this.live.get(session)
    const writer = l?.writer
    if (!l || !writer) return undefined
    const id = `h${randomBytes(6).toString('hex')}`
    const entry = { steps: 0, request }
    l.chains.set(id, entry)
    const at = this.now() - writer.startedAt
    let closed = false
    let confirmed = !request
    return {
      id,
      runId: writer.id,
      get steps() {
        return closed && !confirmed ? 0 : entry.steps
      },
      close: (step) => {
        if (closed) return undefined
        closed = true
        l.chains.delete(id)
        // The run may have ended while the request was out: it is written no more.
        if (l.writer !== writer || this.live.get(session) !== l) return undefined
        // Selecting a recording is not evidence that this program served the send.
        // Confirm against traffic observed inside this session's own debuggee.
        if (request) {
          let address: URL
          try {
            address = new URL(request.url)
          } catch {
            return undefined
          }
          address.hash = ''
          const matches = l.http.filter(
            (e) =>
              e.direction === 'incoming' &&
              e.method === request.method &&
              (e.url === address.href || e.request_headers['x-abele-step'] === id) &&
              e.started >= writer.startedAt + at - 5 &&
              e.started <= this.now()
          )
          if (
            !matches.some((e) => e.request_headers['x-abele-step'] === id) &&
            matches.length !== 1
          )
            return undefined
          confirmed = true
          const exact = matches.filter((e) => e.request_headers['x-abele-step'] === id)
          if (exact.length === 1 && l.httpSteps.has(exact[0]!.id))
            return l.httpSteps.get(exact[0]!.id)
        }
        return writer.append({
          kind: 'http',
          at,
          label: step.label,
          ...(step.status !== undefined ? { status: step.status } : {}),
          ...(step.host ? { host: step.host } : {}),
          chain: id,
          sent: true,
          ...(request ? { direction: 'incoming' as const } : {}),
          values: step.values.map((v) =>
            v.text !== undefined
              ? writer.value(v.name, v.text)
              : writer.failed(v.name, v.failed ?? 'Not taken')
          ),
        }).id
      },
    }
  }

  /** Whether a run is being written now, in any session. */
  isRecording(run: string) {
    return [...this.live.values()].some((l) => l.writer?.id === run)
  }

  /** Lets queued captures finish; for tests and shutdown. */
  async settled(session: string) {
    await this.live.get(session)?.queue
  }

  async flushHttp(session: string) {
    const l = this.live.get(session)
    if (!l) return
    await l.queue
    l.httpPoll?.()
    await l.queue
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
    const snapshot = l.session.snapshot
    if (terminal[snapshot.lifecycle]) return
    const points = this.pointCopies(l, snapshot)
    try {
      if (l.writer) {
        l.writer.updatePoints(points)
        return
      }
      if (!points.length) return
      l.startedAt = this.now()
      l.writer = this.host.storeFor(snapshot).create({
        session: l.session.id,
        started: new Date(l.startedAt),
        points,
      })
      this.startHttp(l, l.writer)
    } catch (error) {
      this.host.log?.('[trace] Could not start a run', error)
    }
  }

  private detach(l: Live, state: 'done' | 'cut') {
    if (this.live.get(l.session.id) !== l) return
    this.live.delete(l.session.id)
    l.off()
    this.finish(l, state)
  }

  private finish(l: Live, state: 'done' | 'cut') {
    const writer = l.writer
    l.writer = undefined
    l.httpOff?.()
    l.httpOff = undefined
    l.httpPoll = undefined
    l.http = []
    l.httpSteps.clear()
    l.chains.clear()
    if (writer)
      l.queue = l.queue
        .then(() => {
          if (!writer.discardEmpty()) writer.close(state, this.now() - writer.startedAt)
        })
        .catch((error) => this.host.log?.('[trace] Could not close the run', error))
  }

  private startHttp(l: Live, writer: TraceRunWriter) {
    let stopped = false
    let installed = false
    let busy = false
    const drain = async (count: number) => {
      for (let i = 0; i < count; i++) {
        const events = await l.session.traceHttp('drain')
        if (!events.length) break
        for (const e of events) {
          l.http.push(e)
          if (l.http.length > 256) l.http.shift()
          const url = new URL(e.url)
          const correlation = e.request_headers['x-abele-step']
          const pending =
            typeof correlation === 'string' ? l.chains.get(correlation)?.request : undefined
          const sent = e.direction === 'incoming' && pending?.method === e.method
          const recorded = writer.append({
            kind: 'http',
            at: e.started - writer.startedAt,
            label: `${e.method} ${url.pathname}${url.search}`,
            host: url.host,
            ...(e.status !== undefined ? { status: e.status } : {}),
            chain: sent ? correlation! : e.id,
            ...(sent ? { sent: true } : {}),
            direction: e.direction,
            duration_ms: Math.max(0, e.ended - e.started),
            values: [
              writer.value(
                'request',
                JSON.stringify({
                  method: e.method,
                  url: e.url,
                  headers: e.request_headers,
                  body: e.request_body,
                  truncated: !!e.request_truncated,
                })
              ),
              writer.value('response', e.response_body),
              writer.value(
                'http',
                JSON.stringify({
                  direction: e.direction,
                  started_at: new Date(e.started).toISOString(),
                  duration_ms: e.ended - e.started,
                  headers: e.response_headers,
                  truncated: !!e.response_truncated,
                  ...(e.error ? { error: e.error } : {}),
                })
              ),
            ],
          })
          l.httpSteps.set(e.id, recorded.id)
          if (l.httpSteps.size > 256) l.httpSteps.delete(l.httpSteps.keys().next().value!)
        }
      }
    }
    const poll = () => {
      if (busy || stopped) return
      busy = true
      l.queue = l.queue
        .then(async () => {
          if (stopped) return
          if (!installed) {
            await l.session.traceHttp('install')
            installed = true
          }
          await drain(16)
        })
        .catch((error) => {
          installed = false
          this.host.log?.('[trace] Program HTTP capture unavailable', error)
        })
        .finally(() => {
          busy = false
        })
    }
    const timer = setInterval(poll, 200)
    timer.unref()
    l.httpPoll = poll
    l.httpOff = () => {
      stopped = true
      clearInterval(timer)
      l.queue = l.queue
        .then(async () => {
          if (installed && !l.session.dap.closed) {
            try {
              await l.session.traceHttp('finish')
              await drain(128)
            } finally {
              await l.session.traceHttp('stop')
            }
          }
        })
        .catch((error) => this.host.log?.('[trace] Could not remove HTTP hooks', error))
    }
    poll()
  }

  private observe(l: Live) {
    if (this.live.get(l.session.id) !== l) return
    const snapshot = l.session.snapshot
    const end = terminal[snapshot.lifecycle]
    if (end) return this.detach(l, end)
    // A breakpoint that arrives after its record point starts the run too.
    this.ensureRun(l)
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
        const writer = l.writer
        const chain = [...l.chains.entries()].pop()
        if (chain) chain[1].steps++
        const configuration = l.configuration
        const current = (resuming = false) => {
          const now = l.session.snapshot
          return (
            this.live.get(l.session.id) === l &&
            l.configuration === configuration &&
            now.incarnation === snapshot.incarnation &&
            now.stop_epoch === snapshot.stop_epoch + (resuming ? 1 : 0) &&
            now.breakpoint_revision === snapshot.breakpoint_revision &&
            now.threads.some(
              (t) => t.thread_id === id && t.status === (resuming ? 'unknown' : 'stopped')
            )
          )
        }
        l.queue = l.queue
          .then(() =>
            this.capture(l, id, points as TracePoint[], stoppedAt, current, writer, chain)
          )
          .catch((error) => this.host.log?.('[trace] Could not record the stop', error))
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

  private async capture(
    l: Live,
    thread: number,
    points: TracePoint[],
    stoppedAt: number,
    current: (resuming?: boolean) => boolean,
    writer?: TraceRunWriter,
    chain?: [string, { steps: number }]
  ) {
    if (!current()) return
    if (!writer) {
      this.ensureRun(l)
      writer = l.writer
    }
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
        [...takes].map(([name, expression]) => ({ name, expression })),
        10,
        () => {
          if (!current()) throw new Error('trace_capture_stale')
        }
      )
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      this.host.log?.('[trace] Record point could not be read', error)
    }
    const resumedAt = this.now()
    if (!current()) return
    try {
      await l.session.continue(thread, false, () => {
        if (!current(true)) throw new Error('trace_capture_stale')
      })
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
    // Under the request out now, the newest when several are: placed by time, not proven.
    const http = l.http
      .filter((e) => e.started <= stoppedAt && e.ended >= stoppedAt)
      .sort((a, b) =>
        a.direction === b.direction ? b.started - a.started : a.direction === 'incoming' ? -1 : 1
      )[0]
    writer.append({
      kind: 'probe',
      at: stoppedAt - writer.startedAt,
      ...(chain || http ? { chain: chain?.[0] ?? http!.id, by_time: true } : {}),
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
