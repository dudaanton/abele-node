import { LspTools } from './lsp/tools.js'
import { randomUUID } from 'node:crypto'
import { ChannelError } from '@abele/channel-protocol'
import {
  SessionSchema,
  type ExpectedExecutionTarget,
  type LiveSessionState,
  type SessionSettings,
} from '@abele/node-protocol'
import type {
  DebuggerToolBridge,
  LiveInput,
  LiveSession,
  LiveSessionSettings,
  LiveSessionSink,
  ProviderEvent,
} from '@abele/provider-contract'
import type { NodeCore } from './index.js'
import type { ProviderSessions } from './claude.js'
import type { ProviderAdapter } from './providers.js'
import { updateInProgress, tryRunAdmission } from './update-lock.js'
import { DebuggerRunBinding } from './debugger/run.js'
import { RunTargetTools } from './run-target-tools.js'
import { SessionMessageTools, messageContent, messageRefusal } from './session-messages.js'

type Input = Record<string, string | number | null>
type Task = { task_id: string; task_type: string | null; description: string | null }
type Effective = Required<SessionSettings>
const actor = { kind: 'node' } as const
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const DEFAULT_CONTINUATION = 'продолжай'
/** Events that change what another node needs to take a process over. */
const SAVED_ON = new Set([
  'claude.input.delivered',
  'claude.turn.started',
  'claude.turn.completed',
  'claude.tasks',
  'claude.context',
  'claude.status',
  'claude.compact.boundary',
  'claude.tool.call',
])
/** pi and ACP agents report the same lifecycle under their own names; `live.*` is the
 * provider-neutral spelling a new provider uses. */
const LIFECYCLE: Record<string, string> = {
  'live.input.delivered': 'claude.input.delivered',
  'live.turn.started': 'claude.turn.started',
  'live.turn.completed': 'claude.turn.completed',
  'live.context': 'claude.context',
  'live.status': 'claude.status',
  'live.compact.boundary': 'claude.compact.boundary',
  'pi.input.delivered': 'claude.input.delivered',
  'pi.turn.started': 'claude.turn.started',
  'pi.turn.completed': 'claude.turn.completed',
  'pi.context': 'claude.context',
  'pi.compact.boundary': 'claude.compact.boundary',
  'pi.compact.summary': 'claude.compact.summary',
}
export interface LiveOptions {
  /** Idle time after the last watcher left before a process with nothing running is ended; 0 never. */
  idleMs?: number
  /** Processes kept at once; the least recently used idle one makes room. */
  maxLive?: number
  /** First wait before starting again after a process failed to start or died early. */
  retryMs?: number
}
interface Slot {
  cleanupPending?: boolean
  cleaning?: Promise<void>
  session_id: string
  run_id: string
  principal: string
  state: 'starting' | 'idle' | 'running' | 'stopping'
  live?: LiveSession
  completion?: Promise<void>
  turn?: { turn_id: string; trigger: string; started_at: string }
  tasks: Task[]
  crons: number
  wakeUntil: number
  context: LiveSessionState['context']
  compacting: boolean
  /** The compaction input being consumed and whether its turn ends in a continuation. */
  compaction?: { principal: string; continue: boolean }
  continueAfterTurn?: { principal: string; text: string }
  settings: LiveSessionSettings
  startedAt: number
  idleSince: number
  stopReason?: string
  /** Left running for the next node to adopt. */
  detaching?: boolean
  cwd: string
  debugger?: DebuggerToolBridge
}
/** What a node needs to take over a process an earlier node left running. */
type Saved = Pick<
  Slot,
  | 'principal'
  | 'turn'
  | 'tasks'
  | 'crons'
  | 'wakeUntil'
  | 'context'
  | 'compacting'
  | 'compaction'
  | 'continueAfterTurn'
  | 'settings'
  | 'startedAt'
  | 'cwd'
>
type ProviderRun = {
  run_id: string
  session_id: string
  live: string | null
  live_state: string | null
  stream_offset: number
}
/** One long-lived provider process per owner session. Inputs are written into it as they arrive;
 * turns, background work and compaction are read from its stream. The durable input queue stays
 * the only owner of what the owner asked for. */
export class LiveSessions {
  private slots = new Map<string, Slot>()
  private failures = new Map<string, { count: number; until: number }>()
  private restartPending = new Set<string>()
  readonly idleMs: number
  readonly maxLive: number
  private retryMs: number
  constructor(
    private core: NodeCore,
    private owner: ProviderSessions,
    options: LiveOptions = {}
  ) {
    this.idleMs = options.idleMs ?? 30 * 60000
    this.maxLive = options.maxLive ?? 12
    this.retryMs = options.retryMs ?? 5000
  }
  private adapter(provider: string): ProviderAdapter | undefined {
    return this.owner.adapterFor(provider)
  }
  /** Owner sessions only. Delegated work keeps one bounded process per message. */
  handles(session_id: string) {
    let session
    try {
      session = this.core.session(session_id)
    } catch {
      return false
    }
    const adapter = this.adapter(session.provider)
    return (
      ['claude', 'pi', 'acp', 'codex'].includes(session.provider) &&
      !!adapter?.liveAvailable &&
      !!adapter.startSession &&
      !this.core.db.prepare('SELECT 1 FROM delegations WHERE session_id=?').get(session_id)
    )
  }
  /** At most maxLive process slots; listing must not enumerate durable session history. */
  runningSessionIds() {
    return [...this.slots.keys()]
  }
  effective(session_id: string): Effective {
    const session = this.core.session(session_id)
    const defaults = this.adapter(session.provider)?.sessionDefaults?.() ?? {
      model: 'haiku',
      effort: 'high',
      account: 'default',
      permission_mode: 'manual',
    }
    return {
      ...defaults,
      continue_after_compaction: true,
      continuation_text: DEFAULT_CONTINUATION,
      messaging: true,
      ...(session.settings ?? {}),
      permission_mode:
        session.settings?.permission_mode ??
        session.tool_permissions?.permission_mode ??
        defaults.permission_mode,
    } as Effective
  }
  /** The permission modes a session is under: the owner's setting and, while it differs, the one
   * its process reports (the CLI changes its own, as when it leaves plan mode). */
  modes(session_id: string) {
    const set = this.effective(session_id).permission_mode
    const running = this.slots.get(session_id)?.settings.permission_mode
    return running && running !== set ? [set, running] : [set]
  }
  /** Inside the configure transaction: validate against what this node can launch. */
  validate(session_id: string, settings: SessionSettings) {
    const session = this.core.session(session_id)
    try {
      this.adapter(session.provider)?.validateSettings?.(settings)
      if (
        settings.permission_mode === 'bypassPermissions' &&
        !this.adapter(session.provider)?.configuration.permission_modes?.includes(
          'bypassPermissions'
        )
      )
        throw new Error('bypass_unavailable')
    } catch {
      throw new ChannelError('invalid_params')
    }
  }
  /** After configure commits: apply what the running process can switch now. */
  applied(session_id: string, before: Effective, after: Effective) {
    const slot = this.slots.get(session_id)
    if (!slot?.live) return
    if (before.model !== after.model)
      void slot.live
        .control('set_model', { model: after.model })
        .then(() => (slot.settings = { ...slot.settings, model: after.model }))
        .catch(() => this.restartPending.add(session_id))
    // A mode the process did not take must not stay in force: end it, the next input restarts it.
    if (before.permission_mode !== after.permission_mode)
      void slot.live
        .control('set_permission_mode', { mode: after.permission_mode })
        .then(() => (slot.settings = { ...slot.settings, permission_mode: after.permission_mode }))
        .catch(() => void this.stop(session_id, 'settings_not_applied').catch(() => {}))
    // The tools a process offers are fixed when it starts; calls check the grant every time.
    if (
      before.effort !== after.effort ||
      before.account !== after.account ||
      before.messaging !== after.messaging
    )
      this.restartPending.add(session_id)
  }
  get size() {
    return this.slots.size
  }
  hasExecution(session_id: string) {
    return this.slots.has(session_id)
  }
  state(session_id: string): LiveSessionState {
    const slot = this.slots.get(session_id)
    const session = this.core.session(session_id)
    const settings = this.effective(session_id)
    const iso = (ms: number) => new Date(ms).toISOString()
    return {
      session_id,
      ...(session.stop_generation
        ? {
            stop_generation: session.stop_generation,
            owner_stopped: session.owner_stopped,
            stop_reason: session.stop_reason,
          }
        : {}),
      live: this.handles(session_id),
      tool_permissions: session.tool_permissions,
      process: slot ? slot.state : 'none',
      run_id: slot?.run_id ?? null,
      turn: slot?.turn ?? null,
      background_tasks: slot?.tasks ?? [],
      context: slot?.context ?? null,
      compacting: slot?.compacting ?? false,
      settings,
      process_settings: slot ? { ...slot.settings } : null,
      restart_pending: this.restartPending.has(session_id),
      watchers: this.core.watching(session_id),
      idle_since: slot && slot.state === 'idle' ? iso(slot.idleSince) : null,
    }
  }
  /** Inside a session.interrupt transaction. */
  interruptRequested(session_id: string, run_id: string) {
    const slot = this.slots.get(session_id)
    if (!slot || slot.run_id !== run_id) return false
    slot.compaction = undefined
    slot.continueAfterTurn = undefined
    this.core.append(session_id, 'turn.interrupt_requested', actor, { run_id })
    for (const prompt of this.core.pendingPrompts(session_id, run_id))
      if (prompt.state === 'pending' && prompt.run_id === run_id)
        this.core.resolvePrompt(prompt, 'invalidated', 'deny', null)
    queueMicrotask(() => {
      if (slot.live) void slot.live.interrupt().catch(() => {})
      else void this.stop(session_id, 'interrupted_while_starting').catch(() => {})
    })
    return true
  }
  /** The hard stop. Queued inputs are cancelled first so nothing starts it again. */
  stopRequested(session_id: string) {
    for (const input of this.core.db
      .prepare("SELECT * FROM inputs WHERE session_id=? AND state IN ('accepted','queued')")
      .all(session_id) as Input[])
      this.core.transition(input, 'cancelled')
    const slot = this.slots.get(session_id)
    // Cleanup failure is already journaled/quarantined by exited(); drain retries it.
    if (slot) {
      slot.compaction = undefined
      slot.continueAfterTurn = undefined
    }
    if (slot) queueMicrotask(() => void this.stop(session_id, 'stopped_by_owner').catch(() => {}))
    return { session_id, state: slot ? 'stopping' : 'stopped' }
  }
  async stop(session_id: string, reason: string) {
    const slot = this.slots.get(session_id)
    if (!slot) return
    slot.stopReason ??= reason
    if (slot.state !== 'starting') slot.state = 'stopping'
    if (slot.live) await slot.live.stop(reason).catch(() => {})
    await slot.completion
    await slot.cleaning
    if (slot.cleanupPending) await this.reconcileExited(slot)
  }
  async stopAll() {
    await Promise.all([...this.slots.keys()].map((s) => this.stop(s, 'node_stopping')))
    while ([...this.slots.values()].some((slot) => slot.state === 'starting')) await delay(20)
    await Promise.all([...this.slots.keys()].map((s) => this.stop(s, 'node_stopping')))
  }
  /** The node goes away and leaves its processes running; the next one adopts them. */
  async detachAll() {
    while ([...this.slots.values()].some((slot) => slot.state === 'starting')) await delay(20)
    await Promise.all(
      [...this.slots.values()].map(async (slot) => {
        if (slot.state === 'stopping' || !slot.live?.detach)
          return this.stop(slot.session_id, 'node_stopping')
        slot.detaching = true
        this.core.obsidianTools.suspendRun(slot.run_id)
        await slot.live.detach()
        await slot.completion
      })
    )
  }
  /** Inside the boot: a run whose process an earlier node left running, ready to be taken over. */
  adoptable(row: ProviderRun) {
    return !!row.live && !!row.live_state && this.handles(row.session_id)
  }
  /** Re-attach to a process an earlier node left running. False: it is gone, clean up. */
  async adopt(row: ProviderRun) {
    const { session_id, run_id } = row
    const session = this.core.session(session_id)
    const adapter = this.adapter(session.provider)
    if (!adapter?.startSession || this.slots.has(session_id)) return false
    const saved = JSON.parse(row.live_state!) as Saved
    // The same admission a new process gets: whoever started it may still run it, in a trusted project.
    try {
      this.core.checkExecution(saved.principal, session_id)
      const target = await this.core.resources.targets.runtime(session_id)
      if (target.project.trust !== 'trusted' || target.path !== saved.cwd) return false
    } catch {
      return false
    }
    const slot: Slot = {
      ...saved,
      session_id,
      run_id,
      state: saved.turn ? 'running' : 'idle',
      idleSince: Date.now(),
    }
    this.slots.set(session_id, slot)
    const alive = this.bind(slot, session.workspace_id ?? null)
    const inputs = this.core.db
      .prepare(
        "SELECT * FROM inputs WHERE run_id=? AND state IN ('dispatching','delivered') ORDER BY ordinal"
      )
      .all(run_id) as Input[]
    try {
      slot.live = await adapter.startSession(
        {
          session_id,
          run_id,
          cwd: slot.cwd,
          ...(session.native_session_id ? { native_session_id: session.native_session_id } : {}),
          ...(session.native_session_file
            ? { native_session_file: session.native_session_file }
            : {}),
          ...(session.agent ? { agent: session.agent } : {}),
          settings: slot.settings,
          permission_ttl_ms: Number(adapter.configuration.session_permission_ttl_ms ?? 30 * 60000),
          adopt: {
            record: JSON.parse(row.live!),
            offset: row.stream_offset,
            running: !!saved.turn,
            delivered: inputs.filter((i) => i.state === 'delivered').map((i) => String(i.input_id)),
            dispatching: inputs
              .filter((i) => i.state === 'dispatching')
              .map((i) => ({ input_id: String(i.input_id), content: this.content(i) })),
          },
        },
        this.sink(slot, alive)
      )
    } catch {
      try {
        slot.debugger?.close()
      } catch {}
      if (this.slots.get(session_id) === slot) this.slots.delete(session_id)
      return false
    }
    slot.completion = slot.live.done.then((result) => this.exited(slot, result))
    this.core.transaction(() =>
      this.core.append(session_id, 'session.process', actor, {
        run_id,
        state: 'running',
        reattached: true,
      })
    )
    return true
  }
  /** Inside the boot: what an earlier node's process left behind when nobody could take it over. */
  lost(row: ProviderRun) {
    const saved = row.live_state ? (JSON.parse(row.live_state) as Saved) : undefined
    for (const input of this.core.db
      .prepare("SELECT * FROM inputs WHERE run_id=? AND state IN ('dispatching','delivered')")
      .all(row.run_id) as Input[])
      this.core.transition(input, 'delivery_unknown')
    if (saved?.turn)
      this.core.append(row.session_id, 'turn.completed', actor, {
        run_id: row.run_id,
        turn_id: saved.turn.turn_id,
        outcome: 'interrupted',
        input_ids: [],
        subtype: 'process_exited',
        num_turns: null,
        duration_ms: null,
        total_cost_usd: null,
        terminal_reason: row.live ? 'process_lost' : 'node_restart',
      })
    this.core.append(row.session_id, 'session.process', actor, {
      run_id: row.run_id,
      state: 'exited',
      reason: row.live ? 'process_lost' : 'node_restart',
      ...(saved?.tasks.length ? { lost_tasks: saved.tasks } : {}),
    })
  }
  /** The text written into the process for one input. */
  private content(input: Input): LiveInput['content'] {
    return messageContent(JSON.parse(String(input.body)))
  }
  /** Keep what another node needs to take this process over. Inside a transaction. */
  private save(slot: Slot) {
    const saved: Saved = {
      principal: slot.principal,
      turn: slot.turn,
      tasks: slot.tasks,
      crons: slot.crons,
      wakeUntil: slot.wakeUntil,
      context: slot.context,
      compacting: slot.compacting,
      compaction: slot.compaction,
      continueAfterTurn: slot.continueAfterTurn,
      settings: slot.settings,
      startedAt: slot.startedAt,
      cwd: slot.cwd,
    }
    this.core.db
      .prepare('UPDATE provider_runs SET live_state=? WHERE run_id=?')
      .run(JSON.stringify(saved), slot.run_id)
  }
  /** The node's own tools for the agent in this process. */
  private bind(slot: Slot, workspace_id: string | null) {
    const { session_id, run_id } = slot
    const authority = this.core.authority.forInstallation(slot.principal)
    const alive = () =>
      this.slots.get(session_id) === slot &&
      slot.state !== 'stopping' &&
      !this.deleted(session_id) &&
      !this.core.ownerStopRefusal(session_id)
    if (this.core.debugger.enabled)
      slot.debugger = new DebuggerRunBinding(this.core, {
        authority,
        run_id,
        conversation_id: session_id,
        workspace_id,
        active: alive,
      })
    if (this.core.resources.targets.bound(session_id))
      slot.debugger = new RunTargetTools(
        this.core,
        authority,
        session_id,
        run_id,
        alive,
        slot.debugger
      )
    if (this.effective(session_id).messaging)
      slot.debugger = new SessionMessageTools(
        this.core,
        this,
        { session_id, run_id, principal: slot.principal },
        alive,
        slot.debugger
      )
    if (this.core.session(session_id).provider !== 'claude')
      slot.debugger = new LspTools(this.core, session_id, slot.principal, alive, slot.debugger)
    if (this.core.obsidianTools.configured(session_id))
      slot.debugger = this.core.obsidianTools.bridge(
        authority,
        session_id,
        run_id,
        alive,
        slot.debugger
      )
    return alive
  }
  private sink(slot: Slot, alive: () => boolean): LiveSessionSink {
    const { session_id, run_id } = slot
    return {
      ...(slot.debugger ? { debugger: slot.debugger } : {}),
      processes: (evidence) => this.owner.persistProcesses(run_id, evidence),
      ipc: (directory) =>
        this.core.transaction(() =>
          this.core.db
            .prepare('UPDATE provider_runs SET ipc_path=? WHERE run_id=?')
            .run(directory, run_id)
        ),
      attachment: (record) =>
        this.core.transaction(() =>
          this.core.db
            .prepare('UPDATE provider_runs SET live=? WHERE run_id=?')
            .run(JSON.stringify(record), run_id)
        ),
      checkpoint: (offset) =>
        this.core.db
          .prepare('UPDATE provider_runs SET stream_offset=? WHERE run_id=?')
          .run(offset, run_id),
      event: (event) => this.record(slot, event),
      permission: (action, signal) =>
        this.owner.ask(
          {
            session_id,
            run_id,
            principal: slot.principal,
            active: alive,
            ttl_ms: action.ttl_ms,
            evidence:
              this.core.session(session_id).provider === 'codex'
                ? 'codex_rpc_dispatch_authorized'
                : 'stdio_control_response',
          },
          action,
          signal
        ),
    }
  }
  private reapable(slot: Slot, now: number) {
    return (
      slot.state === 'idle' &&
      !slot.compacting &&
      slot.tasks.length === 0 &&
      slot.crons === 0 &&
      now >= slot.wakeUntil &&
      !this.core.db
        .prepare(
          "SELECT 1 FROM inputs WHERE session_id=? AND state IN ('accepted','queued','dispatching','delivered')"
        )
        .get(slot.session_id) &&
      !this.core.hasPendingPrompt(slot.session_id)
    )
  }
  private deleted(session_id: string) {
    return !!this.core.db
      .prepare('SELECT 1 FROM deleted_sessions WHERE session_id=?')
      .get(session_id)
  }
  /** Node policy for running processes: authority, idle, restarts, moves, deletion. */
  private maintain(now = Date.now()) {
    for (const slot of this.slots.values()) {
      if (slot.state === 'starting' || slot.state === 'stopping') continue
      let reason: string | undefined
      if (this.deleted(slot.session_id)) reason = 'session_deleted'
      else
        try {
          // The installation that started the process, and every one whose input is in it now.
          const principals = new Set([
            slot.principal,
            ...(
              this.core.db
                .prepare(
                  "SELECT DISTINCT principal_id FROM inputs WHERE run_id=? AND state IN ('dispatching','delivered')"
                )
                .all(slot.run_id) as { principal_id: string }[]
            ).map((r) => r.principal_id),
          ])
          for (const installation_id of principals)
            this.core.authority.check({ installation_id }, 'execute', slot.session_id)
        } catch {
          reason = 'execution_authority_revoked'
        }
      if (!reason && this.reapable(slot, now)) {
        if (this.restartPending.has(slot.session_id)) reason = 'settings_changed'
        else if (
          this.core.db
            .prepare('SELECT 1 FROM session_target_switches WHERE session_id=? AND run_id=?')
            .get(slot.session_id, slot.run_id)
        )
          reason = 'target_switch'
        else if (
          this.idleMs > 0 &&
          this.core.watching(slot.session_id) === 0 &&
          now - Math.max(slot.idleSince, this.core.unwatchedAt(slot.session_id)) >= this.idleMs
        )
          reason = 'idle'
      }
      if (reason) void this.stop(slot.session_id, reason).catch(() => {})
    }
  }
  /** Make room by ending the longest idle process that has nothing running. */
  private makeRoom(now: number, holder?: string) {
    const candidates = [...this.slots.values()]
      .filter((s) => (holder ? s.session_id === holder : true) && this.reapable(s, now))
      .sort((a, b) => a.idleSince - b.idleSince)
    const victim = candidates[0]
    if (victim)
      void this.stop(victim.session_id, holder ? 'target_needed' : 'process_limit').catch(() => {})
    return !!victim
  }
  private async reconcileExited(slot: Slot) {
    const adapter = this.adapter(this.core.session(slot.session_id).provider)
    const row = this.core.db
      .prepare('SELECT processes,ipc_path FROM provider_runs WHERE run_id=?')
      .get(slot.run_id) as { processes: string; ipc_path: string | null }
    if (!adapter) throw new Error('provider_reconciliation_required')
    await adapter.reconcile(JSON.parse(row.processes), row.ipc_path ?? undefined)
    this.core.transaction(() => {
      this.core.db
        .prepare("UPDATE provider_runs SET state='settled' WHERE run_id=?")
        .run(slot.run_id)
      this.core.resources.targets.settle(slot.session_id, slot.run_id)
      this.core.append(slot.session_id, 'session.process', actor, {
        run_id: slot.run_id,
        state: 'exited',
        reason: 'process_cleanup_confirmed',
      })
    })
    if (this.slots.get(slot.session_id) === slot) this.slots.delete(slot.session_id)
    slot.cleanupPending = false
  }
  /** Called from the provider drain. Never blocks on a turn or orphan cleanup. */
  async drain(stopping: boolean) {
    for (const slot of this.slots.values()) {
      if (!slot.cleanupPending || slot.cleaning) continue
      slot.cleaning = this.reconcileExited(slot)
        .catch(() => {})
        .finally(() => {
          slot.cleaning = undefined
        })
    }
    this.maintain()
    if (stopping || updateInProgress(this.core.stateDir)) return
    const rows = this.core.db
      .prepare("SELECT * FROM inputs WHERE state IN ('accepted','queued') ORDER BY ordinal")
      .all() as Input[]
    const seen = new Set<string>()
    for (const input of rows) {
      const session_id = String(input.session_id)
      if (seen.has(session_id) || !this.handles(session_id)) continue
      const slot = this.slots.get(session_id)
      seen.add(session_id)
      if (slot?.state === 'idle' || slot?.state === 'running') {
        await this.dispatch(slot, input)
        continue
      }
      if (slot) continue
      const failure = this.failures.get(session_id)
      if (failure && Date.now() < failure.until) continue
      if ([...this.slots.values()].filter((slot) => !slot.cleanupPending).length >= this.maxLive) {
        this.makeRoom(Date.now())
        continue
      }
      await this.start(input)
    }
  }
  private async dispatch(slot: Slot, input: Input) {
    // A letter owns its whole turn. Include dispatching inputs: the provider may
    // not have acknowledged them yet. Never use sender metadata for authority.
    const letter = (body: string) => {
      const p = JSON.parse(body)
      return !!(p.sender || p.from_session)
    }
    const active = this.core.db
      .prepare(
        "SELECT body FROM inputs WHERE session_id=? AND state IN ('dispatching','delivered')"
      )
      .all(slot.session_id) as { body: string }[]
    if (
      (active.length || slot.turn) &&
      (letter(String(input.body)) || active.some((i) => letter(i.body)))
    )
      return
    const body = JSON.parse(String(input.body)) as {
      text: string
      expected_target?: ExpectedExecutionTarget
      from_session?: { session_id: string }
    }
    const input_id = String(input.input_id)
    const ready = this.core.transaction(() => {
      const current = this.core.db
        .prepare('SELECT * FROM inputs WHERE input_id=?')
        .get(input_id) as Input
      if (!['accepted', 'queued'].includes(String(current.state))) return false
      try {
        this.core.checkExecution(String(input.principal_id), slot.session_id, body.expected_target)
        // Another session's message waited: what allowed it then must still hold now.
        const refusal =
          body.from_session && messageRefusal(this, body.from_session.session_id, slot.session_id)
        if (refusal) throw new ChannelError(refusal)
      } catch (error) {
        this.core.transition(current, 'failed')
        this.core.append(slot.session_id, 'session.error', actor, {
          run_id: slot.run_id,
          input_id,
          code: error instanceof ChannelError ? error.code : 'execution_refused',
        })
        return false
      }
      current.run_id = slot.run_id
      this.core.db.prepare('UPDATE inputs SET run_id=? WHERE input_id=?').run(slot.run_id, input_id)
      this.core.transition(current, 'dispatching')
      return true
    })
    if (!ready) return
    try {
      if (slot.state === 'idle' && !slot.turn)
        await this.core.chatCheckpoints.capture(slot.session_id, input_id)
      if (slot.stopReason || this.slots.get(slot.session_id) !== slot) return
      const current = this.core.db
        .prepare('SELECT state FROM inputs WHERE input_id=?')
        .get(input_id)
      if (current?.state !== 'dispatching') return
      this.core.checkExecution(String(input.principal_id), slot.session_id, body.expected_target)
      slot.live!.send({ input_id, content: this.content(input) })
    } catch {
      // Never written: the next process takes it.
      this.core.transaction(() => {
        const current = this.core.db
          .prepare('SELECT * FROM inputs WHERE input_id=?')
          .get(input_id) as Input
        if (current.state !== 'dispatching') return
        this.core.db.prepare('UPDATE inputs SET run_id=NULL WHERE input_id=?').run(input_id)
        current.run_id = null
        this.core.transition(
          current,
          this.core.ownerStopRefusal(slot.session_id) ? 'cancelled' : 'queued'
        )
      })
    }
  }
  private async start(first: Input) {
    const session_id = String(first.session_id)
    const session = this.core.session(session_id)
    const adapter = this.adapter(session.provider)!
    if (
      (!session.workspace_id && !this.core.resources.targets.bound(session_id)) ||
      this.core.workspaceProvisioning(session_id)
    )
      return
    const run_id = randomUUID()
    const settings = this.effective(session_id)
    const slot: Slot = {
      session_id,
      run_id,
      principal: String(first.principal_id),
      state: 'starting',
      tasks: [],
      crons: 0,
      wakeUntil: 0,
      context: null,
      compacting: false,
      settings: {
        model: settings.model,
        effort: settings.effort,
        account: settings.account,
        permission_mode: settings.permission_mode,
      },
      startedAt: Date.now(),
      idleSince: Date.now(),
      cwd: '',
    }
    this.slots.set(session_id, slot)
    let leased = false
    try {
      const expected = (
        JSON.parse(String(first.body)) as { expected_target?: ExpectedExecutionTarget }
      ).expected_target
      this.core.checkExecution(slot.principal, session_id, expected)
      const target = await this.core.resources.targets.runtime(session_id)
      slot.cwd = target.path
      if (!this.core.resources.targets.canLease(target, session_id)) {
        const holder = this.core.db
          .prepare('SELECT session_id FROM execution_target_leases WHERE canonical_key=?')
          .get(target.canonical_key) as { session_id: string } | undefined
        if (holder) this.makeRoom(Date.now(), holder.session_id)
        this.slots.delete(session_id)
        return
      }
      if (target.project.trust !== 'trusted') throw new ChannelError('project_untrusted')
      const release = tryRunAdmission(this.core.stateDir)
      if (!release) {
        this.slots.delete(session_id)
        return
      }
      let useRepositoryPermissions = false
      let previous_account: string | undefined
      try {
        this.owner.assertPermissionPolicy(session_id)
        if (updateInProgress(this.core.stateDir, true)) {
          this.slots.delete(session_id)
          return
        }
        this.core.transaction(() => {
          const project = this.core.resources.projects.get(target.project.project_id)
          if (project.trust !== 'trusted') throw new ChannelError('project_untrusted')
          useRepositoryPermissions = project.use_repository_claude_permissions
          this.core.checkExecution(slot.principal, session_id, expected)
          if (!this.core.resources.targets.lease(target, session_id, run_id))
            throw new ChannelError('resource_busy')
          leased = true
          this.core.db
            .prepare("INSERT INTO provider_runs(run_id,session_id,state) VALUES(?,?,'active')")
            .run(run_id, session_id)
          previous_account = (
            this.core.db
              .prepare('SELECT account FROM claude_native_accounts WHERE session_id=?')
              .get(session_id) as { account: string } | undefined
          )?.account
          this.core.db
            .prepare(
              'INSERT INTO claude_native_accounts(session_id,account) VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET account=excluded.account'
            )
            .run(session_id, settings.account)
          this.core.append(session_id, 'session.process', actor, {
            run_id,
            state: 'starting',
            resumed: !!session.native_session_id,
            native_session_id: session.native_session_id ?? null,
          })
          this.save(slot)
        })
      } finally {
        release()
      }
      this.restartPending.delete(session_id)
      const alive = this.bind(slot, session.workspace_id ?? null)
      slot.live = await adapter.startSession!(
        {
          session_id,
          run_id,
          cwd: target.path,
          ...(session.native_session_id ? { native_session_id: session.native_session_id } : {}),
          ...(session.native_session_file
            ? { native_session_file: session.native_session_file }
            : {}),
          ...(session.agent ? { agent: session.agent } : {}),
          ...(previous_account ? { previous_account } : {}),
          ...(session.provider === 'codex' && session.native_session_id
            ? { native_binding: this.owner.codexBinding(session_id) }
            : {}),
          use_repository_claude_permissions: useRepositoryPermissions,
          codex_network_enabled: target.project.codex_network_enabled,
          settings: slot.settings,
          permission_ttl_ms: Number(adapter.configuration.session_permission_ttl_ms ?? 30 * 60000),
        },
        this.sink(slot, alive)
      )
      slot.completion = slot.live.done.then((result) => this.exited(slot, result))
      if (slot.stopReason) await slot.live.stop(slot.stopReason).catch(() => {})
      else {
        slot.state = 'idle'
        slot.idleSince = Date.now()
        this.core.transaction(() =>
          this.core.append(session_id, 'session.process', actor, { run_id, state: 'running' })
        )
        const input = this.core.db
          .prepare(
            "SELECT * FROM inputs WHERE session_id=? AND state IN ('accepted','queued') ORDER BY ordinal LIMIT 1"
          )
          .get(session_id) as Input | undefined
        if (input) await this.dispatch(slot, input)
      }
    } catch (error) {
      try {
        slot.debugger?.close()
        this.core.debuggerControl.settleRun(run_id)
      } catch {}
      const persisted = this.core.db
        .prepare('SELECT processes,ipc_path FROM provider_runs WHERE run_id=?')
        .get(run_id) as { processes: string; ipc_path: string | null } | undefined
      let cleaned = true
      if (persisted)
        await adapter
          .reconcile(JSON.parse(persisted.processes), persisted.ipc_path ?? undefined)
          .catch(() => (cleaned = false))
      this.core.transaction(() => {
        const code = error instanceof ChannelError ? error.code : 'provider_failed'
        {
          // Startup did not return a live session, so this input was never sent.
          const current = this.core.db
            .prepare('SELECT * FROM inputs WHERE input_id=?')
            .get(String(first.input_id)) as Input
          if (['accepted', 'queued'].includes(String(current.state)))
            this.core.transition(current, 'failed')
          this.owner.admissionFailed(
            session_id,
            String(first.input_id),
            run_id,
            error instanceof Error ? error.message : code
          )
        }
        this.core.append(session_id, 'session.process', actor, {
          run_id,
          state: 'exited',
          reason: (error instanceof Error ? error.message : code).slice(0, 256),
        })
        if (persisted && cleaned)
          this.core.db
            .prepare("UPDATE provider_runs SET state='settled' WHERE run_id=?")
            .run(run_id)
        if (leased && cleaned) this.core.resources.targets.settle(session_id, run_id)
      })
      this.backoff(session_id)
      if (!cleaned && persisted) {
        slot.state = 'stopping'
        slot.cleanupPending = true
      }
      if (this.slots.get(session_id) === slot && (cleaned || !persisted))
        this.slots.delete(session_id)
    }
  }
  private backoff(session_id: string) {
    const previous = this.failures.get(session_id)
    const count = (previous?.count ?? 0) + 1
    this.failures.set(session_id, {
      count,
      until: Date.now() + Math.min(this.retryMs * 2 ** (count - 1), 10 * 60000),
    })
  }
  private exited(slot: Slot, result: Awaited<LiveSession['done']>) {
    const { session_id, run_id } = slot
    if (slot.detaching && result.reason === 'detached') {
      // Still running: the run, its lease and its inputs stay as they are for the next node.
      try {
        slot.debugger?.close()
      } catch {}
      if (this.slots.get(session_id) === slot) this.slots.delete(session_id)
      return
    }
    try {
      slot.debugger?.close()
      this.core.debuggerControl.settleRun(run_id)
    } catch {}
    const unconfirmed = result.reason === 'process_cleanup_unconfirmed'
    const expected = !!slot.stopReason
    const reason = (slot.stopReason ?? result.reason ?? 'process_exited').slice(0, 256)
    const terminalReason = (slot.stopReason ?? result.failure_reason ?? reason).slice(0, 256)
    this.core.transaction(() => {
      // In-flight inputs: the process is gone, whether they took effect is unknown.
      for (const input of this.core.db
        .prepare("SELECT * FROM inputs WHERE run_id=? AND state IN ('dispatching','delivered')")
        .all(run_id) as Input[])
        this.core.transition(
          input,
          slot.stopReason === 'stopped_by_owner' && input.state === 'delivered'
            ? 'interrupted'
            : 'delivery_unknown'
        )
      if (slot.turn)
        this.core.append(session_id, 'turn.completed', actor, {
          run_id,
          turn_id: slot.turn.turn_id,
          outcome: 'interrupted',
          input_ids: [],
          subtype: 'process_exited',
          num_turns: null,
          duration_ms: null,
          total_cost_usd: null,
          terminal_reason: terminalReason,
        })
      this.owner.invalidate(run_id)
      this.core.append(session_id, 'session.process', actor, {
        run_id,
        state: 'exited',
        reason,
        exit_code: result.exit_code ?? null,
        ...(slot.tasks.length ? { lost_tasks: slot.tasks } : {}),
      })
      if (!unconfirmed) {
        this.core.db.prepare("UPDATE provider_runs SET state='settled' WHERE run_id=?").run(run_id)
        this.core.resources.targets.settle(session_id, run_id)
      }
    })
    if (!expected && Date.now() - slot.startedAt < 30000) this.backoff(session_id)
    if (unconfirmed) {
      slot.state = 'stopping'
      slot.cleanupPending = true
      this.core.append(session_id, 'session.error', actor, {
        run_id,
        code: 'process_cleanup_unconfirmed',
        message: `Provider cleanup is unconfirmed; this execution target remains busy. Reason: ${terminalReason}`,
      })
    } else if (this.slots.get(session_id) === slot) this.slots.delete(session_id)
  }
  private record(slot: Slot, event: ProviderEvent) {
    this.core.transaction(() => {
      this.apply(slot, event)
      if (SAVED_ON.has(LIFECYCLE[event.type] ?? event.type)) this.save(slot)
    })
  }
  private apply(slot: Slot, event: ProviderEvent) {
    const { session_id, run_id } = slot
    const d = event.data
    {
      switch (LIFECYCLE[event.type] ?? event.type) {
        case 'pi.session.bound': {
          const native = d.native_session_id,
            file = d.native_session_file
          const session = this.core.session(session_id)
          if (typeof native !== 'string' || typeof file !== 'string')
            throw new Error('invalid_pi_session_mapping')
          if (native === session.native_session_id && file === session.native_session_file) break
          const updated = SessionSchema.parse({
            ...session,
            native_session_id: native,
            native_session_file: file,
          })
          this.core.db
            .prepare(
              "INSERT INTO provider_native_sessions(session_id,provider,native_session_id,session_file) VALUES(?,'pi',?,?) ON CONFLICT(session_id) DO UPDATE SET native_session_id=excluded.native_session_id,session_file=excluded.session_file"
            )
            .run(session_id, native, file)
          this.core.db
            .prepare('UPDATE sessions SET body=? WHERE session_id=?')
            .run(JSON.stringify(updated), session_id)
          this.core.append(session_id, 'session.updated', actor, updated)
          this.core.append('catalog', 'session.updated', actor, updated)
          break
        }
        case 'codex.session.bound': {
          const session = this.core.session(session_id)
          const thread = String(d.native_session_id)
          this.owner.recordCodexBinding(session_id, thread, d)
          if (session.native_session_id && session.native_session_id !== thread)
            throw new Error('native_session_id_mismatch')
          if (session.native_session_id === thread) break
          const updated = SessionSchema.parse({ ...session, native_session_id: thread })
          this.core.db
            .prepare('UPDATE sessions SET body=? WHERE session_id=?')
            .run(JSON.stringify(updated), session_id)
          this.core.append(session_id, 'session.updated', actor, updated)
          this.core.append('catalog', 'session.updated', actor, updated)
          break
        }
        case 'pi.compact.started': {
          if (!slot.compacting) {
            slot.compacting = true
            this.core.append(session_id, 'compaction.started', actor, { run_id })
          }
          return
        }
        case 'pi.compact.failed': {
          slot.compacting = false
          slot.compaction = undefined
          this.core.append(session_id, 'compaction.completed', actor, {
            run_id,
            result: 'failed',
            trigger: (d.trigger as string | null) ?? null,
            pre_tokens: null,
            post_tokens: null,
            duration_ms: null,
            error: typeof d.error === 'string' ? d.error.slice(0, 256) : null,
          })
          return
        }
        case 'live.native':
        case 'claude.init': {
          const native =
            event.type === 'live.native'
              ? d.native_session_id
              : (d.configuration as Record<string, unknown>)?.session_id
          const session = this.core.session(session_id)
          if (typeof native === 'string' && native !== session.native_session_id) {
            const updated = SessionSchema.parse({ ...session, native_session_id: native })
            this.core.db
              .prepare('UPDATE sessions SET body=? WHERE session_id=?')
              .run(JSON.stringify(updated), session_id)
            this.core.append(session_id, 'session.updated', actor, updated)
            this.core.append('catalog', 'session.updated', actor, updated)
          }
          if (event.type === 'live.native') return
          break
        }
        case 'claude.input.delivered': {
          const input = this.core.db
            .prepare("SELECT * FROM inputs WHERE input_id=? AND run_id=? AND state='dispatching'")
            .get(String(d.input_id), run_id) as Input | undefined
          if (!input) return
          this.core.transition(input, 'delivered')
          const body = JSON.parse(String(input.body)) as {
            text: string
            compact?: boolean
            continue?: boolean
          }
          if (body.compact || /^\/compact(\s|$)/.test(body.text))
            slot.compaction = {
              principal: String(input.principal_id),
              continue: body.continue ?? this.effective(session_id).continue_after_compaction,
            }
          return
        }
        case 'claude.turn.started': {
          if (this.core.ownerStopRefusal(session_id))
            queueMicrotask(() => {
              if (this.core.ownerStopRefusal(session_id))
                void slot.live?.interrupt().catch(() => {})
            })
          slot.turn = {
            turn_id: randomUUID(),
            trigger: String(d.trigger ?? 'unknown').slice(0, 32),
            started_at: new Date().toISOString(),
          }
          slot.state = slot.state === 'stopping' ? 'stopping' : 'running'
          this.core.append(session_id, 'turn.started', actor, {
            run_id,
            turn_id: slot.turn.turn_id,
            trigger: slot.turn.trigger,
          })
          return
        }
        case 'claude.turn.completed': {
          void this.core.resources.lsp.afterEdit(session_id)
          const ids = (Array.isArray(d.input_ids) ? d.input_ids : []).map(String)
          const turn_id = slot.turn?.turn_id ?? randomUUID()
          const outcome = String(d.outcome) as 'success' | 'failed' | 'interrupted'
          for (const id of ids) {
            const input = this.core.db
              .prepare(
                "SELECT * FROM inputs WHERE input_id=? AND run_id=? AND state IN ('dispatching','delivered')"
              )
              .get(id, run_id) as Input | undefined
            if (input)
              this.core.transition(
                input,
                outcome === 'success'
                  ? 'completed'
                  : outcome === 'failed'
                    ? 'failed'
                    : 'interrupted'
              )
          }
          this.core.append(session_id, 'turn.completed', actor, {
            run_id,
            turn_id,
            outcome,
            input_ids: ids,
            subtype: (d.subtype as string | null) ?? null,
            num_turns: (d.num_turns as number | null) ?? null,
            duration_ms: (d.duration_ms as number | null) ?? null,
            total_cost_usd: (d.total_cost_usd as number | null) ?? null,
            terminal_reason: (d.terminal_reason as string | null) ?? null,
          })
          const final_reply = this.owner.finalReply(session_id, turn_id)
          for (const input_id of ids)
            this.core.append(session_id, 'input.reply', actor, {
              input_id,
              run_id,
              turn_id,
              outcome,
              final_reply,
            })
          for (const prompt of this.core.pendingPrompts(session_id, run_id))
            if (prompt.state === 'pending' && prompt.run_id === run_id)
              this.core.resolvePrompt(prompt, 'invalidated', 'deny', null)
          slot.turn = undefined
          if (slot.state === 'running') slot.state = 'idle'
          slot.idleSince = Date.now()
          if (outcome === 'success') this.failures.delete(session_id)
          const next = slot.continueAfterTurn
          slot.continueAfterTurn = undefined
          if (next && slot.state === 'idle') this.continuation(session_id, next)
          return
        }
        case 'claude.tasks': {
          slot.tasks = (Array.isArray(d.tasks) ? d.tasks : []).slice(0, 256).map((t: any) => ({
            task_id: String(t?.task_id ?? '').slice(0, 256),
            task_type: typeof t?.task_type === 'string' ? t.task_type.slice(0, 128) : null,
            description: typeof t?.description === 'string' ? t.description.slice(0, 4096) : null,
          }))
          this.core.append(session_id, 'session.tasks', actor, { run_id, tasks: slot.tasks })
          return
        }
        case 'claude.context': {
          const { categories, ...numbers } = d as Record<string, any>
          slot.context = {
            ...(numbers as Omit<NonNullable<Slot['context']>, 'categories'>),
            categories: Array.isArray(categories) ? categories : [],
          }
          this.core.append(session_id, 'session.context', actor, { run_id, ...slot.context })
          return
        }
        case 'claude.status': {
          if (typeof d.permission_mode === 'string')
            slot.settings = { ...slot.settings, permission_mode: d.permission_mode }
          if (d.status === 'compacting' && !slot.compacting) {
            slot.compacting = true
            this.core.append(session_id, 'compaction.started', actor, { run_id })
          } else if (slot.compacting && d.status !== 'compacting' && d.compact_result) {
            slot.compacting = false
            if (d.compact_result !== 'success')
              this.core.append(session_id, 'compaction.completed', actor, {
                run_id,
                result: 'failed',
                trigger: null,
                pre_tokens: null,
                post_tokens: null,
                duration_ms: null,
                error: typeof d.compact_error === 'string' ? d.compact_error.slice(0, 256) : null,
              })
          }
          break
        }
        case 'claude.compact.boundary': {
          slot.compacting = false
          this.core.append(session_id, 'compaction.completed', actor, {
            run_id,
            result: 'success',
            trigger: (d.trigger as string | null) ?? null,
            pre_tokens: (d.pre_tokens as number | null) ?? null,
            post_tokens: (d.post_tokens as number | null) ?? null,
            duration_ms: (d.duration_ms as number | null) ?? null,
            error: null,
          })
          // Only a compaction someone asked for continues; an automatic one is mid-turn anyway.
          if (slot.compaction && d.trigger !== 'auto') {
            if (slot.compaction.continue)
              slot.continueAfterTurn = {
                principal: slot.compaction.principal,
                text: this.effective(session_id).continuation_text,
              }
            slot.compaction = undefined
          }
          return
        }
        case 'claude.compact.summary': {
          this.owner.appendProviderEvent(session_id, run_id, {
            type: 'compaction.summary',
            data: { text: d.text },
          })
          return
        }
        case 'claude.tool.call': {
          if (d.name === 'CronCreate') slot.crons++
          if (d.name === 'CronDelete') slot.crons = Math.max(0, slot.crons - 1)
          if (d.name === 'ScheduleWakeup') {
            const seconds = Number((d.input as Record<string, unknown>)?.delaySeconds)
            if (Number.isFinite(seconds) && seconds > 0)
              slot.wakeUntil = Math.max(slot.wakeUntil, Date.now() + (seconds + 60) * 1000)
          }
          break
        }
      }
      this.owner.appendProviderEvent(session_id, run_id, event)
    }
  }
  /** After a requested compaction the session goes on by itself, as the owner's own input. */
  private continuation(session_id: string, next: { principal: string; text: string }) {
    if (this.core.ownerStopRefusal(session_id)) return
    const input_id = randomUUID()
    const body = {
      session_id,
      text: next.text,
      observed_seq: this.core.head(session_id),
      script: [{ kind: 'echo' }],
    }
    this.core.append(session_id, 'input.accepted', actor, {
      input_id,
      text: next.text,
      observed_seq: body.observed_seq,
      continuation: true,
    })
    this.core.db
      .prepare('INSERT INTO inputs(input_id,session_id,principal_id,state,body) VALUES(?,?,?,?,?)')
      .run(input_id, session_id, next.principal, 'accepted', JSON.stringify(body))
    const input = this.core.db
      .prepare('SELECT * FROM inputs WHERE input_id=?')
      .get(input_id) as Input
    this.core.transition(input, 'queued')
  }
}
