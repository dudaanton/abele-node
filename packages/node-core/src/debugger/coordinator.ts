import { createHash } from 'node:crypto'
import { ChannelError, LIMITS, type AuthorityContext } from '@abele/channel-protocol'
import {
  DEBUGGER_LIMITS,
  DebuggerMethodSchemas,
  DebuggerControlMethodSchemas,
  DebuggerApprovalSchema,
  DebuggerReceiptSchema,
  type DebuggerSnapshot,
  type DebuggerHistoryInput,
  type DebuggerBreakpointRequest,
  type DebuggerGrant,
} from '@abele/node-protocol'
import { canonical, type NodeCore } from '../index.js'
import { DebuggerStateError } from './index.js'
import { DebuggerPermissions, type DebuggerPrincipal, type DebuggerAction } from './permissions.js'
import { boundedPayload } from './storage.js'
import { DebuggerHistoryStore } from './history.js'
import { DebuggerWaits } from './wait.js'
import { DapDebuggerBackend } from './dap-backend.js'

export type { DebuggerPrincipal } from './permissions.js'
type Params = Record<string, any>
type Receipt = ReturnType<typeof DebuggerReceiptSchema.parse>
/** Trusted typed backend. It must call guard immediately before EVERY physical
 * dispatch, including after transport-slot waits. No arbitrary DAP is exposed. */
export type DebuggerDispatchGuard = (() => void) & {
  /** Trusted driver only, synchronously after its OWN durable reducer intent.
   * Adopt that revision before physical send, never after an asynchronous wait. */
  advanceIntent(): void
}
export interface DebuggerBackend {
  supports(method: string): boolean
  dispatch(method: string, params: Params, guard: DebuggerDispatchGuard): Promise<unknown>
}
type Intent = {
  principal: DebuggerPrincipal
  method: string
  params: Params
  hash: string
  stop_epoch: number
  target: DebuggerSnapshot['target']
  approved: boolean
  effective_breakpoints?: DebuggerBreakpointRequest[]
  approval_authority?: AuthorityContext
  approval_revoked?: boolean
  receipt: Omit<Receipt, 'snapshot'> & { snapshot?: DebuggerSnapshot }
}
const effects = new Set([
  'pause',
  'continue',
  'step',
  'restart',
  'breakpoints.patch',
  'exceptionBreakpoints.set',
  'evaluate',
  'setVariable',
  'detach',
  'terminate',
  'variables',
])
const actionFor = (m: string): DebuggerAction =>
  m === 'breakpoints.patch' || m === 'exceptionBreakpoints.set'
    ? 'breakpoints'
    : ['evaluate', 'setVariable', 'variables'].includes(m)
      ? 'expressions'
      : m === 'restart'
        ? 'launch'
        : (m as DebuggerAction)
const exact = (m: string, p: Params, effective?: DebuggerBreakpointRequest[]) =>
  ['evaluate', 'setVariable', 'variables'].includes(m) ||
  (m === 'breakpoints.patch' &&
    (effective ?? p.upsert).some(
      (bp: DebuggerBreakpointRequest) => bp.condition !== undefined || bp.log_message !== undefined
    ))
/** The adapter receives a complete source set, not just the incoming delta.
 * In ask mode (and for human expressions), approval covers THIS complete set,
 * even if an earlier authorized send failed before physical dispatch. */
function effectiveBreakpoints(state: DebuggerSnapshot, p: Params): DebuggerBreakpointRequest[] {
  const replaced = new Set([
    ...p.remove,
    ...p.upsert.map((bp: DebuggerBreakpointRequest) => bp.breakpoint_id),
  ])
  return state.breakpoints
    .filter((bp) => !replaced.has(bp.breakpoint_id))
    .map(
      ({
        status: _,
        resolved_line: _line,
        resolved_column: _column,
        message: _message,
        ...request
      }) => request
    )
    .concat(p.upsert)
}
const errorCode = (e: unknown) =>
  e instanceof ChannelError || e instanceof DebuggerStateError ? e.code : 'dispatch_uncertain'
const hash = (v: unknown) => createHash('sha256').update(canonical(v)).digest('hex')

/** Shared, per-session FIFO. Proposals return immediately; approval never holds
 * the command lock. Durable receipts, not the offline outbox, govern retries. */
export class DebuggerCoordinator {
  readonly permissions: DebuggerPermissions
  readonly waits: DebuggerWaits
  private readonly permissionListeners = new Set<() => void>()
  subscribePermissions(listener: () => void) {
    this.permissionListeners.add(listener)
    return () => {
      this.permissionListeners.delete(listener)
    }
  }
  notifyPermissions() {
    this.waits.refresh()
    for (const listener of [...this.permissionListeners]) {
      try {
        listener()
      } catch {}
    }
  }
  close() {
    this.waits.close()
    this.permissionListeners.clear()
  }
  wait(principal: DebuggerPrincipal, method: 'wait' | 'sleep', raw: unknown, signal?: AbortSignal) {
    this.enabled()
    return this.waits.start(principal, method, raw, signal)
  }
  private readonly backends = new Map<string, DebuggerBackend>()
  private readonly tails = new Map<string, Promise<unknown>>()
  private readonly inflight = new Map<string, Promise<Receipt>>()
  private readonly queued = new Map<string, number>()
  constructor(private readonly core: NodeCore) {
    this.permissions = new DebuggerPermissions(core)
    this.waits = new DebuggerWaits(core)
    this.recover()
  }
  private enabled() {
    if (!this.core.debugger.enabled) throw new ChannelError('unsupported_method')
  }
  principalKey(p: DebuggerPrincipal) {
    return canonical([p.kind, p.authority.installation_id, p.kind === 'agent' ? p.run_id : null])
  }
  registerBackend(session: string, backend: DebuggerBackend) {
    this.enabled()
    this.core.debugger.snapshot(session)
    this.backends.set(session, backend)
    // A DAP session records a run whenever it has record points.
    const recording =
      backend instanceof DapDebuggerBackend ? this.core.trace.attach(backend.session) : undefined
    return () => {
      if (this.backends.get(session) === backend) this.backends.delete(session)
      recording?.()
    }
  }
  createGrant(owner: AuthorityContext, raw: unknown) {
    this.enabled()
    return this.permissions.create(owner, raw)
  }
  setGrantMode(owner: AuthorityContext, id: string, mode: DebuggerGrant['mode']) {
    this.enabled()
    const grant = this.permissions.setMode(owner, id, mode)
    for (const row of this.core.db
      .prepare(
        "SELECT body FROM debug_operations WHERE json_extract(body,'$.receipt.outcome')='pending' AND json_extract(body,'$.receipt.dispatch')='not_dispatched'"
      )
      .all()) {
      const i = JSON.parse(String(row.body)) as Intent
      if (i.principal.kind !== 'agent' || i.principal.grant_id !== id || i.approval_authority)
        continue
      // Admission by mode is not an owner's exact approval. Keep its distinction
      // durable so a queued closure cannot carry allow-all authority into ask.
      i.approved = mode === 'allow-all'
      this.save(i)
      this.pending(i.params.debug_session_id)
      if (i.approved) void this.enqueue(i).catch(() => {}) // durable evidence fences failures
    }
    this.notifyPermissions()
    return grant
  }
  revokeGrant(owner: AuthorityContext, id: string) {
    this.enabled()
    this.permissions.revoke(owner, id)
    this.notifyPermissions()
    this.invalidatePending((i) => i.principal.kind === 'agent' && i.principal.grant_id === id)
  }
  settleTask(task: string, run: string) {
    this.enabled()
    this.permissions.settle(task, run)
    this.notifyPermissions()
    this.invalidatePending(
      (i) =>
        i.principal.kind === 'agent' && i.principal.task_id === task && i.principal.run_id === run
    )
  }
  /** Trusted provider lifecycle only; not an RPC/model operation. */
  settleRun(run: string) {
    if (!this.core.debugger.enabled) return
    for (const row of this.core.db
      .prepare(
        "SELECT DISTINCT json_extract(body,'$.task_id') AS task FROM debug_grants WHERE json_extract(body,'$.run_id')=?"
      )
      .all(run))
      this.settleTask(String(row.task), run)
  }
  /** Called inside the input interrupt transaction: no nested transaction or
   * external effects. Authority closes atomically with the input/receipt. */
  revokeRunInTransaction(run: string) {
    this.core.db
      .prepare(
        "UPDATE debug_grants SET body=json_set(body,'$.revoked',json('true')) WHERE json_extract(body,'$.run_id')=?"
      )
      .run(run)
  }
  interruptedRun(run: string) {
    if (!this.core.debugger.enabled) return
    this.notifyPermissions()
    this.invalidatePending((i) => i.principal.kind === 'agent' && i.principal.run_id === run)
  }
  private state(session: string) {
    return this.core.debugger.snapshot(session).snapshot
  }
  checkPublication(principal: DebuggerPrincipal, session: string, action: DebuggerAction = 'read') {
    this.enabled()
    this.permissions.authorize(principal, this.state(session), action)
  }
  private load(key: string, operation: string): Intent | undefined {
    const row = this.core.db
      .prepare('SELECT body FROM debug_operations WHERE principal_key=? AND operation_id=?')
      .get(key, operation)
    return row ? JSON.parse(String(row.body)) : undefined
  }
  private save(i: Intent, insert = false) {
    const key = this.principalKey(i.principal),
      op = i.params.operation_id
    const { snapshot: _, ...evidence } = i.receipt
    const { effective_breakpoints, ...metadata } = i
    // The current snapshot is rehydrated at response time. Deduplication needs
    // hashes/outcomes, not permanent copies of sensitive proposal arguments or
    // old breakpoint/stop snapshots outside the bounded history budget.
    const body = JSON.stringify({
      ...metadata,
      ...(i.receipt.outcome === 'pending' && effective_breakpoints !== undefined
        ? { effective_breakpoints }
        : {}),
      receipt: evidence,
      params:
        i.receipt.outcome === 'pending'
          ? i.params
          : { operation_id: op, debug_session_id: i.params.debug_session_id },
    })
    this.core.transaction(() => {
      if (insert)
        this.core.db
          .prepare('INSERT INTO debug_operations VALUES(?,?,?,?,?)')
          .run(key, op, i.params.debug_session_id, i.hash, body)
      else
        this.core.db
          .prepare(
            `UPDATE debug_operations
            SET body=CASE WHEN json_extract(body,'$.approval_revoked')=1
              THEN json_set(?,'$.approval_revoked',json('true')) ELSE ? END
            WHERE principal_key=? AND operation_id=?`
          )
          .run(body, body, key, op)
    }, true)
  }
  private actor(p: DebuggerPrincipal): DebuggerHistoryInput['actor'] {
    return p.kind === 'human'
      ? { kind: 'human', principal_id: p.authority.installation_id }
      : { kind: 'agent', principal_id: p.authority.installation_id, run_id: p.run_id }
  }
  private journal(
    i: Intent,
    outcome: DebuggerHistoryInput['outcome'],
    data?: unknown,
    actor = i.principal
  ) {
    return this.core.debugger.recordHistory(i.params.debug_session_id, {
      actor: this.actor(actor),
      operation_id: i.params.operation_id,
      operation: i.method,
      outcome,
      ...(data === undefined ? {} : { requested_data: data }),
    })
  }
  private receipt(i: Intent): Receipt {
    return DebuggerReceiptSchema.parse({
      ...i.receipt,
      snapshot: this.state(i.params.debug_session_id),
    })
  }
  private pending(session: string) {
    const intents = this.core.db
      .prepare(
        "SELECT body FROM debug_operations WHERE debug_session_id=? AND json_extract(body,'$.receipt.outcome')='pending'"
      )
      .all(session)
      .map((r) => JSON.parse(String(r.body)) as Intent)
    this.core.debugger.controlPending(
      session,
      intents.filter((i) => i.approved).map((i) => i.params.operation_id),
      intents.filter((i) => !i.approved).map((i) => i.params.operation_id)
    )
  }
  private checkApproval(i: Intent) {
    if (!i.approval_authority) return
    // A queued/in-flight closure predates revocation. Consult the durable
    // tombstone on EVERY admission; checking only the current key registration
    // would revive this exact approval after same-key re-enrollment.
    if (
      i.approval_revoked ||
      this.load(this.principalKey(i.principal), i.params.operation_id)?.approval_revoked
    )
      throw new ChannelError('approval_revoked')
    this.permissions.owner(i.approval_authority)
  }
  private preconditions(i: Intent) {
    const s = this.state(i.params.debug_session_id),
      p = i.params
    this.permissions.authorize(i.principal, s, actionFor(i.method))
    if (exact(i.method, p, i.effective_breakpoints) && i.principal.kind === 'agent')
      this.permissions.authorize(i.principal, s, 'expressions')
    this.checkApproval(i)
    if (
      s.incarnation !== p.incarnation ||
      s.state_revision !== p.expected_state_revision ||
      s.stop_epoch !== i.stop_epoch ||
      canonical(s.target) !== canonical(i.target)
    )
      throw new DebuggerStateError('stale_state', s)
    if (
      p.expected_breakpoint_revision !== undefined &&
      s.breakpoint_revision !== p.expected_breakpoint_revision
    )
      throw new DebuggerStateError('stale_breakpoints', s)
    if (['terminated', 'detached', 'failed', 'connection-lost'].includes(s.lifecycle))
      throw new ChannelError('session_not_live')
    if (i.method === 'step' || i.method === 'continue') {
      const thread = p.thread_id ?? s.selected_thread_id
      if (!thread || s.threads.find((t) => t.thread_id === thread)?.status !== 'stopped')
        throw new DebuggerStateError('not_stopped', s)
    }
    if (p.frame_handle)
      this.core.debugger.resolveHandle(s.debug_session_id, p.frame_handle, 'frame')
    if (p.handle) this.core.debugger.resolveHandle(s.debug_session_id, p.handle, 'object')
    if (i.method === 'terminate' && s.target.process_ownership !== 'owned')
      throw new ChannelError('process_not_owned')
    this.core.debugger.assertEffectsAvailable()
  }
  /** Trusted bridge reconciliation evidence only: never requested values or
   * a cached snapshot, and never a model/RPC admission surface. */
  commandEvidence(principal: DebuggerPrincipal, session: string, operation: string) {
    const i = this.load(this.principalKey(principal), operation)
    return i?.params.debug_session_id === session
      ? { dispatch: i.receipt.dispatch, outcome: i.receipt.outcome }
      : undefined
  }
  command(
    principal: DebuggerPrincipal,
    method: string,
    raw: unknown,
    onPossibleDispatch?: () => void
  ): Promise<Receipt> {
    // Promise boundary gives trusted callers a consistent rejection contract.
    return this.submit(principal, method, raw, onPossibleDispatch)
  }
  private async submit(
    principal: DebuggerPrincipal,
    method: string,
    raw: unknown,
    onPossibleDispatch?: () => void
  ): Promise<Receipt> {
    this.enabled()
    if (!effects.has(method)) throw new ChannelError('unsupported_method')
    const schema =
      DebuggerMethodSchemas[('debugger.v1.' + method) as keyof typeof DebuggerMethodSchemas]
    const parsed = schema.safeParse(raw)
    if (!parsed.success) throw new ChannelError('invalid_params')
    const p = parsed.data as Params
    if (Buffer.byteLength(JSON.stringify(p)) > DEBUGGER_LIMITS.command_bytes)
      throw new ChannelError('debugger_request_too_large')
    if (!p.operation_id) throw new ChannelError('operation_id_required')
    const s = this.state(p.debug_session_id)
    const effective = method === 'breakpoints.patch' ? effectiveBreakpoints(s, p) : undefined
    this.permissions.authorize(principal, s, actionFor(method))
    const key = this.principalKey(principal),
      requestHash = hash({ method, params: p })
    const previous = this.load(key, p.operation_id)
    const liveKey = canonical([key, p.operation_id])
    if (previous) {
      if (previous.hash !== requestHash) throw new ChannelError('idempotency_mismatch')
      return this.inflight.get(liveKey) ?? this.receipt(previous)
    }
    // Immutable retained authority prevents re-enrollment from reviving proposals.
    principal = { ...principal, authority: this.core.authority.snapshot(principal.authority) }
    const g = this.permissions.authorize(principal, s, actionFor(method))
    if (exact(method, p, effective) && principal.kind === 'agent')
      this.permissions.authorize(principal, s, 'expressions')
    if (
      Number(this.core.db.prepare('SELECT count(*) AS n FROM debug_operations').get()?.n) >=
      DEBUGGER_LIMITS.durable_receipts
    )
      throw new ChannelError('debugger_receipt_limit')
    const n = Number(
      this.core.db
        .prepare(
          "SELECT count(*) AS n FROM debug_operations WHERE debug_session_id=? AND json_extract(body,'$.receipt.outcome')='pending'"
        )
        .get(p.debug_session_id)?.n
    )
    if (n >= DEBUGGER_LIMITS.pending_commands) throw new ChannelError('debugger_pending_limit')
    const approved =
      principal.kind === 'human' ? !exact(method, p, effective) : g?.mode === 'allow-all'
    const i: Intent = {
      principal,
      method,
      params: p,
      hash: requestHash,
      stop_epoch: s.stop_epoch,
      target: s.target,
      approved,
      ...(effective === undefined ? {} : { effective_breakpoints: effective }),
      receipt: {
        operation_id: p.operation_id,
        acceptance: 'accepted',
        dispatch: 'not_dispatched',
        outcome: 'pending',
        completed_at: new Date().toISOString(),
        snapshot: s,
        proposal_hash: hash({
          principal,
          method,
          params: p,
          ...(effective === undefined ? {} : { effective_breakpoints: effective }),
          target: s.target,
          stop_epoch: s.stop_epoch,
        }),
      },
    }
    this.save(i, true) // durable intent precedes all adapter effects
    this.journal(i, 'proposed', {
      proposal_hash: i.receipt.proposal_hash,
      method,
      params: p,
      ...(effective === undefined ? {} : { effective_breakpoints: effective }),
    })
    this.pending(p.debug_session_id)
    if (!this.backends.get(p.debug_session_id)?.supports(method))
      return this.finish(i, 'rejected', 'unsupported_operation')
    try {
      this.preconditions(i)
    } catch (e) {
      return this.finish(i, 'rejected', errorCode(e))
    }
    if (!approved) return this.receipt(i)
    return this.enqueue(i, onPossibleDispatch)
  }
  private enqueue(i: Intent, onPossibleDispatch?: () => void): Promise<Receipt> {
    const session = i.params.debug_session_id,
      liveKey = canonical([this.principalKey(i.principal), i.params.operation_id])
    const existing = this.inflight.get(liveKey)
    if (existing) return existing
    if ((this.queued.get(session) ?? 0) >= 128)
      return Promise.resolve(this.finish(i, 'rejected', 'debugger_queue_limit'))
    this.queued.set(session, (this.queued.get(session) ?? 0) + 1)
    const promise = (this.tails.get(session) ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.dispatch(i, onPossibleDispatch))
    this.inflight.set(liveKey, promise)
    this.tails.set(session, promise)
    const cleanup = () => {
      this.inflight.delete(liveKey)
      this.queued.set(session, (this.queued.get(session) ?? 1) - 1)
      if (!this.queued.get(session)) this.queued.delete(session)
      if (this.tails.get(session) === promise) this.tails.delete(session)
    }
    void promise.then(cleanup, cleanup)
    return promise
  }
  private async dispatch(i: Intent, onPossibleDispatch?: () => void): Promise<Receipt> {
    const saved = this.load(this.principalKey(i.principal), i.params.operation_id)!
    if (saved.receipt.outcome !== 'pending') return this.receipt(saved)
    // A mode switch or exact approval can update a queued operation while its
    // original closure waits. Dispatch the durable intent, not that old copy.
    i = saved
    try {
      this.preconditions(i)
    } catch (e) {
      return this.finish(i, 'rejected', errorCode(e))
    }
    if (i.principal.kind === 'agent' && !i.approval_authority) {
      const grant = this.permissions.grant(i.principal.grant_id)
      i.approved = grant.mode === 'allow-all'
      if (!i.approved) {
        this.save(i)
        this.pending(i.params.debug_session_id)
        return this.receipt(i)
      }
    }
    const backend = this.backends.get(i.params.debug_session_id)
    if (!backend?.supports(i.method)) return this.finish(i, 'rejected', 'unsupported_operation')
    // 'possible' is written BEFORE calling external code. A backend exception or
    // crash anywhere beyond this boundary must never become a replayable failure.
    this.journal(i, 'dispatched')
    i.receipt.dispatch = 'possible'
    this.save(i)
    let result: unknown
    try {
      let fence = this.state(i.params.debug_session_id)
      const authorize = () => {
        const s = this.state(i.params.debug_session_id)
        const grant = this.permissions.authorize(i.principal, s, actionFor(i.method))
        if (i.principal.kind === 'agent' && !i.approval_authority && grant?.mode !== 'allow-all')
          throw new ChannelError('approval_required')
        if (exact(i.method, i.params, i.effective_breakpoints) && i.principal.kind === 'agent')
          this.permissions.authorize(i.principal, s, 'expressions')
        this.checkApproval(i)
        if (s.incarnation !== i.params.incarnation || canonical(s.target) !== canonical(i.target))
          throw new DebuggerStateError('stale_state', s)
        this.core.debugger.assertEffectsAvailable()
        return s
      }
      const guard: DebuggerDispatchGuard = Object.assign(
        () => {
          const s = authorize()
          if (
            s.state_revision !== fence.state_revision ||
            s.stop_epoch !== fence.stop_epoch ||
            s.breakpoint_revision !== fence.breakpoint_revision
          )
            throw new DebuggerStateError('stale_state', s)
        },
        {
          advanceIntent: () => {
            fence = authorize()
          },
        }
      )
      onPossibleDispatch?.() // survives a failed final journal/receipt write
      result = await backend.dispatch(i.method, i.params, guard)
    } catch (e) {
      return this.finish(i, 'outcome_unknown', errorCode(e))
    }
    i.receipt.dispatch = 'dispatched'
    // Requested returned data only, bounded by history (not copied to receipts).
    return this.finish(i, 'completed', undefined, result)
  }
  private finish(i: Intent, outcome: Receipt['outcome'], code?: string, data?: unknown): Receipt {
    this.journal(
      i,
      outcome === 'rejected'
        ? 'rejected'
        : outcome === 'outcome_unknown'
          ? 'outcome_unknown'
          : 'completed',
      data
    )
    i.receipt = {
      ...i.receipt,
      outcome,
      acceptance: outcome === 'rejected' ? 'rejected' : 'accepted',
      ...(code ? { code } : {}),
      completed_at: new Date().toISOString(),
      snapshot: this.state(i.params.debug_session_id),
    }
    this.save(i)
    this.pending(i.params.debug_session_id)
    return this.receipt(i)
  }
  async approve(owner: AuthorityContext, raw: unknown): Promise<Receipt> {
    this.enabled()
    this.permissions.owner(owner)
    const p = DebuggerApprovalSchema.parse(raw)
    const i = this.load(p.principal_key, p.operation_id)
    if (!i) throw new ChannelError('not_found')
    if (p.proposal_hash !== i.receipt.proposal_hash) throw new ChannelError('approval_mismatch')
    if (i.receipt.outcome !== 'pending' || i.approved)
      return this.inflight.get(canonical([p.principal_key, p.operation_id])) ?? this.receipt(i)
    this.journal(
      i,
      p.decision === 'approve' ? 'approved' : 'denied',
      { proposal_hash: p.proposal_hash },
      { kind: 'human', authority: owner }
    )
    if (p.decision === 'deny') return this.finish(i, 'rejected', 'approval_denied')
    i.approval_authority = this.core.authority.snapshot(owner)
    i.approved = true
    this.save(i)
    this.pending(i.params.debug_session_id)
    return this.enqueue(i)
  }
  private invalidatePending(predicate: (i: Intent) => boolean) {
    for (const row of this.core.db
      .prepare(
        "SELECT body FROM debug_operations WHERE json_extract(body,'$.receipt.outcome')='pending' AND json_extract(body,'$.receipt.dispatch')='not_dispatched'"
      )
      .all()) {
      const i = JSON.parse(String(row.body)) as Intent
      if (predicate(i)) this.finish(i, 'rejected', 'unauthorized')
    }
  }
  read(principal: DebuggerPrincipal, method: string, raw: unknown): any {
    this.enabled()
    if (!['profiles', 'sessions', 'status', 'history', 'replay', 'commandResult'].includes(method))
      throw new ChannelError('unsupported_method')
    const parsed =
      DebuggerMethodSchemas[
        ('debugger.v1.' + method) as keyof typeof DebuggerMethodSchemas
      ].safeParse(raw)
    if (!parsed.success) throw new ChannelError('invalid_params')
    const p = parsed.data as Params
    if (method === 'profiles') {
      this.permissions.owner(principal.authority)
      if (principal.kind !== 'human') throw new ChannelError('unauthorized')
      return this.core.debuggerLaunches.profiles()
    }
    if (method === 'sessions') {
      if (principal.kind !== 'human') throw new ChannelError('unauthorized')
      this.permissions.owner(principal.authority)
      return this.core.db
        .prepare(
          "SELECT body FROM debug_sessions WHERE json_extract(body,'$.target.conversation_id')=? ORDER BY debug_session_id LIMIT ?"
        )
        .all(p.conversation_id, p.limit ?? 128)
        .map((r) => JSON.parse(String(r.body)))
    }
    // Replay has exactly one resource identity: the validated cursor. A second
    // session argument must never select a different authorization scope.
    const session = method === 'replay' ? p.cursor.debug_session_id : p.debug_session_id
    this.checkPublication(principal, session)
    if (method === 'status') return this.core.debugger.snapshot(session)
    if (method === 'history') {
      const current = this.state(session)
      const r = this.core.debugger.history(session, p.after)
      return {
        ...r,
        entries: r.entries
          .filter((entry) => this.permissions.canReadHistory(principal, current, entry))
          .slice(0, p.limit),
      }
    }
    if (method === 'replay') return this.core.debugger.replay(p.cursor)
    if (method === 'commandResult') {
      const i = this.load(this.principalKey(principal), p.operation_id)
      if (!i || i.params.debug_session_id !== session) throw new ChannelError('not_found')
      return this.receipt(i)
    }
    throw new ChannelError('unsupported_method')
  }
  async inspect(principal: DebuggerPrincipal, method: string, raw: unknown) {
    this.enabled()
    if (!['threads', 'stack', 'scopes'].includes(method))
      throw new ChannelError('unsupported_method')
    const parsed =
      DebuggerMethodSchemas[
        ('debugger.v1.' + method) as keyof typeof DebuggerMethodSchemas
      ].safeParse(raw)
    if (!parsed.success) throw new ChannelError('invalid_params')
    const p = parsed.data as Params
    this.checkPublication(principal, p.debug_session_id)
    try {
      return await this.serialInspection(principal, method, p)
    } catch (e) {
      if (!(e instanceof DebuggerStateError)) throw e
      this.checkPublication(principal, p.debug_session_id)
      return { outcome: 'rejected', code: e.code, snapshot: this.state(p.debug_session_id) }
    }
  }
  private async serialInspection(principal: DebuggerPrincipal, method: string, p: Params) {
    const session = p.debug_session_id
    if ((this.queued.get(session) ?? 0) >= 128) throw new ChannelError('debugger_queue_limit')
    this.queued.set(session, (this.queued.get(session) ?? 0) + 1)
    const work = (this.tails.get(session) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const s = this.state(session)
        const guard = () => {
          this.checkPublication(principal, session)
          const now = this.state(session)
          if (
            now.incarnation !== s.incarnation ||
            now.state_revision !== s.state_revision ||
            now.stop_epoch !== s.stop_epoch ||
            (p.incarnation !== undefined && p.incarnation !== now.incarnation) ||
            (p.expected_state_revision !== undefined &&
              p.expected_state_revision !== now.state_revision)
          )
            throw new DebuggerStateError('stale_state', now)
          this.core.debugger.assertEffectsAvailable()
        }
        guard()
        const backend = this.backends.get(session)
        if (!backend?.supports(method)) throw new ChannelError('unsupported_operation')
        const data = await backend.dispatch(
          method,
          p,
          Object.assign(guard, {
            advanceIntent: () => {
              throw new ChannelError('inspection_intent_forbidden')
            },
          })
        )
        this.checkPublication(principal, session)
        const bounded = boundedPayload(data, 8192)
        const result = JSON.parse(bounded.json!)
        this.core.debugger.recordHistory(session, {
          actor: this.actor(principal),
          operation_id: null,
          operation: method,
          outcome: 'completed',
          requested_data: data,
        })
        return { data: result, truncated: bounded.truncated, snapshot: this.state(session) }
      })
    this.tails.set(session, work)
    const cleanup = () => {
      this.queued.set(session, (this.queued.get(session) ?? 1) - 1)
      if (!this.queued.get(session)) this.queued.delete(session)
      if (this.tails.get(session) === work) this.tails.delete(session)
    }
    void work.then(cleanup, cleanup)
    return work
  }
  methods(): string[] {
    return this.core.debugger.enabled ? Object.keys(DebuggerControlMethodSchemas) : []
  }
  request(
    owner: AuthorityContext,
    full: string,
    raw: unknown,
    operation?: string,
    signal?: AbortSignal
  ): unknown {
    const bounded = (result: unknown) => {
      // Never let a legal collection size turn into an oversized channel frame.
      // Proposal pages have a smaller explicit budget; other oversized responses
      // fail explicitly rather than disconnecting or silently dropping evidence.
      if (Buffer.byteLength(JSON.stringify(result)) > LIMITS.record_bytes - 4096)
        throw new ChannelError('debugger_response_too_large')
      return result
    }
    const result = this.admitRpc(owner, full, raw, operation, signal)
    return result instanceof Promise ? result.then(bounded) : bounded(result)
  }
  private admitRpc(
    owner: AuthorityContext,
    full: string,
    raw: unknown,
    operation?: string,
    signal?: AbortSignal
  ): unknown {
    this.enabled()
    this.permissions.owner(owner)
    const schema = DebuggerControlMethodSchemas[full as keyof typeof DebuggerControlMethodSchemas]
    if (!schema) throw new ChannelError('unsupported_method')
    const method = full.slice('debugger.v1.'.length)
    if (
      (effects.has(method) || ['stack', 'scopes', 'threads'].includes(method)) &&
      !this.backends.size
    )
      throw new ChannelError('unsupported_method')
    const parsed = schema.safeParse(raw)
    if (!parsed.success) throw new ChannelError('invalid_params')
    const p = parsed.data as Params,
      human: DebuggerPrincipal = { kind: 'human', authority: owner }
    if (operation && p.operation_id && operation !== p.operation_id)
      throw new ChannelError('idempotency_mismatch')
    if (method === 'grant.create') return this.createGrant(owner, p)
    if (method === 'grant.setMode') return this.setGrantMode(owner, p.grant_id, p.mode)
    if (method === 'grant.revoke') {
      this.revokeGrant(owner, p.grant_id)
      return { revoked: true }
    }
    if (method === 'task.settle') {
      this.settleTask(p.task_id, p.run_id)
      return { settled: true }
    }
    if (method === 'policy.get') return this.permissions.policy()
    if (method === 'policy.set') return this.permissions.setPolicy(owner, p)
    if (method === 'wait' || method === 'sleep') return this.wait(human, method, p, signal)
    if (method === 'cancelWait') return this.waits.cancel(human, p)
    if (method === 'approve') return this.approve(owner, p)
    if (method === 'start') return this.core.debuggerLaunches.start(owner, p as any)
    if (method === 'attachProgram') return this.core.debuggerLaunches.attach(owner, p as any)
    // Listing what runs on the machine is the owner's (checked above), as attaching is.
    if (method === 'programs') return this.core.debuggerLaunches.programs(p.conversation_id)
    if (method === 'approvals') {
      this.checkPublication(human, p.debug_session_id)
      const all = this.core.db
        .prepare(
          "SELECT principal_key,body FROM debug_operations WHERE debug_session_id=? AND json_extract(body,'$.receipt.outcome')='pending' AND json_extract(body,'$.approved')=0 LIMIT 128"
        )
        .all(p.debug_session_id)
        .map((r) => {
          const i = JSON.parse(String(r.body)) as Intent
          return {
            key: canonical([r.principal_key, i.params.operation_id]),
            principal_key: r.principal_key,
            actor: this.actor(i.principal),
            method: i.method,
            params: i.params,
            ...(i.effective_breakpoints === undefined
              ? {}
              : { effective_breakpoints: i.effective_breakpoints }),
            receipt: this.receipt(i),
          }
        })
        .filter((i) => i.key > p.after)
        .sort((a, b) => (a.key < b.key ? -1 : 1))
      const proposals: typeof all = []
      for (const proposal of all) {
        if (
          Buffer.byteLength(
            JSON.stringify({
              proposals: [...proposals, proposal],
              truncated: true,
              next: proposal.key,
            })
          ) > DEBUGGER_LIMITS.approval_page_bytes
        )
          break
        proposals.push(proposal)
      }
      if (all.length && !proposals.length) throw new ChannelError('debugger_response_too_large')
      return {
        proposals,
        truncated: proposals.length < all.length,
        next: proposals.at(-1)?.key ?? null,
      }
    }
    if (effects.has(method)) return this.command(human, method, p)
    if (['threads', 'stack', 'scopes'].includes(method)) return this.inspect(human, method, p)
    return this.read(human, method, p)
  }
  checkRpcPublication(owner: AuthorityContext, full: string, raw: unknown, result: any) {
    this.enabled()
    this.permissions.owner(owner)
    const p = raw as Params
    const session =
      p.debug_session_id ??
      p.cursor?.debug_session_id ??
      result?.snapshot?.debug_session_id ??
      (full === 'debugger.v1.start' || full === 'debugger.v1.attachProgram'
        ? result?.debug_session_id
        : undefined)
    if (session) this.checkPublication({ kind: 'human', authority: owner }, session)
    if (full === 'debugger.v1.sessions' && Array.isArray(result))
      for (const s of result)
        this.checkPublication({ kind: 'human', authority: owner }, s.debug_session_id)
  }
  private recover() {
    // No driver restored, no adapter reconnect/relaunch, no uncertain redispatch.
    for (const row of this.core.db
      .prepare(
        "SELECT body FROM debug_operations WHERE json_extract(body,'$.receipt.outcome')='pending'"
      )
      .all()) {
      const i = JSON.parse(String(row.body)) as Intent
      const state = this.state(i.params.debug_session_id)
      new DebuggerHistoryStore(this.core).append(state, {
        actor: { kind: 'node' },
        operation_id: i.params.operation_id,
        operation: i.method,
        outcome: 'outcome_unknown',
      })
      i.receipt = {
        ...i.receipt,
        outcome: 'outcome_unknown',
        code: 'node_restart',
        completed_at: new Date().toISOString(),
        snapshot: state,
      }
      this.save(i)
    }
  }
}
