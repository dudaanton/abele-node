import { ChannelError, type AuthorityContext } from '@abele/channel-protocol'
import { randomUUID } from 'node:crypto'
import type { DebuggerAction } from './permissions.js'
import type { DebuggerToolBridge } from '@abele/provider-contract'
import type { NodeCore } from '../index.js'
import {
  DebuggerAgentBinding,
  debuggerToolDefinitions,
  unpublishedDebuggerResult,
  debuggerToolSpec,
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
  private readonly requests = new Map<string, string>()
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
  private requestAccess(name: string, args: unknown) {
    const spec = debuggerToolSpec(name)
    if (!spec || !spec.schema.safeParse(args).success) return {}
    const { method } = spec
    if (this.closed || !this.context.active()) return {}
    const { authority, run_id, conversation_id, workspace_id } = this.context
    this.core.authority.check(authority, 'debugger_read')
    const session = this.session(args)!
    const state = this.core.debugger.snapshot(session).snapshot
    const control = this.core.debuggerControl
    if (
      !control.permissions.conversationMatches(state, conversation_id) ||
      state.target.workspace_id !== workspace_id
    )
      return {}
    const action: DebuggerAction = ['evaluate', 'setVariable', 'variables'].includes(method)
      ? 'expressions'
      : ['breakpoints.patch', 'exceptionBreakpoints.set'].includes(method)
        ? 'breakpoints'
        : ['pause', 'continue', 'step', 'detach', 'terminate'].includes(method)
          ? (method as DebuggerAction)
          : 'read'
    const key = JSON.stringify([session, state.incarnation, action])
    for (const [id, request] of control.accessRequests) {
      if (!request.active()) control.accessRequests.delete(id)
    }
    for (const [scope, id] of this.requests) {
      if (!control.accessRequests.has(id)) this.requests.delete(scope)
    }
    const existing = this.requests.get(key)
    const previous = existing ? control.accessRequests.get(existing) : undefined
    if (existing && previous?.decision !== 'allow')
      return {
        request_id: existing,
        message:
          previous?.decision === 'deny'
            ? 'The owner denied this debugger access request. No matching live owner grant permits this operation.'
            : 'Missing owner-issued debugger access grant for this run and target; the owner was asked in the chat. Retry after Allow.',
      }
    if (existing) {
      control.accessRequests.delete(existing)
      this.requests.delete(key)
    }
    if (control.accessRequests.size >= 128) throw new ChannelError('debugger_authority_limit')
    const request_id = randomUUID()
    const actions = action === 'read' ? ['read'] : ['read', action]
    const expires_at = new Date(
      Date.now() + control.permissions.policy().max_grant_ms
    ).toISOString()
    const input = {
      installation_id: authority.installation_id,
      run_id,
      task_id: randomUUID(),
      conversation_id,
      workspace_id,
      target_id: state.target.target_id,
      debug_session_id: session,
      incarnation: state.incarnation,
      actions,
      expires_at,
    }
    let folder: string | null = null
    try {
      folder = this.core.resources.targets.pathForSession(conversation_id) ?? null
    } catch {}
    const recipe = this.core.db
      .prepare('SELECT body FROM debug_launches WHERE debug_session_id=?')
      .get(session)
    const launch = recipe ? JSON.parse(String(recipe.body)) : null
    const program =
      launch?.kind === 'start' ? launch.params.program : state.target.launch_configuration_id
    const item = {
      kind: 'debugger_access_requested',
      version: 1,
      request_id,
      ...input,
      method,
      access: action === 'expressions' ? 'evaluate/setVariable' : action,
      target: state.target,
      folder,
      program,
    }
    control.accessRequests.set(request_id, {
      item,
      input,
      authority,
      decided: false,
      active: () => {
        try {
          this.core.authority.check(authority, 'debugger_read')
          return (
            !this.closed &&
            this.context.active() &&
            Date.parse(expires_at) > Date.now() &&
            this.core.debugger.snapshot(session).snapshot.incarnation === state.incarnation
          )
        } catch {
          return false
        }
      },
    })
    try {
      this.core.append(
        conversation_id,
        'session.update',
        { kind: 'node' },
        { run_id, update: item }
      )
    } catch (error) {
      control.accessRequests.delete(request_id)
      throw error
    }
    this.requests.set(key, request_id)
    return {
      request_id,
      message:
        'Missing owner-issued debugger access grant for this run and target; the owner was asked in the chat. Retry after Allow.',
    }
  }
  async call(name: string, args: unknown, signal?: AbortSignal) {
    try {
      const result = await this.resolve(args).call(name, args, signal)
      if (result?.code === 'unauthorized') return { ...result, ...this.requestAccess(name, args) }
      return result
    } catch (error) {
      let request = {}
      if (error instanceof ChannelError && error.code === 'unauthorized') {
        try {
          request = this.requestAccess(name, args)
        } catch {}
      }
      return {
        outcome: 'rejected',
        code: error instanceof ChannelError ? error.code : 'debugger_unavailable',
        snapshot: null,
        observation: 'unknown',
        ...request,
      }
    }
  }
  publish(args: unknown, result: any) {
    // Access refusals contain no debugger data. Preserve the host-created request
    // through the provider publication fence without trusting a supplied message.
    if (result?.code === 'unauthorized' && [...this.requests.values()].includes(result?.request_id))
      return {
        ...unpublishedDebuggerResult(result, 'unauthorized'),
        request_id: result.request_id,
        message:
          this.core.debuggerControl.accessRequests.get(result.request_id)?.decision === 'deny'
            ? 'The owner denied this debugger access request. No matching live owner grant permits this operation.'
            : 'Missing owner-issued debugger access grant for this run and target; the owner was asked in the chat. Retry after Allow.',
      }
    try {
      return this.resolve(args).publish(args, result)
    } catch {
      return unpublishedDebuggerResult(result, 'unauthorized')
    }
  }
  close() {
    if (this.closed) return
    this.closed = true
    for (const id of this.requests.values()) this.core.debuggerControl.accessRequests.delete(id)
    this.requests.clear()
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
