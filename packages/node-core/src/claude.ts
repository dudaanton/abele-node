import { randomUUID, createHash } from 'node:crypto'
import { ChannelError } from '@abele/channel-protocol'
import { PromptSchema, SessionSchema, type Prompt } from '@abele/node-protocol'
import type {
  ProviderRun,
  ProcessIdentity,
  PermissionAction,
  ClaudeEvent,
} from '@abele/provider-claude'
import { canonical, type NodeCore } from './index.js'
import type { ProviderAdapter } from './providers.js'
import type { PiAction } from '@abele/provider-pi'
import { updateInProgress, tryRunAdmission } from './update-lock.js'

type Input = Record<string, string | number | null>
const actor = { kind: 'node' } as const
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
type ActiveRun = {
  run_id: string
  run?: ProviderRun
  starting: boolean
  completion?: Promise<void>
}
/** The durable queue is the only input owner. External process effects are never inside SQL transactions. */
export class ProviderSessions {
  private active = new Map<string, ActiveRun>()
  private stopping = false
  constructor(
    private core: NodeCore,
    private adapter?: ProviderAdapter,
    private piAdapter?: ProviderAdapter
  ) {}
  private adapterFor(provider: string) {
    return provider === 'pi' ? this.piAdapter : this.adapter
  }
  isAvailable(provider: string) {
    return this.adapterFor(provider)?.available ?? false
  }
  get available() {
    return this.isAvailable('claude')
  }
  capabilities(provider = 'claude') {
    return (
      this.adapterFor(provider)?.capabilities() ?? {
        provider,
        available: false,
        diagnostic: 'Provider adapter not configured',
      }
    )
  }
  async reconcile() {
    const rows = this.core.db.prepare("SELECT * FROM provider_runs WHERE state='active'").all() as {
      run_id: string
      session_id: string
      processes: string
      ipc_path: string | null
    }[]
    for (const row of rows) {
      const adapter = this.adapterFor(this.core.session(row.session_id).provider)
      if (!adapter) throw new Error('provider_reconciliation_required')
      await adapter.reconcile(JSON.parse(row.processes), row.ipc_path ?? undefined)
      this.core.transaction(() =>
        this.core.db
          .prepare("UPDATE provider_runs SET state='unknown' WHERE run_id=?")
          .run(row.run_id)
      )
    }
  }
  async stop() {
    this.stopping = true
    while (this.active.size) {
      const ready = [...this.active].filter(([, slot]) => !slot.starting)
      const attempts = await Promise.allSettled(
        ready.map(([session, slot]) => this.retryCleanup(session, slot))
      )
      const failed = attempts.find(
        (attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected'
      )
      if (failed) throw failed.reason
      if (this.active.size) await delay(20)
    }
    // Durable orphan records are also obligations, never a successful empty-map stop.
    await this.reconcile()
  }
  private async retryCleanup(session: string, slot: ActiveRun) {
    if (slot.run) {
      await slot.run.interrupt()
      await slot.run.done
      await slot.completion
    } else {
      const row = this.core.db
        .prepare('SELECT processes,ipc_path FROM provider_runs WHERE run_id=?')
        .get(slot.run_id) as { processes: string; ipc_path: string | null } | undefined
      if (row) {
        const adapter = this.adapterFor(this.core.session(session).provider)
        if (!adapter) throw new Error('provider_reconciliation_required')
        await adapter.reconcile(JSON.parse(row.processes), row.ipc_path ?? undefined)
      }
    }
    this.core.transaction(() => {
      const input = this.core.db.prepare('SELECT * FROM inputs WHERE run_id=?').get(slot.run_id) as
        Input | undefined
      if (input && ['dispatching', 'delivered'].includes(String(input.state)))
        this.core.transition(input, 'delivery_unknown')
      this.invalidate(slot.run_id)
      this.core.db
        .prepare("UPDATE provider_runs SET state='settled' WHERE run_id=?")
        .run(slot.run_id)
    })
    if (this.active.get(session) === slot) this.active.delete(session)
  }
  async drain() {
    for (const [session, active] of this.active) {
      if (active.starting) continue
      const input = this.core.db
        .prepare('SELECT state FROM inputs WHERE run_id=?')
        .get(active.run_id) as { state: string }
      if (!active.starting && !['dispatching', 'delivered'].includes(input.state))
        await this.retryCleanup(session, active)
    }
    if (this.stopping || updateInProgress(this.core.stateDir)) return
    const rows = this.core.db
      .prepare("SELECT * FROM inputs WHERE state IN ('accepted','queued') ORDER BY ordinal")
      .all() as Input[]
    for (const input of rows) {
      if (this.stopping || updateInProgress(this.core.stateDir) || this.active.size >= 4) break
      const session = this.core.session(String(input.session_id))
      const adapter = this.adapterFor(session.provider)
      if (session.provider === 'fake' || !adapter?.available || this.active.has(session.session_id))
        continue
      if (!session.workspace_id || this.core.workspaceProvisioning(session.session_id)) continue
      // Reserve worker ownership before any asynchronous validation; no two drain calls can select it.
      const run_id = randomUUID()
      const slot: ActiveRun = { run_id, starting: true }
      this.active.set(session.session_id, slot)
      try {
        this.core.checkExecution(String(input.principal_id), session.session_id)
        const workspace = this.core.resources.workspaces.get(session.workspace_id)
        const project = await this.core.resources.workspaces.bound(workspace)
        if (project.trust !== 'trusted') throw new ChannelError('project_untrusted')
        const releaseAdmission = tryRunAdmission(this.core.stateDir)
        if (!releaseAdmission) {
          this.active.delete(session.session_id)
          return
        }
        let useRepositoryPermissions = false
        try {
          if (this.stopping || updateInProgress(this.core.stateDir, true)) {
            this.active.delete(session.session_id)
            return
          }
          // Recheck cancellation and principal after async filesystem checks, before durable dispatch.
          const current = this.core.db
            .prepare('SELECT * FROM inputs WHERE input_id=?')
            .get(String(input.input_id)) as Input
          if (!['accepted', 'queued'].includes(String(current.state))) {
            this.active.delete(session.session_id)
            continue
          }
          this.core.transaction(() => {
            const currentProject = this.core.resources.projects.get(project.project_id)
            if (currentProject.trust !== 'trusted') throw new ChannelError('project_untrusted')
            useRepositoryPermissions = currentProject.use_repository_claude_permissions
            this.core.checkExecution(String(input.principal_id), session.session_id)
            input.run_id = run_id
            this.core.db
              .prepare('UPDATE inputs SET run_id=? WHERE input_id=?')
              .run(run_id, String(input.input_id))
            this.core.transition(input, 'dispatching')
            this.core.db
              .prepare("INSERT INTO provider_runs(run_id,session_id,state) VALUES(?,?,'active')")
              .run(run_id, session.session_id)
            this.core.append(session.session_id, 'run.started', actor, {
              run_id,
              input_id: input.input_id,
              configuration: adapter.configurationForTurn({
                use_repository_claude_permissions: useRepositoryPermissions,
              }),
              native_session_id: session.native_session_id ?? null,
            })
          })
        } finally {
          releaseAdmission()
        }
        const body = JSON.parse(String(input.body)) as { text: string }
        slot.run = await adapter.startTurn(
          {
            session_id: session.session_id,
            run_id,
            cwd: workspace.path,
            text: this.core.delegations.turnText(session.session_id, body.text),
            native_session_id: session.native_session_id,
            native_session_file: session.native_session_file,
            use_repository_claude_permissions: useRepositoryPermissions,
          },
          {
            processes: (evidence) => this.persistProcesses(run_id, evidence),
            reaped: (leader) =>
              this.core.transaction(() => {
                const row = this.core.db
                  .prepare('SELECT processes FROM provider_runs WHERE run_id=?')
                  .get(run_id) as { processes: string }
                const remaining = (JSON.parse(row.processes) as ProcessIdentity[]).filter(
                  (p) => p.group !== leader.group
                )
                this.core.db
                  .prepare('UPDATE provider_runs SET processes=? WHERE run_id=?')
                  .run(JSON.stringify(remaining), run_id)
                this.core.append(session.session_id, 'pi.process.group_reaped', actor, {
                  run_id,
                  group: leader.group,
                })
              }),
            ipc: (directory) =>
              this.core.transaction(() =>
                this.core.db
                  .prepare('UPDATE provider_runs SET ipc_path=? WHERE run_id=?')
                  .run(directory, run_id)
              ),
            event: (event) => this.record(input, event),
            report: (report) =>
              this.core.delegations.reporter(session.session_id, run_id).report(report),
            permission: (action, signal) => this.permission(input, action, signal),
            question: (action, signal) => this.permission(input, action, signal),
          }
        )
        if (this.stopping) await slot.run.interrupt()
        slot.completion = slot.run.done
          .then((result) => {
            this.core.transaction(() => {
              const current = this.core.db
                .prepare('SELECT * FROM inputs WHERE input_id=?')
                .get(String(input.input_id)) as Input
              // An interrupt is already unknown and must never be upgraded by a late terminal record.
              if (['dispatching', 'delivered'].includes(String(current.state))) {
                const success =
                  !result.reason &&
                  result.result?.subtype === 'success' &&
                  result.result?.is_error !== true
                const state = success
                  ? 'completed'
                  : result.result && !result.reason
                    ? 'failed'
                    : 'delivery_unknown'
                this.core.transition(current, state)
                this.core.append(
                  session.session_id,
                  success ? 'run.completed' : state === 'failed' ? 'run.failed' : 'run.interrupted',
                  actor,
                  {
                    run_id,
                    outcome: success ? 'success' : state === 'failed' ? 'failed' : 'unknown',
                    reason:
                      result.reason ??
                      (result.result?.is_error === true
                        ? (result.result.terminal_reason ?? 'provider_error')
                        : success
                          ? null
                          : (result.result?.subtype ?? null)),
                  }
                )
              }
              this.invalidate(run_id)
              if (result.reason === 'process_cleanup_unconfirmed') this.stopping = true
              else
                this.core.db
                  .prepare("UPDATE provider_runs SET state='settled' WHERE run_id=?")
                  .run(run_id)
            })
            if (
              result.reason !== 'process_cleanup_unconfirmed' &&
              this.active.get(session.session_id) === slot
            )
              this.active.delete(session.session_id)
          })
          .catch(() => {
            this.stopping = true
          })
      } catch (error) {
        let cleaned = false
        try {
          const persisted = this.core.db
            .prepare('SELECT processes,ipc_path FROM provider_runs WHERE run_id=?')
            .get(run_id) as { processes: string; ipc_path: string | null } | undefined
          cleaned = true
          if (persisted) {
            try {
              await adapter.reconcile(
                JSON.parse(persisted.processes),
                persisted.ipc_path ?? undefined
              )
            } catch {
              cleaned = false
              this.stopping = true
            }
          }
          this.core.transaction(() => {
            const current = this.core.db
              .prepare('SELECT * FROM inputs WHERE input_id=?')
              .get(String(input.input_id)) as Input
            if (['accepted', 'queued', 'dispatching'].includes(String(current.state)))
              this.core.transition(current, current.run_id ? 'delivery_unknown' : 'failed')
            this.core.append(session.session_id, 'run.failed', actor, {
              run_id,
              reason: error instanceof Error ? error.message : 'provider_failed',
              outcome: input.run_id ? 'unknown' : 'not_dispatched',
            })
            this.invalidate(run_id)
            if (persisted && cleaned)
              this.core.db
                .prepare("UPDATE provider_runs SET state='settled' WHERE run_id=?")
                .run(run_id)
          })
        } finally {
          if (cleaned && this.active.get(session.session_id) === slot)
            this.active.delete(session.session_id)
        }
      } finally {
        slot.starting = false
      }
    }
  }
  private persistProcesses(run_id: string, evidence: ProcessIdentity[]) {
    if (
      !evidence.every(
        (p) =>
          Number.isSafeInteger(p.pid) &&
          p.pid > 1 &&
          typeof p.fingerprint === 'string' &&
          p.fingerprint.length < 65536 &&
          Number.isSafeInteger(p.group) &&
          p.group > 1
      )
    )
      throw new Error('invalid_worker_evidence')
    this.core.transaction(() => {
      const row = this.core.db
        .prepare('SELECT processes FROM provider_runs WHERE run_id=?')
        .get(run_id) as { processes: string }
      const map = new Map<number, ProcessIdentity>(
        (JSON.parse(row.processes) as ProcessIdentity[]).map((p) => [p.pid, p])
      )
      for (const p of evidence) map.set(p.pid, p)
      this.core.db
        .prepare('UPDATE provider_runs SET processes=? WHERE run_id=?')
        .run(JSON.stringify([...map.values()]), run_id)
    })
  }
  private record(input: Input, event: ClaudeEvent) {
    this.core.transaction(() => {
      const session_id = String(input.session_id),
        run_id = String(input.run_id)
      const current = this.core.db
        .prepare('SELECT * FROM inputs WHERE input_id=?')
        .get(String(input.input_id)) as Input
      const late = !['dispatching', 'delivered'].includes(String(current.state))
      if (event.type === 'claude.init' || event.type === 'pi.session.bound') {
        const init =
          event.type === 'claude.init'
            ? (event.data.configuration as Record<string, unknown>)
            : {
                session_id: event.data.native_session_id,
                native_session_file: event.data.native_session_file,
              }
        const session = this.core.session(session_id)
        const updated = SessionSchema.parse({
          ...session,
          native_session_id: init.session_id,
          ...(event.type === 'pi.session.bound'
            ? { native_session_file: init.native_session_file }
            : {}),
        })
        if (
          !updated.native_session_id ||
          (session.provider === 'claude' &&
            session.native_session_id &&
            session.native_session_id !== updated.native_session_id)
        )
          throw new Error('native_session_id_mismatch')
        if (session.provider === 'pi')
          this.core.db
            .prepare(
              "INSERT INTO provider_native_sessions(session_id,provider,native_session_id,session_file) VALUES(?,'pi',?,?) ON CONFLICT(session_id) DO UPDATE SET native_session_id=excluded.native_session_id,session_file=excluded.session_file"
            )
            .run(session_id, updated.native_session_id!, updated.native_session_file!)
        this.core.db
          .prepare('UPDATE sessions SET body=? WHERE session_id=?')
          .run(JSON.stringify(updated), session_id)
        this.core.append(session_id, 'session.updated', actor, updated)
        this.core.append('catalog', 'session.updated', actor, updated)
      }
      if (
        current.state === 'dispatching' &&
        ['claude.block.lifecycle', 'claude.message.final', 'pi.input.accepted'].includes(event.type)
      )
        this.core.transition(current, 'delivered')
      if (!late) this.core.delegations.observe(session_id, run_id, event)
      let data: Record<string, unknown> = {
        ...event.data,
        ...(event.data.run_id !== undefined && event.data.run_id !== run_id
          ? { provider_run_id: event.data.run_id }
          : {}),
        run_id,
        ...(late ? { late: true } : {}),
      }
      const bytes = Buffer.from(JSON.stringify(event.data))
      if (event.type === 'claude.raw' || bytes.length > 8192) {
        const artifact_id = randomUUID()
        this.core.db
          .prepare('INSERT INTO artifacts VALUES(?,?,?)')
          .run(artifact_id, session_id, bytes)
        data = {
          run_id,
          artifact_id,
          size: bytes.length,
          ...(late ? { late: true } : {}),
          ...(event.type === 'claude.raw' ? { channel: event.data.channel } : {}),
        }
      }
      this.core.append(
        session_id,
        event.type,
        { kind: 'provider', provider: this.core.session(session_id).provider, session_id },
        data
      )
    })
  }
  private invalidate(run_id: string) {
    const rows = this.core.db.prepare('SELECT body FROM prompts WHERE run_id=?').all(run_id) as {
      body: string
    }[]
    for (const row of rows) {
      const p = PromptSchema.parse(JSON.parse(row.body))
      if (p.state === 'pending') this.core.resolvePrompt(p, 'invalidated', 'deny', null)
    }
  }
  private async permission(
    input: Input,
    action: PermissionAction & Partial<PiAction>,
    signal: AbortSignal
  ) {
    const session_id = String(input.session_id),
      run_id = String(input.run_id)
    const action_digest = createHash('sha256')
      .update(canonical({ run_id, ...action }))
      .digest('hex')
    let prompt!: Prompt
    const reservation_id = randomUUID()
    let reserved = false
    this.core.transaction(() => {
      const current = this.core.db
        .prepare('SELECT state FROM inputs WHERE input_id=?')
        .get(String(input.input_id)) as { state: string }
      if (!['dispatching', 'delivered'].includes(current.state))
        throw new ChannelError('stale_revision')
      this.core.checkExecution(String(input.principal_id), session_id)
      const previous = this.core.db
        .prepare(
          "SELECT body FROM prompts WHERE session_id=? AND run_id=? AND json_extract(body,'$.action_digest')=?"
        )
        .get(session_id, run_id, action_digest) as { body: string } | undefined
      prompt =
        (previous ? PromptSchema.parse(JSON.parse(previous.body)) : undefined) ??
        PromptSchema.parse({
          prompt_id: randomUUID(),
          session_id,
          run_id,
          revision: 1,
          action_digest,
          expires_at:
            Date.now() +
            Math.min(
              Number(
                this.adapterFor(this.core.session(session_id).provider)!.configuration
                  .permission_ttl_ms
              ),
              action.ttl_ms ?? 3600000
            ),
          state: 'pending',
          choice: null,
          installation_id: null,
          delivered: false,
          ...Object.fromEntries(Object.entries(action).filter(([key]) => key !== 'ttl_ms')),
        })
      const bytes = Buffer.byteLength(JSON.stringify(prompt))
      if (bytes > 128 * 1024) throw new ChannelError('record_too_large')
      if (!this.core.db.prepare('SELECT 1 FROM prompts WHERE prompt_id=?').get(prompt.prompt_id)) {
        this.core.db
          .prepare('INSERT INTO prompts VALUES(?,?,?,?)')
          .run(prompt.prompt_id, session_id, run_id, JSON.stringify(prompt))
        this.core.append(session_id, 'prompt.opened', actor, prompt)
      }
      if (!prompt.delivered)
        reserved =
          this.core.db
            .prepare(
              "INSERT INTO prompt_deliveries(prompt_id,reservation_id,state) VALUES(?,?,'reserved') ON CONFLICT(prompt_id) DO NOTHING"
            )
            .run(prompt.prompt_id, reservation_id).changes === 1
    })
    if (!reserved) return { choice: 'deny' as const, delivered: () => false }
    for (;;) {
      prompt = this.core.prompt(prompt.prompt_id)
      if (signal.aborted && prompt.state === 'pending')
        this.core.transaction(() => {
          prompt = this.core.resolvePrompt(prompt, 'invalidated', 'deny', null)
        })
      if (prompt.state !== 'pending') break
      if (Date.now() >= prompt.expires_at)
        this.core.transaction(() => {
          prompt = this.core.resolvePrompt(prompt, 'expired', 'deny', null)
        })
      else await delay(20)
    }
    const choice =
      !signal.aborted &&
      !prompt.delivered &&
      prompt.state === 'resolved' &&
      prompt.choice === 'allow'
        ? ('allow' as const)
        : ('deny' as const)
    return {
      choice,
      ...(choice === 'allow' && prompt.value !== undefined && prompt.value !== null
        ? { value: prompt.value }
        : {}),
      delivered: () =>
        this.core.transaction(() => {
          const current = this.core.db
            .prepare('SELECT state FROM inputs WHERE input_id=?')
            .get(String(input.input_id)) as { state: string }
          if (!['dispatching', 'delivered'].includes(current.state)) return false
          const latest = this.core.prompt(prompt.prompt_id)
          this.core.checkExecution(String(input.principal_id), session_id)
          if (latest.installation_id)
            this.core.authority.check(
              { installation_id: latest.installation_id },
              'approve',
              session_id
            )
          if (latest.delivered) return false
          const consumed =
            this.core.db
              .prepare(
                "UPDATE prompt_deliveries SET state='consumed' WHERE prompt_id=? AND reservation_id=? AND state='reserved'"
              )
              .run(prompt.prompt_id, reservation_id).changes === 1
          if (!consumed) return false
          const updated = PromptSchema.parse({ ...latest, delivered: true })
          this.core.db
            .prepare('UPDATE prompts SET body=? WHERE prompt_id=?')
            .run(JSON.stringify(updated), prompt.prompt_id)
          this.core.append(session_id, 'prompt.delivered', actor, {
            prompt_id: prompt.prompt_id,
            run_id,
            choice,
            evidence:
              this.core.session(session_id).provider === 'pi'
                ? 'sdk_worker_ipc_ack'
                : 'bridge_ipc_ack',
          })
          return true
        }),
    }
  }
}
