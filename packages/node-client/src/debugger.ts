import {
  DebuggerMethodSchemas,
  DebuggerControlMethodSchemas,
  DebuggerSnapshotResultSchema,
  DebuggerSnapshotSchema,
  DebuggerReplayResultSchema,
  DebuggerReceiptSchema,
  DebuggerWaitResultSchema,
  DebuggerAttachProgramSchema,
  DebuggerProgramsResultSchema,
  DebuggerProgramsSchema,
  DebuggerStartSchema,
  DebuggerStartResultSchema,
  DebuggerAddSourcesSchema,
  DebuggerAddSourcesResultSchema,
  type DebuggerSnapshot,
  DebuggerVariablesResultSchema,
  DebuggerAccessRequestSchema,
  DebuggerGrantSchema,
} from '@abele/node-protocol'

/** Parse requested_data from a completed variables history entry. Child handles
 * expire when the stop changes; refresh scopes after stale_handle. */
export const parseDebuggerVariables = (data: unknown) => DebuggerVariablesResultSchema.parse(data)

type Methods = typeof DebuggerMethodSchemas
type Input<M extends keyof Methods> = Methods[M]['_input']
type Command =
  | 'pause'
  | 'continue'
  | 'step'
  | 'breakpoints.patch'
  | 'exceptionBreakpoints.set'
  | 'variables'
  | 'evaluate'
  | 'setVariable'
  | 'detach'
  | 'terminate'
export type DebuggerObservationState = {
  observation: 'current' | 'last-known' | 'unknown'
  snapshot: DebuggerSnapshot | null
  reason?: 'connection_lost'
}
/** Human channel client, not an agent permission bridge. Plugin-agent tools must
 * use a trusted run-bound DebuggerToolBridge, never reuse an owner's RPC identity.
 * All debugger calls are online-only; uncertain commands are never resent. */
export class DebuggerClient {
  async accessRequests() {
    return DebuggerAccessRequestSchema.array()
      .max(128)
      .parse(await this.rpc('debugger.v1.access.requests', {}))
  }
  async decideAccess(request_id: string, decision: 'allow' | 'deny') {
    const method = 'debugger.v1.access.decide'
    return this.rpc(method, DebuggerControlMethodSchemas[method].parse({ request_id, decision }))
  }
  async grants(
    params: (typeof DebuggerControlMethodSchemas)['debugger.v1.grant.list']['_input'] = {}
  ) {
    return DebuggerGrantSchema.array()
      .max(16)
      .parse(
        await this.rpc(
          'debugger.v1.grant.list',
          DebuggerControlMethodSchemas['debugger.v1.grant.list'].parse(params)
        )
      )
  }
  revokeGrant(grant_id: string) {
    return this.rpc(
      'debugger.v1.grant.revoke',
      DebuggerControlMethodSchemas['debugger.v1.grant.revoke'].parse({ grant_id })
    )
  }
  deleteGrant(grant_id: string) {
    return this.rpc(
      'debugger.v1.grant.delete',
      DebuggerControlMethodSchemas['debugger.v1.grant.delete'].parse({ grant_id })
    )
  }
  private readonly states = new Map<string, DebuggerObservationState>()
  private readonly watchers = new Map<AbortController, () => void>()
  private generation = 0
  constructor(private readonly rpc: (method: string, params: unknown) => Promise<unknown>) {}
  current(session: string): DebuggerObservationState {
    return structuredClone(this.states.get(session) ?? { observation: 'unknown', snapshot: null })
  }
  private observed(snapshot: DebuggerSnapshot, generation: number) {
    const existing = this.states.get(snapshot.debug_session_id)
    // Event sequence remains monotonic across target replacement/recovery. An
    // older response must not resurrect a stop already superseded by a watch.
    if (existing?.snapshot && existing.snapshot.event_seq > snapshot.event_seq) return
    if (generation !== this.generation && existing?.observation === 'current') return
    if (!this.states.has(snapshot.debug_session_id) && this.states.size >= 128)
      this.states.delete(this.states.keys().next().value!)
    this.states.set(snapshot.debug_session_id, {
      observation:
        generation !== this.generation || snapshot.lifecycle === 'connection-lost'
          ? 'last-known'
          : 'current',
      snapshot,
      ...(snapshot.lifecycle === 'connection-lost' ? { reason: 'connection_lost' as const } : {}),
    })
  }
  disconnected() {
    this.generation++
    for (const state of this.states.values()) {
      state.observation = state.snapshot ? 'last-known' : 'unknown'
      state.reason = 'connection_lost'
    }
    for (const [watcher, notify] of this.watchers) {
      if (watcher.signal.aborted) continue
      watcher.abort() // mark loss before callback; reentrant disconnect cannot notify twice
      try {
        notify()
      } catch {} // one UI observer must not suppress other loss notifications
    }
  }
  async status(debug_session_id: string) {
    const generation = this.generation
    try {
      const result = DebuggerSnapshotResultSchema.parse(
        await this.rpc('debugger.v1.status', { debug_session_id })
      )
      this.observed(result.snapshot, generation)
      return result
    } catch (error) {
      const old = this.states.get(debug_session_id)
      this.states.set(debug_session_id, {
        observation: old?.snapshot ? 'last-known' : 'unknown',
        snapshot: old?.snapshot ?? null,
      })
      throw error
    }
  }
  async replay(params: Input<'debugger.v1.replay'>) {
    const result = DebuggerReplayResultSchema.parse(
      await this.rpc(
        'debugger.v1.replay',
        DebuggerMethodSchemas['debugger.v1.replay'].parse(params)
      )
    )
    // Even a complete event page is not substituted for a current snapshot.
    await this.status(params.cursor.debug_session_id)
    return result
  }
  /** Starts a program of a chat's folder under the debugger; the owner's act, never resent. */
  async start(params: (typeof DebuggerStartSchema)['_input']) {
    return DebuggerStartResultSchema.parse(
      await this.rpc('debugger.v1.start', DebuggerStartSchema.parse(params))
    )
  }
  /** Admits files opened after startup. Owner-only, online-only. */
  async addSources(params: (typeof DebuggerAddSourcesSchema)['_input']) {
    return DebuggerAddSourcesResultSchema.parse(
      await this.rpc('debugger.v1.addSources', DebuggerAddSourcesSchema.parse(params))
    )
  }
  /** Node.js programs on the node's machine waiting for a debugger on loopback, for a chat. */
  async programs(owner: string | (typeof DebuggerProgramsSchema)['_input']) {
    return DebuggerProgramsResultSchema.parse(
      await this.rpc(
        'debugger.v1.programs',
        DebuggerProgramsSchema.parse(typeof owner === 'string' ? { conversation_id: owner } : owner)
      )
    )
  }
  async sessions(params: Input<'debugger.v1.sessions'>) {
    return DebuggerSnapshotSchema.array()
      .max(128)
      .parse(
        await this.rpc(
          'debugger.v1.sessions',
          DebuggerMethodSchemas['debugger.v1.sessions'].parse(params)
        )
      )
  }
  async restart(params: (typeof DebuggerControlMethodSchemas)['debugger.v1.restart']['_input']) {
    return DebuggerStartResultSchema.parse(
      await this.rpc(
        'debugger.v1.restart',
        DebuggerControlMethodSchemas['debugger.v1.restart'].parse(params)
      )
    )
  }
  /** Attaches to one of them; the owner's act, never resent. Detaching leaves it running. */
  async attach(params: (typeof DebuggerAttachProgramSchema)['_input']) {
    return DebuggerStartResultSchema.parse(
      await this.rpc('debugger.v1.attachProgram', DebuggerAttachProgramSchema.parse(params))
    )
  }
  async command<M extends Command>(method: M, params: Input<`debugger.v1.${M}`>) {
    await this.status(params.debug_session_id)
    const generation = this.generation
    const schema = DebuggerControlMethodSchemas[`debugger.v1.${method}`]
    try {
      const result = DebuggerReceiptSchema.parse(
        await this.rpc(`debugger.v1.${method}`, schema.parse(params))
      )
      this.observed(result.snapshot, generation)
      return result
    } catch (error) {
      const current = this.states.get(params.debug_session_id)
      if (current) current.observation = current.snapshot ? 'last-known' : 'unknown'
      throw error // reconcile the durable receipt, never repeat the effect
    }
  }
  async wait(params: Input<'debugger.v1.wait'>) {
    const generation = this.generation
    const result = DebuggerWaitResultSchema.parse(
      await this.rpc('debugger.v1.wait', DebuggerMethodSchemas['debugger.v1.wait'].parse(params))
    )
    if (result.snapshot) this.observed(result.snapshot, generation)
    else if (generation === this.generation)
      this.states.set(params.debug_session_id, { observation: 'unknown', snapshot: null })
    return result
  }
  async sleep(params: Input<'debugger.v1.sleep'>) {
    const generation = this.generation
    const result = DebuggerWaitResultSchema.parse(
      await this.rpc('debugger.v1.sleep', DebuggerMethodSchemas['debugger.v1.sleep'].parse(params))
    )
    if (result.snapshot) this.observed(result.snapshot, generation)
    else if (generation === this.generation)
      this.states.set(params.debug_session_id, { observation: 'unknown', snapshot: null })
    return result
  }
  cancelWait(params: Input<'debugger.v1.cancelWait'>) {
    return this.rpc(
      'debugger.v1.cancelWait',
      DebuggerMethodSchemas['debugger.v1.cancelWait'].parse(params)
    )
  }
  /** A cancellable cursor watch, independent of follow-up chat input. It only
   * updates the caller's observation callback, never starts a model turn. */
  async watch(
    session: string,
    notify: (state: DebuggerObservationState) => void,
    signal: AbortSignal
  ) {
    const watcher = new AbortController()
    this.watchers.set(watcher, () => {
      if (!signal.aborted) notify({ ...this.current(session), reason: 'connection_lost' })
    })
    const cancelled = AbortSignal.any([signal, watcher.signal])
    let wait_id: string | undefined
    const cancel = () => {
      if (wait_id) void this.cancelWait({ debug_session_id: session, wait_id }).catch(() => {})
    }
    cancelled.addEventListener('abort', cancel, { once: true })
    try {
      let { snapshot, cursor } = await this.status(session)
      if (cancelled.aborted) return
      notify(this.current(session))
      while (
        !cancelled.aborted &&
        !['connection-lost', 'terminated', 'detached', 'failed'].includes(snapshot.lifecycle)
      ) {
        wait_id = crypto.randomUUID()
        const result = await this.wait({
          debug_session_id: session,
          incarnation: cursor.incarnation,
          after_event_seq: cursor.event_seq,
          wait_id,
          kinds: [
            'stopped',
            'continued',
            'thread',
            'threads',
            'invalidated',
            'lifecycle',
            'execution_intent',
            'target_replaced',
            'breakpoints_patch',
            'breakpoints_pending',
            'breakpoints_result',
            'capabilities',
            'control_pending',
          ],
          timeout_ms: 60000,
        })
        wait_id = undefined
        if (cancelled.aborted) return
        notify(this.current(session))
        if (!result.snapshot || ['cancelled', 'connection_lost'].includes(result.reason)) return
        snapshot = result.snapshot
        cursor = {
          debug_session_id: session,
          incarnation: snapshot.incarnation,
          event_seq: snapshot.event_seq,
        }
      }
    } catch (error) {
      if (!cancelled.aborted) {
        this.disconnected()
        throw error
      }
    } finally {
      cancel()
      cancelled.removeEventListener('abort', cancel)
      this.watchers.delete(watcher)
    }
  }
}
