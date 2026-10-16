import { randomUUID } from 'node:crypto'
import { ChannelError, type AuthorityContext } from '@abele/channel-protocol'
import {
  DEBUGGER_LIMITS,
  DebuggerGrantInputSchema,
  DebuggerGrantSchema,
  DebuggerPolicySchema,
  type DebuggerGrant,
  type DebuggerSnapshot,
  type DebuggerHistoryEntry,
} from '@abele/node-protocol'
import type { NodeCore } from '../index.js'

/** Supplied by a trusted host closure, NEVER parsed from RPC/model arguments. */
export type DebuggerPrincipal =
  | { kind: 'human'; authority: AuthorityContext }
  | {
      kind: 'agent'
      authority: AuthorityContext
      grant_id: string
      run_id: string
      task_id: string
      conversation_id: string
      workspace_id: string | null
      target_id: string
    }
export type DebuggerAction = DebuggerGrant['actions'][number]
export class DebuggerPermissions {
  private conversationMatches(state: DebuggerSnapshot, conversation: string) {
    if (state.target.conversation_id !== null) return state.target.conversation_id === conversation
    const current = this.core.resources.targets.currentTarget(conversation)
    if (!current) return false
    const target = current.target
    const folder = target.kind === 'workspace' ? target.workspace_id : target.worktree_id
    const root = this.core.resources.targets.pathForSession(conversation)
    const project =
      this.core.resources.targets.bound(conversation)?.project_id ??
      (this.core.session(conversation).workspace_id
        ? this.core.resources.workspaces.get(this.core.session(conversation).workspace_id!)
            .project_id
        : undefined)
    return (
      !!root &&
      state.target.node_id === this.core.node_id &&
      state.target.project_id === project &&
      state.target.worktree_id === folder
    )
  }
  private readonly runs = new Map<string, () => boolean>()
  /** Host-only activity fence; queued proposals and physical dispatch consult it
   * through authorize, not just at the original bridge call. */
  trackRun(installation: string, run: string, active: () => boolean) {
    const key = installation + '\u0000' + run
    if (this.runs.has(key)) throw new ChannelError('debugger_run_already_bound')
    if (this.runs.size >= 128) throw new ChannelError('debugger_binding_limit')
    this.runs.set(key, active)
    return () => {
      if (this.runs.get(key) === active) this.runs.delete(key)
    }
  }
  constructor(private readonly core: NodeCore) {}
  owner(actor: AuthorityContext) {
    this.core.authority.check(actor, 'approve_debugger')
  }
  policy() {
    const row = this.core.db.prepare('SELECT body FROM debug_policy WHERE id=1').get()
    return DebuggerPolicySchema.parse(row ? JSON.parse(String(row.body)) : {})
  }
  setPolicy(owner: AuthorityContext, raw: unknown) {
    this.owner(owner)
    const policy = DebuggerPolicySchema.parse(raw)
    this.core.transaction(
      () =>
        this.core.db
          .prepare('INSERT OR REPLACE INTO debug_policy VALUES(1,?)')
          .run(JSON.stringify(policy)),
      true
    )
    return policy
  }
  grant(id: string): DebuggerGrant {
    const row = this.core.db.prepare('SELECT body FROM debug_grants WHERE grant_id=?').get(id)
    if (!row) throw new ChannelError('unauthorized')
    return DebuggerGrantSchema.parse(JSON.parse(String(row.body)))
  }
  create(owner: AuthorityContext, raw: unknown) {
    this.owner(owner)
    const input = DebuggerGrantInputSchema.parse(raw),
      policy = this.policy()
    const state = this.core.debugger.snapshot(input.debug_session_id).snapshot
    if (
      state.incarnation !== input.incarnation ||
      !this.conversationMatches(state, input.conversation_id) ||
      state.target.workspace_id !== input.workspace_id ||
      state.target.target_id !== input.target_id
    )
      throw new ChannelError('stale_state')
    if (Date.parse(input.expires_at) > Date.now() + policy.max_grant_ms)
      throw new ChannelError('grant_expiry_limit')
    if (
      Number(this.core.db.prepare('SELECT count(*) AS n FROM debug_grants').get()?.n) >=
      DEBUGGER_LIMITS.grants
    )
      throw new ChannelError('debugger_authority_limit')
    const grant = DebuggerGrantSchema.parse({
      ...input,
      grant_id: randomUUID(),
      revoked: false,
      mode: input.mode ?? policy.mode,
      owner_authority: this.core.authority.snapshot(owner),
      controller_authority: this.core.authority.snapshot(
        this.core.authority.forInstallation(input.installation_id)
      ),
    })
    this.core.transaction(
      () =>
        this.core.db
          .prepare('INSERT INTO debug_grants VALUES(?,?)')
          .run(grant.grant_id, JSON.stringify(grant)),
      true
    )
    return grant
  }
  setMode(owner: AuthorityContext, id: string, mode: DebuggerGrant['mode']) {
    this.owner(owner)
    const grant = this.grant(id)
    if (grant.revoked || Date.parse(grant.expires_at) <= Date.now())
      throw new ChannelError('unauthorized')
    this.core.authority.check(grant.owner_authority, 'debugger_grant_owner')
    this.core.authority.check(grant.controller_authority, 'debugger_grant_controller')
    const updated = DebuggerGrantSchema.parse({ ...grant, mode })
    this.core.transaction(
      () =>
        this.core.db
          .prepare('UPDATE debug_grants SET body=? WHERE grant_id=?')
          .run(JSON.stringify(updated), id),
      true
    )
    return updated
  }
  revoke(owner: AuthorityContext, id: string) {
    this.owner(owner)
    this.grant(id)
    this.core.transaction(
      () =>
        this.core.db
          .prepare(
            "UPDATE debug_grants SET body=json_set(body,'$.revoked',json('true')) WHERE grant_id=?"
          )
          .run(id),
      true
    )
  }
  /** Trusted task lifecycle seam; B5 binds it to actual run settlement. */
  settle(task: string, run: string) {
    this.core.transaction(
      () =>
        this.core.db
          .prepare(
            "UPDATE debug_grants SET body=json_set(body,'$.revoked',json('true')) WHERE json_extract(body,'$.task_id')=? AND json_extract(body,'$.run_id')=?"
          )
          .run(task, run),
      true
    )
  }
  /** An incarnation fixes the entire target (including workspace/conversation).
   * Replacing any target metadata rotates it. Current read authority therefore
   * covers only historical rows with that exact session/target/incarnation;
   * an enrolled human owner retains the existing global-resource read policy. */
  canReadHistory(
    principal: DebuggerPrincipal,
    current: DebuggerSnapshot,
    entry: DebuggerHistoryEntry
  ): boolean {
    const grant = this.authorize(principal, current, 'read')
    return (
      grant === undefined ||
      (entry.debug_session_id === grant.debug_session_id &&
        entry.incarnation === grant.incarnation &&
        entry.target_id === grant.target_id)
    )
  }
  authorize(
    principal: DebuggerPrincipal,
    state: DebuggerSnapshot,
    action: DebuggerAction
  ): DebuggerGrant | undefined {
    this.core.authority.check(principal.authority, 'debugger_' + action)
    if (principal.kind === 'human') return
    const active = this.runs.get(principal.authority.installation_id + '\u0000' + principal.run_id)
    const provider = this.core.db
      .prepare('SELECT state FROM provider_runs WHERE run_id=?')
      .get(principal.run_id)
    if (
      (active && !active()) ||
      (provider &&
        (provider.state !== 'active' ||
          !this.core.db
            .prepare(
              "SELECT 1 FROM inputs WHERE run_id=? AND session_id=? AND state IN ('dispatching','delivered')"
            )
            .get(principal.run_id, principal.conversation_id)))
    )
      throw new ChannelError('unauthorized')
    const g = this.grant(principal.grant_id)
    this.core.authority.check(g.owner_authority, 'debugger_grant_owner')
    this.core.authority.check(g.controller_authority, 'debugger_grant_controller')
    if (
      g.revoked ||
      Date.parse(g.expires_at) <= Date.now() ||
      !g.actions.includes(action) ||
      g.installation_id !== principal.authority.installation_id ||
      g.run_id !== principal.run_id ||
      g.task_id !== principal.task_id ||
      g.conversation_id !== principal.conversation_id ||
      g.workspace_id !== principal.workspace_id ||
      g.target_id !== principal.target_id ||
      g.debug_session_id !== state.debug_session_id ||
      g.incarnation !== state.incarnation ||
      !this.conversationMatches(state, g.conversation_id) ||
      g.workspace_id !== state.target.workspace_id ||
      g.target_id !== state.target.target_id
    )
      throw new ChannelError('unauthorized')
    return g
  }
}
