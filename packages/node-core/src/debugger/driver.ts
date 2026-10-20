import type { DebugProtocol } from '@vscode/debugprotocol'
import { ChannelError } from '@abele/channel-protocol'
import type {
  DebuggerSnapshot,
  DebuggerObservation,
  DebuggerBreakpointRequest,
} from '@abele/node-protocol'
import type { DebuggerDispatchGuard } from './coordinator.js'
import { DebuggerService, DebuggerStateError } from './index.js'
import { DapTransport, DAP_LIMITS } from './dap.js'
import type { DebugProcessOwner } from './process.js'
import { boundedText } from './storage.js'
import { debuggerLog } from './log.js'
import {
  programHttpInstall,
  programHttpDrain,
  programHttpStop,
  type ProgramHttpEvent,
} from '../trace/program-http.js'
import {
  CAPTURE_MAX_CHARS,
  captureChunk,
  captureEnd,
  captureStart,
  decode,
  readChunk,
  readLength,
} from '../trace/capture.js'

const nonnegative = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
const positive = (n: unknown): n is number => nonnegative(n) && n > 0
/** DAP lets an adapter name a thread 0, and js-debug names a Node program's thread so; debugger.v1
 * counts threads from 1. Thread 0 travels as the largest id, which no adapter may use itself. */
const THREAD_ZERO = Number.MAX_SAFE_INTEGER
const dapThread = (n: unknown): n is number => nonnegative(n) && n !== THREAD_ZERO
const fromDap = (n: number) => (n === 0 ? THREAD_ZERO : n)
const toDap = (n: number) => (n === THREAD_ZERO ? 0 : n)
function list(value: unknown, limit = 256): any[] {
  if (
    !Array.isArray(value) ||
    value.length > limit ||
    value.some((v) => typeof v !== 'object' || !v)
  )
    throw new Error('dap_invalid_body')
  return value
}
function paging(start: number, count: number) {
  if (
    !Number.isSafeInteger(start) ||
    start < 0 ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > 100
  )
    throw new Error('invalid_paging')
}
function byteLimit(bytes: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 2 || bytes > 8192)
    throw new Error('invalid_byte_limit')
}
const live = (s: DebuggerSnapshot) =>
  !['terminated', 'detached', 'failed', 'connection-lost'].includes(s.lifecycle)
type Page<T> = { items: T[]; truncated: boolean; snapshot: DebuggerSnapshot }
type Frame = {
  handle: string
  name: string
  source_id: string | null
  path?: string
  relative_path?: string
  line: number
  column: number
}
type Scope = { name: string; handle: string | null; expensive: boolean }
type Variable = { name: string; value: string; type?: string; handle: string | null }
/** What a record point's stop gave: where the program stood and each value whole or why not. */
export type RecordedStop = {
  frames: { name: string; path?: string; line: number }[]
  values: { name: string; text?: string; string?: boolean; error?: string }[]
}

/** Trusted internal driver, NOT an authority boundary or a public arbitrary-DAP
 * API. DapDebuggerBackend installs the coordinator's physical dispatch fence.
 * Every child owns a distinct reducer, incarnation and opaque reference namespace. */
export class DapSession {
  readonly id: string
  readonly incarnation: string
  private capabilities: Record<string, any> = {}
  private readonly breakpointIds = new Map<number, { id: string; revision: number }>()
  private readonly installedBreakpoints = new Map<string, { signature: string; results: any[] }>()
  private breakpointSyncs = 0
  private readonly deferredStops = new Map<
    number | undefined,
    { event: DebugProtocol.Event; revision: number }
  >()
  private readonly frameThreads = new Map<string, number>()
  private readonly objectThreads = new Map<string, number>()
  private lastEpoch = -1
  private readonly sentSources = new Set<string>()
  private ending: 'detached' | 'terminated' | undefined
  private owner: DebugProcessOwner | undefined
  /** A session tree keeps its root transport until its independently connected children end. */
  onTerminated?: () => void
  private started = false
  private initialized = false
  private traceHttpInstalled = false
  private admission: DebuggerDispatchGuard | undefined
  /** Only the shared coordinator may install this trusted dispatch fence. */
  async coordinated<T>(guard: DebuggerDispatchGuard, work: () => Promise<T>): Promise<T> {
    if (this.admission) throw new ChannelError('coordinator_conflict')
    this.admission = guard
    try {
      return await work()
    } finally {
      this.admission = undefined
    }
  }
  private readonly sourcePaths = new Map<string, string>()
  readonly sources: ReadonlyMap<string, string> = this.sourcePaths
  private readonly stepping = new Set<number>()
  resolveFrameSources?: (
    paths: string[]
  ) => Promise<Map<string, { source_id: string; path: string }>>
  /** Trusted launch coordinator admission, shared with future child sessions. */
  admitSources(sources: ReadonlyMap<string, string>) {
    for (const [id, path] of sources) {
      if (this.sourcePaths.has(id) && this.sourcePaths.get(id) !== path)
        throw new ChannelError('debugger_source_conflict')
      this.sourcePaths.set(id, path)
    }
  }
  constructor(
    private readonly service: DebuggerService,
    state: DebuggerSnapshot,
    readonly dap: DapTransport,
    sources: ReadonlyMap<string, string>
  ) {
    this.admitSources(sources)
    if (!service.enabled) throw new Error('debugger_disabled')
    this.id = state.debug_session_id
    this.incarnation = state.incarnation
    dap.onEvent((event) => this.event(event))
    dap.onClose((error) => {
      debuggerLog('DAP closed', () => ({
        session: this.id,
        incarnation: this.incarnation,
        lifecycle: this.snapshot.lifecycle,
        execution: this.snapshot.execution,
        stop_epoch: this.snapshot.stop_epoch,
        ending: this.ending,
        reason: error.message,
      }))
      this.frameThreads.clear()
      this.objectThreads.clear()
      if (!this.ending && live(this.snapshot))
        this.observe({ kind: 'lifecycle', lifecycle: 'connection-lost' })
    })
  }
  get snapshot() {
    return this.service.snapshot(this.id).snapshot
  }
  /** Host process evidence may arrive after the adapter's terminated event. */
  recordExit(code: number) {
    if (!Number.isSafeInteger(code)) return
    this.observe({ kind: 'exited', exit_code: code })
  }
  markEntryPause() {
    const before = this.current()
    if (before.selected_thread_id !== null)
      this.observe({
        kind: 'stop_details',
        thread_id: before.selected_thread_id,
        stop_epoch: before.stop_epoch,
        reason: 'entry',
        description: 'Paused at program startup',
      })
  }
  private observe(event: DebuggerObservation) {
    const state = this.service.observe(this.id, this.incarnation, event)
    if (state.stop_epoch !== this.lastEpoch) {
      this.frameThreads.clear()
      this.objectThreads.clear()
      this.lastEpoch = state.stop_epoch
    }
    return state
  }
  private request(
    command: string,
    args: object = {},
    options: Parameters<DapTransport['request']>[2] = {}
  ) {
    this.service.assertEffectsAvailable()
    this.admission?.()
    return this.dap.request(command, args, options)
  }
  private current(cleanup = false) {
    this.admission?.()
    if (!cleanup) this.service.assertEffectsAvailable()
    const state = this.snapshot
    if (state.incarnation !== this.incarnation) throw new DebuggerStateError('stale_state', state)
    if (!live(state) || this.ending || this.dap.closed) throw new Error('session_not_live')
    if (state.stop_epoch !== this.lastEpoch) {
      this.frameThreads.clear()
      this.objectThreads.clear()
      this.lastEpoch = state.stop_epoch
    }
    return state
  }
  private stopped(thread: number) {
    const state = this.current()
    if (state.threads.find((t) => t.thread_id === thread)?.status !== 'stopped')
      throw new DebuggerStateError('not_stopped', state)
    return state
  }
  private fence(before: DebuggerSnapshot) {
    const now = this.current()
    if (now.state_revision !== before.state_revision || now.stop_epoch !== before.stop_epoch)
      throw new DebuggerStateError('stale_state', now)
    return now
  }
  async start(
    mode: 'launch' | 'attach',
    configuration: Record<string, unknown>,
    signal?: AbortSignal
  ) {
    this.current()
    if (this.started) throw new Error('session_already_started')
    this.started = true
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    try {
      this.capabilities = await this.request(
        'initialize',
        {
          clientID: 'abele-node',
          adapterID: 'pwa-node',
          linesStartAt1: true,
          columnsStartAt1: true,
          pathFormat: 'path',
          supportsVariablePaging: true,
          supportsRunInTerminalRequest: false,
          supportsStartDebuggingRequest: true,
        },
        { signal: controller.signal }
      )
      this.observe({
        kind: 'capabilities',
        capabilities: Object.entries(this.capabilities)
          .filter(([name, v]) => name.startsWith('supports') && v === true)
          .map(([name]) => name)
          .slice(0, 128),
      })
      this.dap.supportsCancellation = this.capabilities.supportsCancelRequest === true
      // Observe both promises immediately. An early start failure aborts in-flight
      // configuration, not an unobserved rejection or an indefinitely waiting task.
      const start = this.request(
        mode,
        { ...configuration, request: mode },
        { signal: controller.signal }
      )
      const configure = this.configure(controller.signal)
      await Promise.all([start, configure])
      if (this.snapshot.lifecycle === 'configuring') {
        // A completed attach is running unless the adapter already reported a stop.
        // Do not overwrite stopped/continued events received during configuration.
        if (mode === 'attach') this.observe({ kind: 'continued', all_threads_continued: true })
        else this.observe({ kind: 'lifecycle', lifecycle: 'active' })
      }
      return this.snapshot
    } catch (error) {
      controller.abort()
      try {
        if (live(this.snapshot)) this.observe({ kind: 'lifecycle', lifecycle: 'failed' })
      } finally {
        this.dap.close()
      }
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }
  private waitForInitialized(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Error('dap_cancelled'))
    if (this.initialized) return Promise.resolve()
    return new Promise((resolve, reject) => {
      let offEvent = () => {},
        offClose = () => {}
      const finish = (error?: Error) => {
        clearTimeout(timer)
        offEvent()
        offClose()
        signal.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve()
      }
      const abort = () => finish(new Error('dap_cancelled'))
      const timer = setTimeout(
        () => finish(new Error('dap_initialized_timeout')),
        DAP_LIMITS.requestTimeoutMs
      )
      offEvent = this.dap.onEvent((event) => {
        if (event.event === 'initialized') finish()
      })
      signal.addEventListener('abort', abort, { once: true })
      offClose = this.dap.onClose((error) => finish(error))
      if (signal.aborted) abort()
    })
  }
  private async configure(signal: AbortSignal) {
    await this.waitForInitialized(signal)
    await this.syncBreakpoints(signal)
    await this.request('setExceptionBreakpoints', { filters: [] }, { signal })
    if (this.capabilities.supportsConfigurationDoneRequest)
      await this.request('configurationDone', {}, { signal })
  }
  async patchBreakpoints(revision: number, upsert: DebuggerBreakpointRequest[], remove: string[]) {
    const s = this.current()
    if (s.target.build_identity !== 'matched') throw new ChannelError('build_identity_unverified')
    for (const bp of upsert) {
      if (!this.sources.has(bp.source_id)) throw new ChannelError('unknown_source')
      if (bp.enabled === false) continue
      if (bp.hit_condition !== undefined && !this.capabilities.supportsHitConditionalBreakpoints)
        throw new ChannelError('unsupported_operation')
      if (bp.condition !== undefined && !this.capabilities.supportsConditionalBreakpoints)
        throw new ChannelError('unsupported_operation')
      if (bp.log_message !== undefined && !this.capabilities.supportsLogPoints)
        throw new ChannelError('unsupported_operation')
    }
    this.service.patchBreakpoints(this.id, revision, upsert, remove)
    this.admission?.advanceIntent()
    return this.syncBreakpoints()
  }
  async syncBreakpoints(signal?: AbortSignal) {
    const state = this.current(),
      revision = state.breakpoint_revision
    const sourceIds = new Set([...this.sentSources, ...state.breakpoints.map((bp) => bp.source_id)])
    for (const source of sourceIds) if (!this.sources.has(source)) throw new Error('unknown_source')
    if (sourceIds.size > 256) throw new Error('source_limit')
    this.observe({ kind: 'breakpoints_pending', revision })
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    const sources = sourceIds.values()
    const worker = async () => {
      while (!controller.signal.aborted) {
        const next = sources.next()
        if (next.done) return
        const source = next.value
        const requested = state.breakpoints.filter(
          (bp) => bp.source_id === source && bp.enabled !== false
        )
        const breakpoints = requested.map((bp) => ({
          line: bp.line,
          ...(bp.column === undefined ? {} : { column: bp.column }),
          ...(bp.condition === undefined ? {} : { condition: bp.condition }),
          ...(bp.hit_condition === undefined ? {} : { hitCondition: bp.hit_condition }),
          ...(bp.log_message === undefined ? {} : { logMessage: bp.log_message }),
        }))
        const signature = JSON.stringify(breakpoints)
        const installed = this.installedBreakpoints.get(source)
        this.sentSources.add(source)
        // Keep a confirmed source set installed when only another source changes.
        // Besides preserving ids, this avoids js-debug's empty reply for an identical set.
        let results: any[]
        if (installed?.signature === signature) results = installed.results
        else {
          this.installedBreakpoints.delete(source)
          const body = await this.dap.requestWhenAvailable(
            'setBreakpoints',
            {
              source: { path: this.sources.get(source) },
              breakpoints,
              sourceModified: false,
            },
            {
              signal: controller.signal,
              beforeDispatch: () => {
                this.current()
              },
            }
          )
          results = list(body.breakpoints)
        }
        if (results.length !== requested.length) throw new Error('dap_breakpoint_count')
        results = results.map((result, i) => ({
          ...this.breakpointResult(requested[i]!.breakpoint_id, result),
          ...(nonnegative(result.id) ? { id: result.id } : {}),
        }))
        if (!live(this.snapshot)) return
        if (this.snapshot.breakpoint_revision === revision) {
          this.installedBreakpoints.set(source, { signature, results })
          for (const [id, bp] of this.breakpointIds)
            if (
              state.breakpoints.find((r) => r.breakpoint_id === bp.id)?.source_id === source ||
              !state.breakpoints.some((r) => r.breakpoint_id === bp.id)
            )
              this.breakpointIds.delete(id)
          results.forEach((result, i) => {
            if (nonnegative(result.id))
              this.breakpointIds.set(result.id, { id: requested[i]!.breakpoint_id, revision })
          })
        }
        this.observe({
          kind: 'breakpoints_result',
          revision,
          results: results.map((r, i) => this.breakpointResult(requested[i]!.breakpoint_id, r)),
        })
      }
      throw new Error('dap_cancelled')
    }
    // Do not materialize 256 simultaneous requests. Capacity admission is shared
    // by the connection, including an outstanding launch and overlapping batches.
    this.breakpointSyncs++
    const workers = Array.from(
      { length: Math.min(4, this.dap.pendingLimit, sourceIds.size) },
      worker
    )
    try {
      await Promise.all(workers)
    } catch (error) {
      controller.abort()
      await Promise.allSettled(workers)
      throw error
    } finally {
      signal?.removeEventListener('abort', abort)
      if (--this.breakpointSyncs === 0) {
        const stops = [...this.deferredStops.values()]
        this.deferredStops.clear()
        for (const { event, revision: stoppedRevision } of stops) {
          // A stop from superseded intent stays a user-visible stop, never an
          // automatic recording hit correlated through a newer adapter id.
          this.event(
            stoppedRevision === this.snapshot.breakpoint_revision
              ? event
              : {
                  ...event,
                  body: { ...event.body, hitBreakpointIds: [] },
                }
          )
        }
      }
    }
    return this.snapshot
  }
  private breakpointResult(id: string, result: any) {
    if (typeof result.verified !== 'boolean') throw new Error('dap_invalid_body')
    return {
      breakpoint_id: id,
      verified: result.verified,
      ...(positive(result.line) ? { line: result.line } : {}),
      ...(positive(result.column) ? { column: result.column } : {}),
      ...(typeof result.message === 'string' ? { message: boundedText(result.message, 4096) } : {}),
    }
  }
  async exceptionBreakpoints(filters: ('all' | 'uncaught')[]) {
    this.current()
    if (
      filters.length > 2 ||
      filters.some((v) => !['all', 'uncaught'].includes(v)) ||
      new Set(filters).size !== filters.length
    )
      throw new Error('invalid_exception_filters')
    await this.request('setExceptionBreakpoints', { filters })
    return this.snapshot
  }
  async threads() {
    const before = this.current()
    const body = await this.request('threads')
    this.current()
    this.observe({
      kind: 'threads',
      inventory_revision: before.thread_inventory_revision,
      threads: list(body.threads).map((t) => {
        if (!dapThread(t.id) || typeof t.name !== 'string') throw new Error('dap_invalid_body')
        return { id: fromDap(t.id), name: boundedText(t.name, 256) }
      }),
    })
    return this.snapshot
  }
  async stack(thread: number, start = 0, count = 50, maxBytes = 8192): Promise<Page<Frame>> {
    paging(start, count)
    byteLimit(maxBytes)
    const before = this.stopped(thread)
    const body = await this.request('stackTrace', {
      threadId: toDap(thread),
      startFrame: start,
      levels: count,
    })
    this.fence(before)
    const frames = list(body.stackFrames, 1024),
      items: Frame[] = []
    const resolved = await this.resolveFrameSources?.([
      ...new Set(
        frames
          .slice(0, count)
          .map((f) => f.source?.path)
          .filter((p): p is string => typeof p === 'string')
      ),
    ])
    this.fence(before)
    let truncated =
      frames.length > count ||
      (typeof body.totalFrames === 'number' &&
        body.totalFrames > start + Math.min(frames.length, count))
    for (const frame of frames.slice(0, count)) {
      if (
        !Number.isSafeInteger(frame.id) ||
        frame.id < 0 ||
        !(frame.source === undefined ? nonnegative(frame.line) : positive(frame.line)) ||
        !(frame.source === undefined ? nonnegative(frame.column) : positive(frame.column)) ||
        typeof frame.name !== 'string'
      )
        throw new Error('dap_invalid_body')
      const source =
        resolved?.get(frame.source?.path)?.source_id ??
        [...this.sources].find(([, path]) => path === frame.source?.path)?.[0] ??
        null
      const item: Frame = {
        handle: 'a'.repeat(48),
        name: boundedText(frame.name, 256),
        source_id: source,
        ...(resolved?.has(frame.source?.path)
          ? { relative_path: resolved.get(frame.source.path)!.path }
          : {}),
        ...(typeof frame.source?.path === 'string'
          ? { path: boundedText(frame.source.path, 4096) }
          : {}),
        line: frame.line,
        column: frame.column,
      }
      if (Buffer.byteLength(JSON.stringify([...items, item])) > maxBytes) {
        truncated = true
        break
      }
      item.handle = this.service.issueHandle(this.id, 'frame', frame.id, thread)
      this.frameThreads.set(item.handle, thread)
      items.push(item)
    }
    return { items, truncated, snapshot: this.snapshot }
  }
  async scopes(frameHandle: string, maxBytes = 8192): Promise<Page<Scope>> {
    byteLimit(maxBytes)
    const reference = this.service.resolveHandle(this.id, frameHandle, 'frame'),
      thread = this.frameThreads.get(frameHandle)
    if (!thread) throw new DebuggerStateError('stale_handle', this.snapshot)
    const before = this.stopped(thread),
      body = await this.request('scopes', { frameId: reference })
    this.fence(before)
    const scopes = list(body.scopes, 100)
    const items: Scope[] = []
    let truncated = false
    for (const scope of scopes) {
      if (
        typeof scope.name !== 'string' ||
        !Number.isSafeInteger(scope.variablesReference) ||
        scope.variablesReference < 0 ||
        typeof scope.expensive !== 'boolean'
      )
        throw new Error('dap_invalid_body')
      const item: Scope = {
        name: boundedText(scope.name, 256),
        handle: scope.variablesReference ? 'a'.repeat(48) : null,
        expensive: scope.expensive,
      }
      if (Buffer.byteLength(JSON.stringify([...items, item])) > maxBytes) {
        truncated = true
        break
      }
      item.handle = this.objectHandle(scope.variablesReference, thread)
      items.push(item)
    }
    return { items, truncated, snapshot: this.snapshot }
  }
  async breakpointLocations(
    source: string,
    line: number,
    endLine: number,
    column?: number,
    endColumn?: number
  ) {
    const before = this.current()
    const path = this.sources.get(source)
    if (!path) throw new ChannelError('unknown_source')
    if (!positive(line) || !positive(endLine) || endLine < line || endLine - line > 1000)
      throw new ChannelError('invalid_params')
    if (!this.capabilities.supportsBreakpointLocationsRequest)
      throw new ChannelError('unsupported_operation')
    const body = await this.request('breakpointLocations', {
      source: { path },
      line,
      endLine,
      ...(column === undefined ? {} : { column }),
      ...(endColumn === undefined ? {} : { endColumn }),
    })
    this.fence(before)
    const raw = list(body.breakpoints, 4096)
    const items = raw.slice(0, 256).map((point) => {
      if (
        !positive(point.line) ||
        (point.column !== undefined && !positive(point.column)) ||
        point.line < line ||
        point.line > endLine
      )
        throw new Error('dap_invalid_body')
      return {
        line: point.line as number,
        ...(point.column === undefined ? {} : { column: point.column as number }),
        ...(positive(point.endLine) ? { end_line: point.endLine as number } : {}),
        ...(positive(point.endColumn) ? { end_column: point.endColumn as number } : {}),
      }
    })
    while (Buffer.byteLength(JSON.stringify(items)) > 7000) items.pop()
    return { items, truncated: items.length < raw.length, snapshot: this.snapshot }
  }
  async sourceStatus(source: string, line: number, endLine: number) {
    const before = this.current()
    const path = this.sources.get(source)
    if (!path) throw new ChannelError('unknown_source')
    let loaded: boolean | null = null
    if (this.capabilities.supportsLoadedSourcesRequest) {
      const body = await this.request('loadedSources')
      this.fence(before)
      loaded = list(body.sources, 16384).some((s) => s.path === path)
    }
    if (loaded === false || !this.capabilities.supportsBreakpointLocationsRequest)
      return {
        loaded,
        known: loaded === false,
        items: [],
        truncated: false,
        snapshot: this.snapshot,
      }
    const page = await this.breakpointLocations(source, line, endLine)
    return { ...page, loaded, known: true }
  }
  private objectHandle(reference: number, thread: number) {
    if (!reference) return null
    const handle = this.service.issueHandle(this.id, 'object', reference, thread)
    this.objectThreads.set(handle, thread)
    return handle
  }
  /** Inspection is explicit-only, not claimed universally side-effect-free. No
   * evaluate/getter fallback, recursion, formatter or automatic variable capture. */
  async variables(handle: string, start = 0, count = 50, maxBytes = 8192): Promise<Page<Variable>> {
    paging(start, count)
    byteLimit(maxBytes)
    const reference = this.service.resolveHandle(this.id, handle, 'object'),
      thread = this.objectThreads.get(handle)
    if (!thread) throw new DebuggerStateError('stale_handle', this.snapshot)
    // supportsVariablePaging is a CLIENT initialize capability, not an adapter
    // capability. Always request an explicit bounded page, including page zero.
    const before = this.stopped(thread),
      body = await this.request('variables', {
        variablesReference: reference,
        start,
        count,
      })
    this.fence(before)
    const variables = list(body.variables, 4096),
      items: Variable[] = []
    let truncated = variables.length > count
    for (const variable of variables.slice(0, count)) {
      if (
        typeof variable.name !== 'string' ||
        typeof variable.value !== 'string' ||
        !Number.isSafeInteger(variable.variablesReference) ||
        variable.variablesReference < 0
      )
        throw new Error('dap_invalid_body')
      const item: Variable = {
        name: boundedText(variable.name, 256),
        value: boundedText(variable.value, Math.min(maxBytes, 4096)),
        handle: null,
        ...(typeof variable.type === 'string' ? { type: boundedText(variable.type, 256) } : {}),
      }
      if (item.value !== variable.value || item.name !== variable.name) truncated = true
      // Reserve the fixed opaque-handle overhead before minting an object handle.
      const preview = { ...item, handle: variable.variablesReference ? 'a'.repeat(48) : null }
      if (Buffer.byteLength(JSON.stringify([...items, preview])) > maxBytes) {
        truncated = true
        break
      }
      item.handle =
        variable.presentationHint?.lazy === true
          ? null
          : this.objectHandle(variable.variablesReference, thread)
      items.push(item)
    }
    return { items, truncated, snapshot: this.snapshot }
  }
  /** Separately exact-approved operations. References are resolved BEFORE the
   * potential-effect intent expires handles. Returned values are inert evidence,
   * never new live object references while execution certainty is unknown. */
  private expressionIntent() {
    const before = this.current()
    this.service.executionIntent(this.id, this.incarnation, before.state_revision, 'evaluate')
    this.admission?.advanceIntent()
    this.frameThreads.clear()
    this.objectThreads.clear()
    return before
  }
  async evaluate(frameHandle: string, expression: string) {
    const frameId = this.service.resolveHandle(this.id, frameHandle, 'frame')
    const thread = this.frameThreads.get(frameHandle)
    const before = this.expressionIntent()
    const body = await this.request('evaluate', { frameId, expression, context: 'repl' })
    if (typeof body.result !== 'string') throw new Error('dap_invalid_body')
    // A successful stack read is positive evidence that this thread remains paused.
    // Never overwrite a stop/continue event that overtook the evaluation or probe.
    const intent = this.current()
    if (thread && intent.execution === 'unknown' && intent.stop_epoch === before.stop_epoch + 1) {
      try {
        const probe = await this.request('stackTrace', {
          threadId: toDap(thread),
          startFrame: 0,
          levels: 1,
        })
        const now = this.current()
        if (
          list(probe.stackFrames, 1024).length &&
          now.stop_epoch === intent.stop_epoch &&
          now.thread_inventory_revision === intent.thread_inventory_revision &&
          now.execution === 'unknown'
        ) {
          this.observe({
            kind: 'stopped',
            thread_id: thread,
            all_threads_stopped: before.all_threads_status === 'stopped',
            reason: before.threads.find((t) => t.thread_id === thread)?.stop?.reason ?? 'pause',
            hit_breakpoint_ids: [],
          })
        }
      } catch {
        // A failed probe proves neither running nor stopped; keep execution unknown.
      }
    }
    return {
      value: boundedText(body.result, 4096),
      truncated: Buffer.byteLength(body.result) > 4096,
      observation_stop_epoch: before.stop_epoch,
      source_identity: before.target.build_identity,
    }
  }
  /** Trusted recording infrastructure, never a client-supplied expression or an issued handle. */
  async traceHttp(operation: 'install' | 'drain' | 'finish' | 'stop'): Promise<ProgramHttpEvent[]> {
    const expression =
      operation === 'install'
        ? programHttpInstall
        : operation === 'drain'
          ? programHttpDrain
          : operation === 'finish'
            ? `globalThis.__abeleProgramHttpV1?.stop(); 'ok'`
            : programHttpStop
    const body = await this.request(
      'evaluate',
      { expression, context: 'repl' },
      { timeoutMs: 2000 }
    )
    if (operation === 'install') this.traceHttpInstalled = true
    if (operation === 'stop') this.traceHttpInstalled = false
    if (operation !== 'drain') return []
    if (typeof body.result !== 'string') throw new Error('dap_invalid_body')
    const encoded = body.result.trim().replace(/^['"`]|['"`]$/g, '')
    if (!/^[A-Za-z0-9+/=]*$/.test(encoded)) throw new Error('trace_http_invalid_data')
    const events = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
    if (!Array.isArray(events) || events.length > 1) throw new Error('trace_http_invalid_data')
    return events as ProgramHttpEvent[]
  }

  /** Trusted node-internal recording of a record point's stop, never routed to clients: the
   * top frames and each take evaluated whole in the top frame, in chunks the transport can carry.
   * The takes were approved when the point was set. No client handles are issued. Only what the
   * point names is taken: with no takes nothing is read beyond the frames. */
  async recordStop(
    thread: number,
    takes: { name: string; expression: string }[],
    levels = 10,
    guard?: () => void
  ): Promise<RecordedStop> {
    guard?.()
    const before = this.stopped(thread)
    const check = () => {
      const now = this.fence(before)
      if (now.breakpoint_revision !== before.breakpoint_revision)
        throw new DebuggerStateError('stale_state', now)
      guard?.()
    }
    const body = await this.request('stackTrace', {
      threadId: toDap(thread),
      startFrame: 0,
      levels,
    })
    check()
    const raw = list(body.stackFrames, 1024).slice(0, levels)
    const frames = raw.map((f) => ({
      name: boundedText(typeof f.name === 'string' ? f.name : '', 256),
      ...(typeof f.source?.path === 'string' ? { path: boundedText(f.source.path, 4096) } : {}),
      line: nonnegative(f.line) ? f.line : 0,
    }))
    const frameId = raw[0]?.id
    if (!Number.isSafeInteger(frameId))
      return { frames, values: takes.map((t) => ({ name: t.name, error: 'No frame to read' })) }
    // These are executable capture expressions. js-debug advertises clipboard support but
    // rejects these evaluations in that context; repl also preserves their string results.
    const context = 'repl'
    const evaluate = async (expression: string) => {
      check()
      const r = await this.request('evaluate', { frameId, expression, context })
      // Someone else moved the session meanwhile: the frame is no longer the one recorded.
      check()
      if (typeof r.result !== 'string') throw new Error('dap_invalid_body')
      return r.result as string
    }
    const values: RecordedStop['values'] = []
    for (const take of takes) {
      const key = `k${Math.random().toString(36).slice(2, 10)}`
      try {
        const length = readLength(await evaluate(captureStart(take.expression, key)))
        if (length > CAPTURE_MAX_CHARS) throw new Error(`Too large to take: ${length} characters`)
        let text = ''
        for (let at = 0; at < length;) {
          const chunk = readChunk(await evaluate(captureChunk(key, at)), at)
          text += chunk.text
          at = chunk.end
        }
        values.push({ name: take.name, ...decode(text) })
      } catch (error) {
        values.push({
          name: take.name,
          error: boundedText(error instanceof Error ? error.message : String(error), 512),
        })
      } finally {
        await evaluate(captureEnd(key)).catch(() => undefined)
      }
    }
    return { frames, values }
  }
  async setVariable(handle: string, name: string, value: string) {
    if (!this.capabilities.supportsSetVariable) throw new ChannelError('unsupported_operation')
    const variablesReference = this.service.resolveHandle(this.id, handle, 'object')
    const before = this.expressionIntent()
    const body = await this.request('setVariable', { variablesReference, name, value })
    if (typeof body.value !== 'string') throw new Error('dap_invalid_body')
    return {
      value: boundedText(body.value, 4096),
      truncated: Buffer.byteLength(body.value) > 4096,
      observation_stop_epoch: before.stop_epoch,
    }
  }
  async approvedVariables(handle: string, start = 0, count = 50, maxBytes = 8192, depth = 1) {
    paging(start, count)
    byteLimit(maxBytes)
    if (!Number.isInteger(depth) || depth < 0 || depth > 3) throw new Error('invalid_depth')
    // Fixed native configuration has no custom generators. Ordinary pages
    // preserve the stop; lazy getter references are never exported.
    if (this.snapshot.target.adapter_profile === 'js-ts-native') {
      const before = this.snapshot
      const page = await this.variables(handle, start, count, maxBytes)
      return {
        items: page.items.map((item) => ({ ...item, handle: depth > 0 ? item.handle : null })),
        truncated: page.truncated,
        start,
        count,
        next: page.truncated || page.items.length >= count ? start + page.items.length : null,
        depth_limit: depth,
        expansion_depth: 0,
        observation_stop_epoch: before.stop_epoch,
      }
    }
    const variablesReference = this.service.resolveHandle(this.id, handle, 'object')
    const before = this.expressionIntent()
    const body = await this.request('variables', { variablesReference, start, count })
    const variables = list(body.variables, 4096)
    const items: { name: string; value: string }[] = []
    let truncated = variables.length > count
    for (const v of variables.slice(0, count)) {
      if (typeof v.name !== 'string' || typeof v.value !== 'string')
        throw new Error('dap_invalid_body')
      const item = { name: boundedText(v.name, 256), value: boundedText(v.value, 4096) }
      if (item.name !== v.name || item.value !== v.value) truncated = true
      if (Buffer.byteLength(JSON.stringify([...items, item])) > maxBytes) {
        truncated = true
        break
      }
      items.push(item)
    }
    // Unknown profiles retain conservative invalidation and export no children.
    return {
      items,
      truncated,
      start,
      count,
      next: truncated || variables.length >= count ? start + items.length : null,
      depth_limit: depth,
      expansion_depth: 0,
      observation_stop_epoch: before.stop_epoch,
    }
  }
  async continue(thread: number, singleThread = false, beforeDispatch?: () => void) {
    return this.execute(thread, 'continue', 'continue', singleThread, beforeDispatch)
  }
  async step(thread: number, kind: 'over' | 'in' | 'out', singleThread = false) {
    const command = { over: 'next', in: 'stepIn', out: 'stepOut' }[kind]
    if (!command) throw new Error('invalid_step')
    return this.execute(thread, command, 'step', singleThread)
  }
  private async execute(
    thread: number,
    command: string,
    action: 'continue' | 'step',
    singleThread: boolean,
    beforeDispatch?: () => void
  ) {
    const before = this.stopped(thread)
    this.service.executionIntent(this.id, this.incarnation, before.state_revision, action)
    this.admission?.advanceIntent()
    this.frameThreads.clear()
    this.objectThreads.clear()
    if (action === 'step') this.stepping.add(thread)
    else if (singleThread) this.stepping.delete(thread)
    else this.stepping.clear()
    try {
      await this.request(command, { threadId: toDap(thread), singleThread }, { beforeDispatch })
    } catch (error) {
      this.stepping.delete(thread)
      throw error
    }
    return this.snapshot
  }
  async pause(thread?: number | null) {
    this.current()
    this.stepping.clear()
    if (thread == null) {
      // Discover a target without publishing an inventory change mid-command:
      // that would invalidate the coordinator's physical dispatch fence.
      const body = await this.request('threads')
      this.current()
      const threads = list(body.threads)
      if (threads.some((t) => !dapThread(t.id) || typeof t.name !== 'string'))
        throw new Error('dap_invalid_body')
      if (!threads.length) throw new ChannelError('thread_required')
      // DAP requires a thread even for a program-wide pause. Use the first
      // adapter thread; the stopped event selects the actual stopped thread.
      thread = fromDap(threads[0].id)
    }
    if (!positive(thread)) throw new Error('invalid_thread')
    await this.request('pause', { threadId: toDap(thread) })
    return this.snapshot
  }
  setOwner(owner: DebugProcessOwner) {
    if (this.owner) throw new Error('process_owner_already_set')
    this.owner = owner
  }
  async detach() {
    return this.end('detached')
  }
  async terminate() {
    if (!this.owner) throw new Error('process_not_owned')
    return this.end('terminated')
  }
  private async end(lifecycle: 'detached' | 'terminated') {
    this.current(true)
    this.ending = lifecycle
    try {
      // An externally owned program can keep running after disconnect.
      if (this.traceHttpInstalled) await this.traceHttp('stop').catch(() => {})
      // Never let an adapter choose what to kill. Direct node-owned OS evidence,
      // not disconnect/terminate success, establishes process termination.
      let disconnectError: unknown
      try {
        await this.dap.request('disconnect', { terminateDebuggee: false, suspendDebuggee: false })
      } catch (error) {
        // Closed while it was asked to let go: that is the detach. js-debug ends a run's root as
        // its program's session goes, and the root closes the session before it answers.
        const closed = this.dap.closed && error instanceof Error && error.message === 'dap_closed'
        if (!(lifecycle === 'detached' && closed)) disconnectError = error
      }
      // Owned cleanup is independent of transport success and journal availability.
      if (lifecycle === 'terminated') await this.owner!.terminate()
      if (disconnectError) throw disconnectError
      this.observe({ kind: 'lifecycle', lifecycle })
      return this.snapshot
    } catch (error) {
      if (live(this.snapshot)) this.observe({ kind: 'lifecycle', lifecycle: 'connection-lost' })
      throw error
    } finally {
      this.dap.close()
    }
  }
  private hitBreakpoints(raw: unknown): string[] {
    if (!Array.isArray(raw)) return []
    const points = raw.slice(0, 256).map((id) => this.breakpointIds.get(id))
    // Unknown or mixed hits remain ordinary stops. A numeric adapter id must
    // never impersonate a logical record-point id with the same spelling.
    return points.every((bp) => bp?.revision === this.snapshot.breakpoint_revision)
      ? points.map((bp) => bp!.id)
      : []
  }
  private event(event: DebugProtocol.Event) {
    if (!live(this.snapshot) || this.ending) return
    const body = event.body ?? {}
    switch (event.event) {
      case 'initialized':
        this.initialized = true
        break
      case 'stopped': {
        this.deferredStops.delete(body.threadId)
        if (
          this.breakpointSyncs &&
          Array.isArray(body.hitBreakpointIds) &&
          body.hitBreakpointIds.length
        ) {
          if (this.deferredStops.size >= 256) throw new Error('dap_pending_stops_limit')
          this.deferredStops.set(body.threadId, {
            event,
            revision: this.snapshot.breakpoint_revision,
          })
          break
        }
        const stepped =
          dapThread(body.threadId) &&
          this.stepping.delete(fromDap(body.threadId)) &&
          ['breakpoint', 'step', 'pause'].includes(body.reason) &&
          !body.hitBreakpointIds?.length
        if (body.allThreadsStopped === true) this.stepping.clear()
        this.observe({
          kind: 'stopped',
          ...(dapThread(body.threadId) ? { thread_id: fromDap(body.threadId) } : {}),
          all_threads_stopped: body.allThreadsStopped === true,
          reason: stepped
            ? 'step'
            : typeof body.reason === 'string'
              ? boundedText(body.reason, 256)
              : 'unknown',
          ...(stepped
            ? { description: 'Paused after a step' }
            : typeof body.text === 'string' || typeof body.description === 'string'
              ? {
                  description: boundedText(
                    typeof body.text === 'string' ? body.text : body.description,
                    4096
                  ),
                }
              : {}),
          hit_breakpoint_ids: this.hitBreakpoints(body.hitBreakpointIds),
        })
        if (
          this.capabilities.supportsExceptionInfoRequest &&
          dapThread(body.threadId) &&
          ['exception', 'promise rejection'].includes(body.reason)
        ) {
          const before = this.snapshot
          void this.request('exceptionInfo', { threadId: body.threadId })
            .then((info) => {
              const now = this.snapshot
              if (
                now.incarnation !== this.incarnation ||
                now.stop_epoch !== before.stop_epoch ||
                !live(now)
              )
                return
              const type = info.details?.typeName ?? info.exceptionId
              const message = info.details?.message ?? info.description
              const description = [type, message]
                .filter((part) => typeof part === 'string' && part)
                .join(': ')
              if (description)
                this.observe({
                  kind: 'stop_details',
                  thread_id: fromDap(body.threadId),
                  stop_epoch: before.stop_epoch,
                  description: boundedText(description, 4096),
                })
            })
            .catch(() => {})
        }
        break
      }
      case 'continued':
        if (body.allThreadsContinued === true || body.threadId === undefined)
          this.deferredStops.clear()
        else this.deferredStops.delete(body.threadId)
        this.observe({
          kind: 'continued',
          ...(dapThread(body.threadId) ? { thread_id: fromDap(body.threadId) } : {}),
          all_threads_continued: body.allThreadsContinued === true,
        })
        break
      case 'thread':
        if (body.reason === 'exited' && dapThread(body.threadId))
          this.stepping.delete(fromDap(body.threadId))
        if (body.reason === 'exited') this.deferredStops.delete(body.threadId)
        if (!dapThread(body.threadId) || !['started', 'exited'].includes(body.reason))
          throw new Error('dap_invalid_body')
        this.observe({ kind: 'thread', thread_id: fromDap(body.threadId), reason: body.reason })
        break
      case 'output':
        if (typeof body.output !== 'string') throw new Error('dap_invalid_body')
        this.observe({
          kind: 'output',
          text: boundedText(body.output, 256 * 1024),
          category: typeof body.category === 'string' ? boundedText(body.category, 256) : 'console',
        })
        break
      case 'invalidated':
        this.deferredStops.clear()
        this.observe({ kind: 'invalidated' })
        break
      case 'exited':
        if (Number.isSafeInteger(body.exitCode))
          this.observe({ kind: 'exited', exit_code: body.exitCode })
        break
      case 'terminated':
        this.stepping.clear()
        this.deferredStops.clear()
        this.observe({ kind: 'lifecycle', lifecycle: 'terminated' })
        if (this.onTerminated) this.onTerminated()
        else this.dap.close()
        break
      case 'breakpoint': {
        const breakpoint = body.breakpoint,
          mapped = this.breakpointIds.get(breakpoint?.id)
        if (mapped && this.snapshot.breakpoint_revision === mapped.revision) {
          const result = this.breakpointResult(mapped.id, breakpoint)
          for (const installed of this.installedBreakpoints.values())
            installed.results = installed.results.map((entry) =>
              entry.id === breakpoint.id ? { ...result, id: breakpoint.id } : entry
            )
          this.observe({
            kind: 'breakpoints_result',
            revision: mapped.revision,
            results: [result],
          })
        }
        break
      }
      case 'capabilities':
        if (body.capabilities && typeof body.capabilities === 'object') {
          this.capabilities = { ...this.capabilities, ...body.capabilities }
          this.observe({
            kind: 'capabilities',
            capabilities: Object.entries(this.capabilities)
              .filter(([key, v]) => key.startsWith('supports') && v === true)
              .map(([key]) => key)
              .slice(0, 128),
          })
        }
        break
      // A process event is not execution or OS ownership proof.
    }
  }
}

type ChildCoverage = {
  mode: 'launch' | 'attach'
  configuration: Record<string, unknown>
  maxChildren: number
}
/** Reverse requests have no implicit authority. B2 supports only an exact covered
 * child configuration plus the adapter's pending-target token; terminal launches,
 * grandchildren and unknown reverse requests remain denied. */
export class JsSessionTree {
  readonly children = new Map<string, DapSession>()
  private readonly childListeners = new Set<(child: DapSession) => void>()
  /** Each child as the adapter starts it, before its first event. */
  onChild(listener: (child: DapSession) => void) {
    this.childListeners.add(listener)
    return () => void this.childListeners.delete(listener)
  }
  private readonly pendingIds = new Set<string>()
  private closed = false
  private startingChildren = 0
  constructor(
    private readonly service: DebuggerService,
    readonly root: DapSession,
    private readonly connect: (signal: AbortSignal) => Promise<DapTransport>,
    private readonly coverage?: ChildCoverage
  ) {
    if (
      coverage &&
      (!Number.isSafeInteger(coverage.maxChildren) ||
        coverage.maxChildren < 1 ||
        coverage.maxChildren > 8)
    )
      throw new Error('invalid_child_limit')
    root.onTerminated = () => this.closeEndedRoot()
    root.dap.onClose(() => this.close())
  }
  async reverse(request: DebugProtocol.Request, signal: AbortSignal): Promise<object> {
    const args = request.arguments,
      coverage = this.coverage
    if (
      this.closed ||
      signal.aborted ||
      request.command !== 'startDebugging' ||
      !coverage ||
      args?.request !== coverage.mode ||
      !args.configuration ||
      typeof args.configuration !== 'object'
    )
      throw new Error('reverse_request_denied')
    const { __pendingTargetId: pending, ...config } = args.configuration
    const keys = Object.keys(config)
    const equal =
      keys.length === Object.keys(coverage.configuration).length &&
      keys.every(
        (key) => JSON.stringify(config[key]) === JSON.stringify(coverage.configuration[key])
      )
    // The pinned js-debug names its child by the parent's type and a display name
    // only, and resolves the rest from the pending target it already holds.
    const named =
      keys.length === 2 &&
      config.type === coverage.configuration.type &&
      typeof config.name === 'string' &&
      config.name.length <= 128
    if (
      !(equal || named) ||
      typeof pending !== 'string' ||
      !pending ||
      pending.length > 128 ||
      this.pendingIds.has(pending) ||
      this.pendingIds.size >= coverage.maxChildren
    )
      throw new Error('reverse_request_denied')
    this.service.assertEffectsAvailable()
    this.pendingIds.add(pending)
    ++this.startingChildren
    let dap: DapTransport | undefined
    try {
      dap = await this.connect(signal)
      if (signal.aborted || this.closed) throw new Error('reverse_request_denied')
      const state = this.service.create({
        ...this.root.snapshot.target,
        target_id: this.root.snapshot.target.target_id + ':child:' + this.pendingIds.size,
        // A child of a run attached to someone else's program is that program: still not ours.
        process_ownership:
          this.root.snapshot.target.process_ownership === 'external' ? 'external' : 'unknown',
        process_evidence: undefined,
      })
      const child = new DapSession(this.service, state, dap, this.root.sources)
      this.children.set(child.id, child)
      dap.onClose(() => this.closeEndedRoot())
      for (const listener of [...this.childListeners]) listener(child)
      await child.start(coverage.mode, { ...config, __pendingTargetId: pending }, signal)
      if (signal.aborted || this.closed) throw new Error('reverse_request_denied')
      return {}
    } catch (error) {
      dap?.close()
      throw error
    } finally {
      --this.startingChildren
      this.closeEndedRoot()
    }
  }
  private closeEndedRoot() {
    if (this.closed || this.startingChildren) return
    // The broker can end before the child sends its first stop or final event.
    // Only transport loss, or all children ending, closes their shared tree.
    if (
      this.root.snapshot.lifecycle === 'terminated' &&
      [...this.children.values()].every((child) => child.dap.closed)
    )
      this.root.dap.close()
  }
  close() {
    this.closed = true
    for (const child of this.children.values()) child.dap.close()
    this.root.dap.close()
  }
}
