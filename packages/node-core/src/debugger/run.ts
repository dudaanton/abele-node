import { ChannelError, type AuthorityContext } from '@abele/channel-protocol'
import type { DebuggerToolBridge } from '@abele/provider-contract'
import type { NodeCore } from '../index.js'
import {
  DebuggerAgentBinding,
  debuggerToolDefinitions,
  unpublishedDebuggerResult,
} from './agent.js'

/** Host-only scope: no corresponding model/RPC constructor. The scheduler
 * supplies actual run/conversation/workspace and checks active input state. */
export interface DebuggerRunContext {
  authority: AuthorityContext
  run_id: string
  conversation_id: string
  workspace_id: string | null
  active(): boolean
}
export class DebuggerRunBinding implements DebuggerToolBridge {
  readonly tools
  private readonly bindings = new Map<string, { grant_id: string; binding: DebuggerAgentBinding }>()
  private closed = false
  private readonly untrackRun: () => void
  constructor(
    private readonly core: NodeCore,
    private readonly context: DebuggerRunContext
  ) {
    this.tools = core.debugger.enabled ? debuggerToolDefinitions : []
    context.authority = core.authority.snapshot(context.authority)
    this.untrackRun = core.debuggerControl.permissions.trackRun(
      context.authority.installation_id,
      context.run_id,
      () => !this.closed && context.active()
    )
  }
  private session(args: any): string | undefined {
    return args?.debug_session_id ?? args?.cursor?.debug_session_id
  }
  private resolve(args: unknown) {
    if (this.closed || !this.context.active()) throw new ChannelError('unauthorized')
    if (!this.core.debugger.enabled) throw new ChannelError('unsupported_method')
    const session = this.session(args)
    if (typeof session !== 'string') throw new ChannelError('invalid_params')
    const cached = this.bindings.get(session)
    try {
      const { authority, run_id, conversation_id, workspace_id } = this.context
      const state = this.core.debugger.snapshot(session).snapshot
      // Re-resolve on every boundary, including publication. Revoked/expired or
      // superseded authority is not a permanently cached denial for this run.
      const row = this.core.db
        .prepare(
          `SELECT body FROM debug_grants
        WHERE json_extract(body,'$.debug_session_id')=?
          AND json_extract(body,'$.installation_id')=? AND json_extract(body,'$.run_id')=?
          AND json_extract(body,'$.conversation_id')=? AND json_extract(body,'$.workspace_id') IS ?
          AND json_extract(body,'$.incarnation')=? AND json_extract(body,'$.target_id')=?
          AND json_extract(body,'$.revoked')=0
          AND julianday(json_extract(body,'$.expires_at')) > julianday(?)
        ORDER BY rowid DESC LIMIT 1`
        )
        .get(
          session,
          authority.installation_id,
          run_id,
          conversation_id,
          workspace_id,
          state.incarnation,
          state.target.target_id,
          new Date().toISOString()
        )
      if (!row) throw new ChannelError('unauthorized')
      const grant = this.core.debuggerControl.permissions.grant(
        JSON.parse(String(row.body)).grant_id
      )
      const principal = {
        kind: 'agent' as const,
        authority,
        run_id,
        conversation_id,
        workspace_id,
        task_id: grant.task_id,
        grant_id: grant.grant_id,
        target_id: grant.target_id,
      }
      // Verify the full retained authority/scope before creating listeners or
      // caching a binding. Status/current-state publication requires read scope.
      this.core.debuggerControl.permissions.authorize(principal, state, 'read')
      if (cached?.grant_id === grant.grant_id) return cached.binding
      if (!cached && this.bindings.size >= 128) throw new ChannelError('debugger_binding_limit')
      cached?.binding.dispose()
      const binding = new DebuggerAgentBinding(this.core, principal)
      this.bindings.set(session, { grant_id: grant.grant_id, binding })
      return binding
    } catch (error) {
      cached?.binding.dispose()
      this.bindings.delete(session)
      throw error
    }
  }
  async call(name: string, args: unknown, signal?: AbortSignal) {
    try {
      return await this.resolve(args).call(name, args, signal)
    } catch (error) {
      return {
        outcome: 'rejected',
        code: error instanceof ChannelError ? error.code : 'debugger_unavailable',
        snapshot: null,
        observation: 'unknown',
      }
    }
  }
  publish(args: unknown, result: any) {
    try {
      return this.resolve(args).publish(args, result)
    } catch {
      return unpublishedDebuggerResult(result, 'unauthorized')
    }
  }
  close() {
    if (this.closed) return
    this.closed = true
    // Remove timers/subscriptions even if durable task settlement fails. Effects
    // cannot resume through this closure; audit failure remains fail-closed.
    let error: unknown
    for (const { binding } of this.bindings.values()) {
      try {
        binding.close()
      } catch (e) {
        error ??= e
      }
    }
    this.bindings.clear()
    if (this.core.debugger.enabled) {
      // Include owner grants that the provider never used during this run.
      const rows = this.core.db
        .prepare(
          `SELECT DISTINCT json_extract(body,'$.task_id') AS task FROM debug_grants
        WHERE json_extract(body,'$.run_id')=? AND json_extract(body,'$.installation_id')=?
          AND json_extract(body,'$.conversation_id')=? AND json_extract(body,'$.workspace_id') IS ?`
        )
        .all(
          this.context.run_id,
          this.context.authority.installation_id,
          this.context.conversation_id,
          this.context.workspace_id
        )
      for (const row of rows) {
        try {
          this.core.debuggerControl.settleTask(String(row.task), this.context.run_id)
        } catch (e) {
          error ??= e
        }
      }
    }
    if (error) throw error
    this.untrackRun() // only after durable revocation; failed settlement stays fenced
  }
}
