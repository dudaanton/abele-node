import { createHash, randomUUID } from 'node:crypto'
import { ChannelError, type AuthorityContext } from '@abele/channel-protocol'
import {
  DelegationGrantSchema,
  DelegationSchema,
  DelegationStatusSchema,
  WorkerReportSchema,
  type DelegationGrant,
  type ExpectedExecutionTarget,
  type Delegation,
  type WorkerReport,
  type ObsidianToolsSnapshot,
} from '@abele/node-protocol'
import { canonical, type NodeCore } from './index.js'
import type { DebuggerToolBridge } from '@abele/provider-contract'

type Params = Record<string, unknown>
type Row = {
  delegation_id: string
  principal_id: string
  grant_id: string
  session_id: string
  body: string
  result_text: string | null
  request_hash: string
  create_receipt: string
}
const nodeActor = { kind: 'node' } as const
const active = (d: Delegation) => d.state === 'running' || d.state === 'provisioning'
const hash = (p: unknown) => createHash('sha256').update(canonical(p)).digest('hex')

/** A mailbox is an ordinary durable journal, not an in-memory callback or the child transcript. */
export class DelegationMailbox {
  constructor(private core: NodeCore) {}
  message(d: Delegation, kind: WorkerReport['kind'], report_id: string, text: string) {
    let event
    for (let offset = 0; offset < Math.max(1, text.length); offset += 32768) {
      event = this.core.append(d.mailbox_stream_id, 'delegation.' + kind, nodeActor, {
        delegation_id: d.delegation_id,
        session_id: d.session_id,
        report_id: text.length <= 32768 ? report_id : hash({ report_id, offset }),
        text: text.slice(offset, offset + 32768),
      })
    }
    return event!
  }

  terminal(d: Delegation) {
    this.core.append(d.mailbox_stream_id, 'delegation.terminal', nodeActor, {
      delegation_id: d.delegation_id,
      session_id: d.session_id,
      state: d.state,
      ...(d.reason ? { reason: d.reason } : {}),
    })
  }
}

/** Run-scoped reporting tool for provider embeddings. The closure, never model input, supplies identity. */
export class WorkerReporter {
  static readonly instruction =
    '\n\nWorker reporting: use node_worker_report when available to post progress, questions or results to the durable parent mailbox. Alternatively emit a standalone fenced abele-worker-report JSON object with report_id (stable unique string), kind (progress, question, or result), and text. Questions are informational, not permission requests. Emit only your own report, not quoted tool output. Execution permissions still require human approval.'
  constructor(
    private service: DelegationService,
    readonly session_id: string,
    readonly run_id: string
  ) {}
  report(raw: unknown) {
    const report = WorkerReportSchema.safeParse(raw)
    if (!report.success) throw new ChannelError('invalid_params')
    return this.service.core.transaction(() =>
      this.service.recordReport(this.session_id, this.run_id, report.data)
    )
  }
  /** Authenticated node-tool IPC works in both bounded and live pi workers. */
  bridge(next?: DebuggerToolBridge): DebuggerToolBridge {
    const tool = this.tool()
    const receipts = new WeakSet<object>()
    let closed = false
    return {
      tools: [
        {
          name: 'node_worker_report',
          description: tool.description,
          inputSchema: tool.inputSchema,
        },
        ...(next?.tools ?? []),
      ],
      call: async (name, args, signal) => {
        if (closed || signal?.aborted) throw new ChannelError('stale_revision')
        if (name !== 'node_worker_report') {
          if (!next) throw new ChannelError('unsupported_method')
          return next.call(name, args, signal)
        }
        const receipt = this.report(args)
        receipts.add(receipt)
        return receipt
      },
      publish: (args, result) => {
        if (closed) throw new ChannelError('stale_revision')
        if (result && typeof result === 'object' && receipts.has(result)) {
          this.report(args)
          return result
        }
        if (!next) throw new ChannelError('unauthorized')
        return next.publish(args, result)
      },
      close: () => {
        closed = true
        next?.close()
      },
    }
  }
  tool() {
    return {
      name: 'abele_worker_report',
      description:
        'Report task progress, a non-permission question, or a proposed final result to the parent. Completion is confirmed by the node, not this tool.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['report_id', 'kind', 'text'],
        properties: {
          report_id: { type: 'string', minLength: 1, maxLength: 128 },
          kind: { enum: ['progress', 'question', 'result'] },
          text: { type: 'string', minLength: 1, maxLength: 32768 },
        },
      },
      execute: (input: unknown) => this.report(input),
    }
  }
}

export class DelegationService {
  readonly mailbox: DelegationMailbox
  constructor(readonly core: NodeCore) {
    this.mailbox = new DelegationMailbox(core)
  }
  private row(id: string): Row {
    const row = this.core.db.prepare('SELECT * FROM delegations WHERE delegation_id=?').get(id) as
      Row | undefined
    if (!row) throw new ChannelError('not_found')
    return row
  }
  private grant(id: string): DelegationGrant {
    const row = this.core.db
      .prepare('SELECT body FROM delegation_grants WHERE grant_id=?')
      .get(id) as { body: string } | undefined
    if (!row) throw new ChannelError('not_found')
    return DelegationGrantSchema.parse(JSON.parse(row.body))
  }
  private authorize(
    actor: AuthorityContext,
    grant_id: string,
    action: DelegationGrant['actions'][number]
  ) {
    this.core.authority.check(actor, 'delegation')
    const grant = this.grant(grant_id)
    if (
      grant.installation_id !== actor.installation_id ||
      grant.revoked ||
      !grant.actions.includes(action)
    )
      throw new ChannelError('unauthorized')
    // Approval cannot outlive the approving installation's authority.
    this.core.authority.checkGrant(grant)
    return grant
  }
  private access(actor: AuthorityContext, id: string, action: DelegationGrant['actions'][number]) {
    const row = this.row(id)
    if (row.principal_id !== actor.installation_id) throw new ChannelError('unauthorized')
    this.authorize(actor, row.grant_id, action)
    return { row, d: DelegationSchema.parse(JSON.parse(row.body)) }
  }
  checkExecution(session_id: string) {
    const row = this.core.db
      .prepare('SELECT * FROM delegations WHERE session_id=?')
      .get(session_id) as Row | undefined
    if (!row) return
    const d = DelegationSchema.parse(JSON.parse(row.body))
    // Once closed, the retained child is a normal session. Controller sends remain closed.
    if (!active(d)) return
    const grant = this.authorize({ installation_id: row.principal_id }, row.grant_id, 'create')
    if (d.workspace_id) {
      this.core.resources.workspaces.assertLease(d.workspace_id, session_id)
      const project = this.core.resources.workspaces.get(d.workspace_id).project_id
      if (!grant.project_ids.includes(project)) throw new ChannelError('unauthorized')
      this.core.authority.check({ installation_id: row.principal_id }, 'execute', project)
    }
  }
  /** Repair pre-reservation children, including cancelled ones, without stealing another session's lease. */
  repairLeases() {
    for (const row of this.core.db
      .prepare(
        'SELECT * FROM delegations WHERE session_id NOT IN (SELECT session_id FROM deleted_sessions)'
      )
      .all() as Row[]) {
      const d = DelegationSchema.parse(JSON.parse(row.body))
      const session = this.core.session(d.session_id)
      if (
        !d.workspace_id ||
        session.workspace_id !== d.workspace_id ||
        this.core.resources.workspaces.leased(d.workspace_id)
      )
        continue
      const workspace = this.core.resources.workspaces.get(d.workspace_id)
      if (
        workspace.kind !== 'managed' ||
        workspace.state === 'removed' ||
        workspace.state === 'removing'
      )
        continue
      this.core.db
        .prepare('INSERT INTO workspace_leases VALUES(?,?)')
        .run(d.workspace_id, d.session_id)
    }
  }
  isActive(session_id: string) {
    return !!this.core.db
      .prepare(
        "SELECT 1 FROM delegations WHERE session_id=? AND json_extract(body,'$.state') IN ('provisioning','running')"
      )
      .get(session_id)
  }
  reporter(session_id: string, run_id: string) {
    return new WorkerReporter(this, session_id, run_id)
  }
  runStarted(session_id: string) {
    const row = this.core.db
      .prepare('SELECT * FROM delegations WHERE session_id=?')
      .get(session_id) as Row | undefined
    if (row) {
      const d = DelegationSchema.parse(JSON.parse(row.body))
      if (!active(d)) {
        // Cancellation closes controller reporting. An ordinary owner turn may
        // still run; only an explicit delegation.send reopens the delegation.
        if (d.state === 'cancelled') return
        // Retained owner sessions remain usable after revocation or rebinding.
        if ((this.core.session(session_id).workspace_id ?? null) !== d.workspace_id) return
        try {
          this.authorize({ installation_id: row.principal_id }, row.grant_id, 'create')
          if (d.workspace_id) this.core.resources.workspaces.assertLease(d.workspace_id, session_id)
        } catch (error) {
          if (error instanceof ChannelError) return
          throw error
        }
        d.state = 'running'
        delete d.reason
        this.save(d)
      }
    }
    this.core.db
      .prepare('UPDATE delegations SET result_text=NULL WHERE session_id=?')
      .run(session_id)
  }
  promptOpened(session_id: string, prompt: { prompt_id: string; run_id: string; kind?: string }) {
    const row = this.core.db
      .prepare('SELECT * FROM delegations WHERE session_id=?')
      .get(session_id) as Row | undefined
    if (!row) return
    const d = DelegationSchema.parse(JSON.parse(row.body))
    // Permission gates belong in the child approval UI. Wake the controller
    // once per run, while distinct extension questions still get notices.
    const permission = !prompt.kind || prompt.kind === 'permission'
    const run = prompt.run_id.startsWith('obsidian:')
      ? (this.core.db
          .prepare(
            'SELECT run_id FROM obsidian_tool_invocations WHERE invocation_id=? AND session_id=?'
          )
          .get(prompt.run_id.slice('obsidian:'.length), session_id)?.run_id ?? prompt.run_id)
      : prompt.run_id
    if (
      permission &&
      this.core.db
        .prepare(
          "SELECT 1 FROM prompts WHERE session_id=? AND (run_id=? OR run_id IN (SELECT 'obsidian:' || invocation_id FROM obsidian_tool_invocations WHERE session_id=? AND run_id=?)) AND prompt_id<>? AND COALESCE(json_extract(body,'$.kind'),'permission')='permission'"
        )
        .get(session_id, run, session_id, run, prompt.prompt_id)
    )
      return
    if (active(d))
      this.mailbox.message(
        d,
        'question',
        'prompt:' + prompt.prompt_id,
        'Waiting for owner approval. Open the child session to review the pending action. The controller cannot approve it.'
      )
  }
  private save(d: Delegation) {
    this.core.db
      .prepare('UPDATE delegations SET body=? WHERE delegation_id=?')
      .run(JSON.stringify(DelegationSchema.parse(d)), d.delegation_id)
  }
  permissionsChanged(
    session_id: string,
    tool_permissions: NonNullable<Delegation['tool_permissions']>
  ) {
    const row = this.core.db
      .prepare('SELECT body FROM delegations WHERE session_id=?')
      .get(session_id)
    if (!row) return
    this.save({ ...DelegationSchema.parse(JSON.parse(String(row.body))), tool_permissions })
  }
  request(actor: AuthorityContext, method: string, p: Params, operation?: string): unknown {
    if (method === 'delegation.status') {
      const { d } = this.access(actor, String(p.delegation_id), 'status')
      return DelegationStatusSchema.parse({
        ...d,
        worktree_id: d.workspace_id
          ? this.core.resources.repository.worktreeForWorkspace(d.workspace_id)
          : null,
        session_head_seq: this.core.head(d.session_id),
        mailbox_head_seq: this.core.head(d.mailbox_stream_id),
        pending_human_prompts: this.core.prompts(d.session_id).filter((p) => p.state === 'pending')
          .length,
        pending_prompts: this.core
          .prompts(d.session_id)
          .filter((p) => p.state === 'pending')
          .map((p) => ({ prompt_id: p.prompt_id, run_id: p.run_id, expires_at: p.expires_at })),
      })
    }
    if (method === 'delegation.create') return this.create(actor, p, operation)
    if (method === 'delegation.grant.create') {
      // All currently enrolled installations are owners. Keep this owner action OUT of model tools.
      this.core.authority.check(actor, 'approve_delegation')
      return this.core.commitOperation(actor, method, p, operation, () => {
        const installation_id = String(p.installation_id ?? actor.installation_id)
        const controller =
          installation_id === actor.installation_id
            ? actor
            : this.core.authority.forInstallation(installation_id)
        const controller_authority = this.core.authority.snapshot(controller)
        const owner_authority = this.core.authority.snapshot(actor)
        for (const project of p.project_ids as string[]) {
          this.core.authority.check({ installation_id }, 'delegate', project)
          this.core.resources.projects.get(project)
        }
        const grant = DelegationGrantSchema.parse({
          ...p,
          grant_id: randomUUID(),
          installation_id,
          approved_by: actor.installation_id,
          owner_authority,
          controller_authority,
          created_at: new Date().toISOString(),
          revoked: false,
        })
        this.core.db
          .prepare('INSERT INTO delegation_grants VALUES(?,?)')
          .run(grant.grant_id, JSON.stringify(grant))
        return grant
      })
    }
    if (method === 'delegation.grant.revoke') {
      this.core.authority.check(actor, 'approve_delegation')
      const grant = this.grant(String(p.grant_id))
      if (grant.approved_by !== actor.installation_id) throw new ChannelError('unauthorized')
      return this.core.commitOperation(actor, method, p, operation, () => {
        const updated = { ...grant, revoked: true }
        this.core.db
          .prepare('UPDATE delegation_grants SET body=? WHERE grant_id=?')
          .run(JSON.stringify(updated), grant.grant_id)
        for (const row of this.core.db
          .prepare('SELECT * FROM delegations WHERE grant_id=?')
          .all(grant.grant_id) as Row[]) {
          const d = DelegationSchema.parse(JSON.parse(row.body))
          if (active(d)) this.cancel(d)
        }
        return updated
      })
    }
    const action = method === 'delegation.send' ? 'send' : 'cancel'
    this.access(actor, String(p.delegation_id), action)
    return this.core.commitOperation(actor, method, p, operation, () => {
      const { d } = this.access(actor, String(p.delegation_id), action)
      if (method === 'delegation.delete') return this.core.deleteSession(actor, d.session_id)
      if (method === 'delegation.cancel') {
        if (active(d)) this.cancel(d)
        return d
      }
      if (method === 'delegation.send') {
        const refusal = this.core.resources.targets.refusal(
          d.session_id,
          p.expected_target as ExpectedExecutionTarget | undefined
        )
        if (refusal) return refusal
        if (!active(d)) {
          // A terminal state describes the last turn, not a closed conversation.
          d.state = 'running'
          delete d.reason
          this.save(d)
          this.core.db
            .prepare('UPDATE delegations SET result_text=NULL WHERE delegation_id=?')
            .run(d.delegation_id)
        }
        this.checkExecution(d.session_id)
        return this.core.acceptInput(actor, {
          session_id: d.session_id,
          text: p.text,
          observed_seq: p.observed_seq,
          expected_target: p.expected_target,
          script: [{ kind: 'echo' }],
        })
      }
      throw new ChannelError('unsupported_method')
    })
  }
  checkPublication(actor: AuthorityContext, method: string, p: Params) {
    if (method === 'delegation.create') this.creationAuthority(actor, p)
    else if (
      method === 'delegation.send' ||
      method === 'delegation.status' ||
      method === 'delegation.cancel' ||
      method === 'delegation.delete'
    )
      this.access(
        actor,
        String(p.delegation_id),
        method === 'delegation.delete'
          ? 'cancel'
          : (method.slice('delegation.'.length) as 'send' | 'status' | 'cancel')
      )
  }
  private creationAuthority(actor: AuthorityContext, p: Params): DelegationGrant {
    if (p.grant_id) return this.authorize(actor, String(p.grant_id), 'create')
    this.core.authority.check(actor, 'delegation', p.project_id as string | undefined)
    if (!p.parent_id) throw new ChannelError('invalid_params')
    const existing = this.core.db
      .prepare('SELECT * FROM delegations WHERE principal_id=? AND delegation_key=?')
      .get(actor.installation_id, String(p.delegation_key)) as Row | undefined
    if (existing) return this.authorize(actor, existing.grant_id, 'create')
    const authority = this.core.authority.snapshot(actor)
    // Persist ordinary installation authority using the same durable binding as legacy grants.
    // This is automatic provenance, not a separate approval or a model-controlled policy.
    return DelegationGrantSchema.parse({
      grant_id: randomUUID(),
      installation_id: actor.installation_id,
      approved_by: actor.installation_id,
      owner_authority: authority,
      controller_authority: authority,
      parent_id: p.parent_id,
      project_ids: p.project_id ? [p.project_id] : [],
      providers: ['fake', 'claude', 'pi', 'codex'],
      actions: ['create', 'send', 'status', 'cancel', 'read'],
      allow_fake: true,
      created_at: new Date().toISOString(),
      revoked: false,
    })
  }
  private async create(actor: AuthorityContext, p: Params, operation?: string) {
    const grant = this.creationAuthority(actor, p)
    const previous = this.core.operationReceipt(actor, 'delegation.create', p, operation)
    if (previous) return previous.result
    const find = () => {
      const row = this.core.db
        .prepare('SELECT * FROM delegations WHERE principal_id=? AND delegation_key=?')
        .get(actor.installation_id, String(p.delegation_key)) as Row | undefined
      if (!row) return
      if (row.request_hash !== hash(p)) throw new ChannelError('idempotency_mismatch')
      return DelegationSchema.parse(JSON.parse(row.create_receipt))
    }
    const existing = find()
    if (existing)
      return this.core.commitOperation(actor, 'delegation.create', p, operation, () => existing)
    if (!grant.providers.includes(p.provider as DelegationGrant['providers'][number]))
      throw new ChannelError('unauthorized')
    if (p.provider === 'fake' && !grant.allow_fake) throw new ChannelError('unauthorized')
    if (p.provider !== 'fake' && !p.project_id) throw new ChannelError('workspace_required')
    if (p.project_id && !grant.project_ids.includes(String(p.project_id)))
      throw new ChannelError('unauthorized')
    if (p.provider !== 'fake') {
      if (canonical(p.script) !== canonical([{ kind: 'echo' }]))
        throw new ChannelError('invalid_params')
      if (!this.core.execution.isAvailable(String(p.provider)))
        throw new ChannelError('provider_unavailable')
      if (this.core.resources.projects.get(String(p.project_id)).trust !== 'trusted')
        throw new ChannelError('project_untrusted')
    }
    const prepared = p.project_id
      ? await this.core.resources.prepareWorkspace(String(p.project_id), String(p.base_ref))
      : undefined
    return this.core.commitOperation(actor, 'delegation.create', p, operation, () => {
      const retry = find()
      if (retry) {
        this.creationAuthority(actor, p)
        return retry
      }
      if (
        !p.grant_id &&
        !this.core.db
          .prepare('SELECT 1 FROM delegation_grants WHERE grant_id=?')
          .get(grant.grant_id)
      ) {
        this.core.authority.checkGrant(grant)
        this.core.db
          .prepare('INSERT INTO delegation_grants VALUES(?,?)')
          .run(grant.grant_id, JSON.stringify(grant))
      }
      this.authorize(actor, grant.grant_id, 'create')
      const reserved = prepared
        ? this.core.resources.reserveWorkspace(actor, operation!, prepared)
        : undefined
      const child = this.core.acceptSession(
        actor,
        {
          title: p.title,
          provider: p.provider,
          settings: { permission_mode: p.permission_mode ?? 'manual' },
          ...(reserved ? { workspace_id: reserved.workspace_id } : {}),
        },
        !!reserved
      )
      const delegation_id = randomUUID()
      this.core.obsidianTools.inheritInTransaction(
        grant.parent_id,
        child.session_id,
        actor,
        p.obsidian_tools as ObsidianToolsSnapshot | undefined
      )
      const d = DelegationSchema.parse({
        node_id: this.core.node_id,
        session_id: child.session_id,
        delegation_id,
        delegation_key: p.delegation_key,
        grant_id: grant.grant_id,
        parent_id: grant.parent_id,
        mailbox_stream_id: 'delegation/' + delegation_id,
        workspace_id: reserved?.workspace_id ?? null,
        job_id: reserved?.job_id ?? null,
        state: reserved ? 'provisioning' : 'running',
        tool_permissions: child.tool_permissions,
        created_at: new Date().toISOString(),
      })
      this.core.db.prepare('INSERT INTO streams(stream_id) VALUES(?)').run(d.mailbox_stream_id)
      const initial = {
        session_id: child.session_id,
        text: p.text,
        observed_seq: this.core.head(child.session_id),
        script: p.script,
      }
      this.core.db
        .prepare(
          'INSERT INTO delegations(delegation_id,principal_id,delegation_key,request_hash,grant_id,session_id,mailbox_stream_id,body,create_receipt) VALUES(?,?,?,?,?,?,?,?,?)'
        )
        .run(
          delegation_id,
          actor.installation_id,
          String(p.delegation_key),
          hash(p),
          grant.grant_id,
          child.session_id,
          d.mailbox_stream_id,
          JSON.stringify(d),
          JSON.stringify(d)
        )
      this.core.append(d.mailbox_stream_id, 'delegation.created', nodeActor, d)
      // The child journal contains the link too; catalog discovery never publishes mailbox messages.
      this.core.append(child.session_id, 'session.delegated', nodeActor, {
        delegation_id,
        parent_id: d.parent_id,
      })
      this.core.acceptInput(actor, initial)
      return d
    })
  }
  private cancel(d: Delegation) {
    const inputs = this.core.db
      .prepare(
        "SELECT * FROM inputs WHERE session_id=? AND state IN ('accepted','queued','dispatching','delivered')"
      )
      .all(d.session_id) as Record<string, string | number | null>[]
    for (const input of inputs)
      this.core.transition(
        input,
        ['accepted', 'queued'].includes(String(input.state))
          ? 'cancelled'
          : this.core.session(d.session_id).provider === 'fake'
            ? 'interrupted'
            : 'delivery_unknown'
      )
    for (const prompt of this.core.prompts(d.session_id))
      if (prompt.state === 'pending') this.core.resolvePrompt(prompt, 'invalidated', 'deny', null)
    d.state = 'cancelled'
    this.save(d)
    this.mailbox.terminal(d)
  }
  /** Runs in the queue transaction. Provisioning never starts an agent; journal facts drive completion. */
  settle() {
    for (const row of this.core.db
      .prepare(
        "SELECT * FROM delegations WHERE json_extract(body,'$.state') IN ('provisioning','running')"
      )
      .all() as Row[]) {
      const d = DelegationSchema.parse(JSON.parse(row.body))
      if (!active(d)) continue
      try {
        this.checkExecution(d.session_id)
      } catch (e) {
        if (!(e instanceof ChannelError)) throw e
        this.cancel(d)
        continue
      }
      if (d.state === 'provisioning') {
        const workspace = this.core.resources.workspaces.get(d.workspace_id!)
        if (workspace.state === 'provisioning') continue
        if (workspace.state !== 'ready') {
          this.finish(d, 'failed')
          continue
        }
        this.core.resources.workspaces.assertLease(workspace.workspace_id, d.session_id)
        d.state = 'running'
        this.save(d)
      }
      const states = this.core.db
        .prepare(
          'SELECT state FROM inputs WHERE session_id=? AND ordinal=(SELECT MAX(ordinal) FROM inputs WHERE session_id=?)'
        )
        .all(d.session_id, d.session_id) as { state: string }[]
      if (
        !states.length ||
        this.core.db
          .prepare(
            "SELECT 1 FROM inputs WHERE session_id=? AND state IN ('accepted','queued','dispatching','delivered')"
          )
          .get(d.session_id)
      )
        continue
      const deadline = this.core.db
        .prepare(
          "SELECT 1 FROM events WHERE stream_id=? AND json_extract(body,'$.data.reason')='deadline' AND json_extract(body,'$.data.run_id')=(SELECT run_id FROM inputs WHERE session_id=? ORDER BY ordinal DESC LIMIT 1)"
        )
        .get(d.session_id, d.session_id)
      const state = deadline
        ? 'stopped'
        : states.some((s) => s.state === 'delivery_unknown')
          ? 'unknown'
          : states.some((s) => ['failed', 'interrupted', 'cancelled'].includes(s.state))
            ? 'failed'
            : 'completed'
      if (state === 'completed') {
        const result = row.result_text ?? this.fallback(d.session_id)
        this.mailbox.message(d, 'result', 'node-final-' + this.core.head(d.session_id), result)
      }
      if (deadline) d.reason = 'time_limit'
      this.finish(d, state)
    }
  }
  private fallback(session_id: string) {
    const rows = this.core.db
      .prepare(
        "SELECT body FROM events WHERE stream_id=? AND json_extract(body,'$.type')='content.delta' AND json_extract(body,'$.data.run_id')=(SELECT run_id FROM inputs WHERE session_id=? ORDER BY ordinal DESC LIMIT 1) ORDER BY seq DESC"
      )
      .all(session_id, session_id) as { body: string }[]
    return (
      rows
        .reverse()
        .map((r) => JSON.parse(r.body).data.text ?? '')
        .join('') || 'Child completed. Open the child session for its full transcript.'
    )
  }
  private finish(d: Delegation, state: 'completed' | 'failed' | 'unknown' | 'stopped') {
    if (d.state === 'provisioning') {
      for (const input of this.core.db
        .prepare("SELECT * FROM inputs WHERE session_id=? AND state IN ('accepted','queued')")
        .all(d.session_id) as Record<string, string | number | null>[])
        this.core.transition(input, 'failed')
    }
    d.state = state
    this.save(d)
    this.mailbox.terminal(d)
  }
  /** Must run inside a transaction. A report cannot supply another child/run/principal. */
  recordReport(session_id: string, run_id: string, report: WorkerReport) {
    this.checkExecution(session_id)
    const row = this.core.db
      .prepare('SELECT * FROM delegations WHERE session_id=?')
      .get(session_id) as Row | undefined
    if (!row) throw new ChannelError('not_found')
    if (!active(DelegationSchema.parse(JSON.parse(row.body))))
      throw new ChannelError('stale_revision')
    const input = this.core.db
      .prepare('SELECT state FROM inputs WHERE session_id=? AND run_id=?')
      .get(session_id, run_id) as { state: string } | undefined
    if (!input || !['dispatching', 'delivered'].includes(input.state))
      throw new ChannelError('stale_revision')
    const previous = this.core.db
      .prepare(
        'SELECT body FROM delegation_reports WHERE delegation_id=? AND run_id=? AND report_id=?'
      )
      .get(row.delegation_id, run_id, report.report_id) as { body: string } | undefined
    if (previous) {
      if (canonical(JSON.parse(previous.body)) !== canonical(report))
        throw new ChannelError('idempotency_mismatch')
      return { recorded: true }
    }
    this.core.db
      .prepare('INSERT INTO delegation_reports VALUES(?,?,?,?)')
      .run(row.delegation_id, run_id, report.report_id, JSON.stringify(report))
    const d = DelegationSchema.parse(JSON.parse(row.body))
    if (report.kind === 'result')
      this.core.db
        .prepare('UPDATE delegations SET result_text=? WHERE delegation_id=?')
        .run(report.text, d.delegation_id)
    else
      this.mailbox.message(
        d,
        report.kind,
        hash({ run_id, report_id: report.report_id }),
        report.text
      )
    this.core.append(session_id, 'worker.reported', nodeActor, { run_id, ...report })
    return { recorded: true }
  }
  /** Final assistant text adapter works with both existing providers, with no extra credentials/tools. */
  observe(session_id: string, run_id: string, event: { type: string; data: Record<string, any> }) {
    const row = this.core.db
      .prepare('SELECT * FROM delegations WHERE session_id=?')
      .get(session_id) as Row | undefined
    if (!row || !active(DelegationSchema.parse(JSON.parse(row.body)))) return
    const message =
      event.type === 'codex.message.final'
        ? { role: 'assistant', content: event.data.text }
        : event.type === 'pi.message.final'
          ? event.data.message
          : event.data
    if (
      !['claude.message.final', 'pi.message.final', 'codex.message.final'].includes(event.type) ||
      event.data.parent_tool_use_id ||
      message?.role !== 'assistant'
    )
      return
    const content = message.content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? content
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text)
              .join('\n')
          : ''
    if (!text) return
    const match = /^\s*```abele-worker-report\s*\n([\s\S]*?)\n```\s*$/.exec(text)
    if (match) {
      let report: unknown
      try {
        report = JSON.parse(match[1]!)
      } catch {
        return
      }
      const parsed = WorkerReportSchema.safeParse(report)
      if (!parsed.success) return
      this.recordReport(session_id, run_id, parsed.data)
    } else if (
      !this.core.db
        .prepare(
          "SELECT 1 FROM delegation_reports WHERE delegation_id=? AND run_id=? AND json_extract(body,'$.kind')='result'"
        )
        .get(row.delegation_id, run_id)
    )
      this.core.db
        .prepare('UPDATE delegations SET result_text=? WHERE delegation_id=?')
        .run(text, row.delegation_id)
  }
  turnText(session_id: string, text: string) {
    if (!this.isActive(session_id)) return text
    const workspace = this.core.session(session_id).workspace_id
    return (
      text +
      (workspace
        ? '\n\nThe node has already created your dedicated worktree at ' +
          this.core.resources.workspaces.get(workspace).path +
          '. Perform implementation there. Do not create another worktree or move to a different workspace.'
        : '') +
      WorkerReporter.instruction
    )
  }
}
