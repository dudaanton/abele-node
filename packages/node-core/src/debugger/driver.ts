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

const nonnegative = (n: unknown): n is number =>
  typeof n === 'number' && Number.isSafeInteger(n) && n >= 0
const positive = (n: unknown): n is number => nonnegative(n) && n > 0
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
  line: number
  column: number
}
type Scope = { name: string; handle: string | null; expensive: boolean }
type Variable = { name: string; value: string; type?: string; handle: string | null }

/** Trusted internal driver, NOT an authority boundary or a public arbitrary-DAP
 * API. DapDebuggerBackend installs the coordinator's physical dispatch fence.
 * Every child owns a distinct reducer, incarnation and opaque reference namespace. */
export class DapSession {
  readonly id: string
  readonly incarnation: string
  private capabilities: Record<string, any> = {}
  private readonly breakpointIds = new Map<number, { id: string; revision: number }>()
  private readonly frameThreads = new Map<string, number>()
  private readonly objectThreads = new Map<string, number>()
  private lastEpoch = -1
  private readonly sentSources = new Set<string>()
  private ending: 'detached' | 'terminated' | undefined
  private owner: DebugProcessOwner | undefined
  private started = false
  private initialized = false
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
  constructor(
    private readonly service: DebuggerService,
    state: DebuggerSnapshot,
    readonly dap: DapTransport,
    readonly sources: ReadonlyMap<string, string>
  ) {
    if (!service.enabled) throw new Error('debugger_disabled')
    this.id = state.debug_session_id
    this.incarnation = state.incarnation
    dap.onEvent((event) => this.event(event))
    dap.onClose(() => {
      this.frameThreads.clear()
      this.objectThreads.clear()
      if (!this.ending && live(this.snapshot))
        this.observe({ kind: 'lifecycle', lifecycle: 'connection-lost' })
    })
  }
  get snapshot() {
    return this.service.snapshot(this.id).snapshot
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
      if (this.snapshot.lifecycle === 'configuring')
        this.observe({ kind: 'lifecycle', lifecycle: 'active' })
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
        const requested = state.breakpoints.filter((bp) => bp.source_id === source)
        this.sentSources.add(source)
        const body = await this.dap.requestWhenAvailable(
          'setBreakpoints',
          {
            source: { path: this.sources.get(source) },
            breakpoints: requested.map((bp) => ({
              line: bp.line,
              ...(bp.column === undefined ? {} : { column: bp.column }),
              ...(bp.condition === undefined ? {} : { condition: bp.condition }),
              ...(bp.log_message === undefined ? {} : { logMessage: bp.log_message }),
            })),
            sourceModified: false,
          },
          {
            signal: controller.signal,
            beforeDispatch: () => {
              this.current()
            },
          }
        )
        const results = list(body.breakpoints)
        if (results.length !== requested.length) throw new Error('dap_breakpoint_count')
        if (!live(this.snapshot)) return
        if (this.snapshot.breakpoint_revision === revision) {
          for (const [id, bp] of this.breakpointIds)
            if (
              state.breakpoints.find((r) => r.breakpoint_id === bp.id)?.source_id === source ||
              !state.breakpoints.some((r) => r.breakpoint_id === bp.id)
            )
              this.breakpointIds.delete(id)
          results.forEach((result, i) => {
            if (positive(result.id))
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
        if (!positive(t.id) || typeof t.name !== 'string') throw new Error('dap_invalid_body')
        return { id: t.id, name: boundedText(t.name, 256) }
      }),
    })
    return this.snapshot
  }
  async stack(thread: number, start = 0, count = 50, maxBytes = 8192): Promise<Page<Frame>> {
    paging(start, count)
    byteLimit(maxBytes)
    const before = this.stopped(thread)
    const body = await this.request('stackTrace', {
      threadId: thread,
      startFrame: start,
      levels: count,
    })
    this.fence(before)
    const frames = list(body.stackFrames, 1024),
      items: Frame[] = []
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
      const source = [...this.sources].find(([, path]) => path === frame.source?.path)?.[0] ?? null
      const item: Frame = {
        handle: 'a'.repeat(48),
        name: boundedText(frame.name, 256),
        source_id: source,
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
      item.handle = this.objectHandle(variable.variablesReference, thread)
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
    const before = this.expressionIntent()
    const body = await this.request('evaluate', { frameId, expression, context: 'repl' })
    if (typeof body.result !== 'string') throw new Error('dap_invalid_body')
    return {
      value: boundedText(body.result, 4096),
      truncated: Buffer.byteLength(body.result) > 4096,
      observation_stop_epoch: before.stop_epoch,
      source_identity: before.target.build_identity,
    }
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
    // A depth is an upper bound, not permission to execute additional getters.
    // Unknown/effectful profiles return one explicit flat page and never recurse
    // or export child references after the expression intent expires handles.
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
  async continue(thread: number, singleThread = false) {
    return this.execute(thread, 'continue', 'continue', singleThread)
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
    singleThread: boolean
  ) {
    const before = this.stopped(thread)
    this.service.executionIntent(this.id, this.incarnation, before.state_revision, action)
    this.admission?.advanceIntent()
    this.frameThreads.clear()
    this.objectThreads.clear()
    await this.request(command, { threadId: thread, singleThread })
    return this.snapshot
  }
  async pause(thread: number) {
    this.current()
    if (!positive(thread)) throw new Error('invalid_thread')
    await this.request('pause', { threadId: thread })
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
      // Never let an adapter choose what to kill. Direct node-owned OS evidence,
      // not disconnect/terminate success, establishes process termination.
      let disconnectError: unknown
      try {
        await this.dap.request('disconnect', { terminateDebuggee: false, suspendDebuggee: false })
      } catch (error) {
        disconnectError = error
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
  private event(event: DebugProtocol.Event) {
    if (!live(this.snapshot) || this.ending) return
    const body = event.body ?? {}
    switch (event.event) {
      case 'initialized':
        this.initialized = true
        break
      case 'stopped':
        this.observe({
          kind: 'stopped',
          ...(positive(body.threadId) ? { thread_id: body.threadId } : {}),
          all_threads_stopped: body.allThreadsStopped === true,
          reason: typeof body.reason === 'string' ? boundedText(body.reason, 256) : 'unknown',
          ...(typeof body.description === 'string'
            ? { description: boundedText(body.description, 4096) }
            : {}),
          hit_breakpoint_ids: Array.isArray(body.hitBreakpointIds)
            ? body.hitBreakpointIds
                .slice(0, 256)
                .map((id: number) => this.breakpointIds.get(id)?.id ?? String(id).slice(0, 128))
            : [],
        })
        break
      case 'continued':
        this.observe({
          kind: 'continued',
          ...(positive(body.threadId) ? { thread_id: body.threadId } : {}),
          all_threads_continued: body.allThreadsContinued === true,
        })
        break
      case 'thread':
        if (!positive(body.threadId) || !['started', 'exited'].includes(body.reason))
          throw new Error('dap_invalid_body')
        this.observe({ kind: 'thread', thread_id: body.threadId, reason: body.reason })
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
        this.observe({ kind: 'invalidated' })
        break
      case 'terminated':
        this.observe({ kind: 'lifecycle', lifecycle: 'terminated' })
        this.dap.close()
        break
      case 'breakpoint': {
        const breakpoint = body.breakpoint,
          mapped = this.breakpointIds.get(breakpoint?.id)
        if (mapped && this.snapshot.breakpoint_revision === mapped.revision)
          this.observe({
            kind: 'breakpoints_result',
            revision: mapped.revision,
            results: [this.breakpointResult(mapped.id, breakpoint)],
          })
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
      // process/exited events are not execution or OS ownership proof.
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
  private readonly pendingIds = new Set<string>()
  private closed = false
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
    const equal =
      Object.keys(config).length === Object.keys(coverage.configuration).length &&
      Object.keys(config).every(
        (key) => JSON.stringify(config[key]) === JSON.stringify(coverage.configuration[key])
      )
    if (
      !equal ||
      typeof pending !== 'string' ||
      !pending ||
      pending.length > 128 ||
      this.pendingIds.has(pending) ||
      this.pendingIds.size >= coverage.maxChildren
    )
      throw new Error('reverse_request_denied')
    this.service.assertEffectsAvailable()
    this.pendingIds.add(pending)
    let dap: DapTransport | undefined
    try {
      dap = await this.connect(signal)
      if (signal.aborted || this.closed) throw new Error('reverse_request_denied')
      const state = this.service.create({
        ...this.root.snapshot.target,
        target_id: this.root.snapshot.target.target_id + ':child:' + this.pendingIds.size,
        process_ownership: 'unknown',
        process_evidence: undefined,
      })
      const child = new DapSession(this.service, state, dap, this.root.sources)
      this.children.set(child.id, child)
      await child.start(coverage.mode, { ...config, __pendingTargetId: pending }, signal)
      if (signal.aborted || this.closed) throw new Error('reverse_request_denied')
      return {}
    } catch (error) {
      dap?.close()
      throw error
    }
  }
  close() {
    this.closed = true
    for (const child of this.children.values()) child.dap.close()
    this.root.dap.close()
  }
}
