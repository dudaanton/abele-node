import { randomUUID } from 'node:crypto'
import { ChannelError } from '@abele/channel-protocol'
import { DebuggerMethodSchemas, type DebuggerSnapshot } from '@abele/node-protocol'
import type { DebuggerToolBridge, DebuggerToolDefinition } from '@abele/provider-contract'
import type { NodeCore } from '../index.js'
import { DebuggerStateError } from './index.js'
import type { DebuggerPrincipal } from './permissions.js'

const methods = [
  'status',
  'commandResult',
  'history',
  'replay',
  'threads',
  'stack',
  'scopes',
  'variables',
  'pause',
  'continue',
  'step',
  'breakpoints.patch',
  'exceptionBreakpoints.set',
  'evaluate',
  'setVariable',
  'detach',
  'terminate',
  'wait',
  'sleep',
  'cancelWait',
] as const
const effects = new Set([
  'variables',
  'pause',
  'continue',
  'step',
  'breakpoints.patch',
  'exceptionBreakpoints.set',
  'evaluate',
  'setVariable',
  'detach',
  'terminate',
])
const toolName = (method: string) =>
  'debug_' + method.replace(/[A-Z]/g, (letter) => '_' + letter.toLowerCase()).replaceAll('.', '_')
// Only the existing bounded Zod contract subset is converted. Admission ALWAYS
// uses the strict Zod parser, never this provider-facing descriptive schema.
function jsonSchema(schema: any): Record<string, any> {
  const d = schema._def
  switch (d.typeName) {
    case 'ZodOptional':
      return jsonSchema(d.innerType)
    case 'ZodDefault':
      return { ...jsonSchema(d.innerType), default: d.defaultValue() }
    case 'ZodObject': {
      const shape = schema.shape
      return {
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(shape).map(([key, value]) => [key, jsonSchema(value)])
        ),
        required: Object.entries(shape)
          .filter(([, value]) => !(value as any).isOptional())
          .map(([key]) => key),
        additionalProperties: false,
      }
    }
    case 'ZodArray':
      return {
        type: 'array',
        items: jsonSchema(d.type),
        ...(d.maxLength ? { maxItems: d.maxLength.value } : {}),
      }
    case 'ZodEnum':
      return { type: 'string', enum: d.values }
    case 'ZodBoolean':
      return { type: 'boolean' }
    case 'ZodString':
      return {
        type: 'string',
        ...Object.fromEntries(
          d.checks
            .filter((c: any) => ['min', 'max'].includes(c.kind))
            .map((c: any) => [c.kind === 'min' ? 'minLength' : 'maxLength', c.value])
        ),
      }
    case 'ZodNumber':
      return {
        type: d.checks.some((c: any) => c.kind === 'int') ? 'integer' : 'number',
        ...Object.fromEntries(
          d.checks
            .filter((c: any) => ['min', 'max'].includes(c.kind))
            .map((c: any) => [c.kind === 'min' ? 'minimum' : 'maximum', c.value])
        ),
      }
    default:
      throw new Error('unsupported_debugger_tool_schema')
  }
}
const schemas = new Map(
  methods.map((method) => {
    const schema = DebuggerMethodSchemas[`debugger.v1.${method}`]
    return [
      toolName(method),
      {
        method,
        schema: effects.has(method) ? (schema as any).omit({ operation_id: true }) : schema,
      },
    ]
  })
)
export const debuggerToolSpec = (name: string) => schemas.get(name)
export const debuggerToolDefinitions: DebuggerToolDefinition[] = [...schemas].map(
  ([name, { method, schema }]) => ({
    name,
    description: `Node-owned debugger ${method}. Returns current observed state (not live awareness). Reads require a debugger grant; expressions/objects require exact owner approval. Never retry uncertain effects automatically.`,
    inputSchema: jsonSchema(schema),
  })
)

/** Withhold requested data without falsifying the caller's control evidence.
 * Revocation or a publication failure cannot undo a possibly dispatched effect. */
export function unpublishedDebuggerResult(result: any, code: string) {
  const evidence =
    typeof result?.operation_id === 'string'
      ? {
          operation_id: result.operation_id,
          outcome: result.outcome,
          ...(result.acceptance ? { acceptance: result.acceptance } : {}),
          ...(result.dispatch ? { dispatch: result.dispatch } : {}),
        }
      : { outcome: 'rejected' }
  return {
    ...(result?.reason
      ? {
          reason: result.reason === 'connection_lost' ? 'connection_lost' : 'cancelled',
          elapsed_ms: result.elapsed_ms,
          wait_id: result.wait_id,
        }
      : evidence),
    code: result?.code ?? code,
    snapshot: null,
    observation: 'unknown',
  }
}

/** Trusted plugin-agent / provider binding. Identity is captured by the host;
 * model arguments can select only granted resources, never grants/run IDs or
 * operation IDs. Subscriptions update a bounded state cache outside chat input. */
export class DebuggerAgentBinding implements DebuggerToolBridge {
  readonly tools: DebuggerToolDefinition[]
  private readonly observed = new Map<string, DebuggerSnapshot>()
  private readonly subscriptions = new Map<string, () => void>()
  private readonly abort = new AbortController()
  private readonly unsubscribePermissions: () => void
  constructor(
    private readonly core: NodeCore,
    private readonly principal: Extract<DebuggerPrincipal, { kind: 'agent' }>
  ) {
    this.tools = core.debugger.enabled ? debuggerToolDefinitions : []
    this.unsubscribePermissions = core.debuggerControl.subscribePermissions(() => {
      for (const session of this.subscriptions.keys()) this.refresh(session)
    })
  }
  private refresh(session: string) {
    try {
      if (this.abort.signal.aborted) throw new ChannelError('unauthorized')
      const result = this.core.debuggerControl.read(this.principal, 'status', {
        debug_session_id: session,
      })
      this.observed.set(session, result.snapshot)
      return result.snapshot as DebuggerSnapshot
    } catch {
      this.observed.delete(session)
      return null
    }
  }
  current(session: string) {
    return this.refresh(session)
  }
  private follow(session: string) {
    if (!this.subscriptions.has(session))
      this.subscriptions.set(
        session,
        this.core.debugger.subscribe(session, () => {
          this.refresh(session)
        })
      )
  }
  publish(raw: unknown, result: any) {
    if (result?.reason === 'connection_lost' && result.snapshot === null)
      return {
        reason: 'connection_lost',
        elapsed_ms: result.elapsed_ms,
        wait_id: result.wait_id,
        snapshot: null,
        observation: 'unknown',
      }
    const p = raw as any
    const session = p?.debug_session_id ?? p?.cursor?.debug_session_id
    const snapshot = typeof session === 'string' ? this.refresh(session) : null
    if (!snapshot) {
      // Do not retain requested values/events after revocation, target replacement
      // or termination of this run, even if a provider-native allow rule applies.
      return unpublishedDebuggerResult(result, 'unauthorized')
    }
    const original = result?.snapshot ?? result?.cursor
    if (
      original &&
      (original.debug_session_id !== snapshot.debug_session_id ||
        original.incarnation !== snapshot.incarnation)
    )
      return {
        ...unpublishedDebuggerResult(result, 'historical_scope_expired'),
        snapshot,
        observation: snapshot.lifecycle === 'connection-lost' ? 'unknown' : 'current',
      }
    if (Buffer.byteLength(JSON.stringify({ ...result, snapshot })) > 256 * 1024 - 4096)
      return unpublishedDebuggerResult(result, 'debugger_response_too_large')
    return {
      ...result,
      snapshot,
      observation: snapshot.lifecycle === 'connection-lost' ? 'unknown' : 'current',
    }
  }
  async call(name: string, raw: unknown, signal?: AbortSignal): Promise<any> {
    let result: any, operation_id: string | undefined, operation_session: string | undefined
    let possible_dispatch = false
    try {
      if (!this.core.debugger.enabled) throw new ChannelError('unsupported_method')
      if (this.abort.signal.aborted) throw new ChannelError('unauthorized')
      const spec = schemas.get(name)
      if (!spec) throw new ChannelError('unsupported_method')
      // Refresh before admission without rewriting model-supplied preconditions:
      // an inference already in flight cannot be made retrospectively aware.
      const session = (raw as any)?.debug_session_id ?? (raw as any)?.cursor?.debug_session_id
      if (typeof session === 'string' && this.refresh(session)) this.follow(session)
      const parsed = spec.schema.safeParse(raw)
      if (!parsed.success) throw new ChannelError('invalid_params')
      const p: any = parsed.data
      const control = this.core.debuggerControl
      if (
        signal?.aborted &&
        (effects.has(spec.method) || ['threads', 'stack', 'scopes'].includes(spec.method))
      )
        throw new ChannelError('cancelled')
      if (effects.has(spec.method)) {
        operation_id = randomUUID()
        operation_session = p.debug_session_id
        result = await control.command(this.principal, spec.method, { ...p, operation_id }, () => {
          possible_dispatch = true
        })
      } else if (['threads', 'stack', 'scopes'].includes(spec.method))
        result = await control.inspect(this.principal, spec.method, p)
      else if (spec.method === 'wait' || spec.method === 'sleep')
        result = await control.wait(
          this.principal,
          spec.method,
          p,
          signal ? AbortSignal.any([this.abort.signal, signal]) : this.abort.signal
        )
      else if (spec.method === 'cancelWait') result = control.waits.cancel(this.principal, p)
      else result = control.read(this.principal, spec.method, p)
      if (
        (effects.has(spec.method) || spec.method === 'commandResult') &&
        result.outcome === 'completed'
      ) {
        const history = control.read(this.principal, 'history', {
          debug_session_id: p.debug_session_id,
        })
        const entry = [...history.entries]
          .reverse()
          .find((e: any) => e.operation_id === result.operation_id && e.outcome === 'completed')
        if (entry?.requested_data !== undefined)
          result = {
            ...result,
            requested: {
              data: entry.requested_data,
              observed_at: entry.observed_at,
              event_seq: entry.event_seq,
              stop_epoch: entry.stop_epoch,
              payload_status: entry.payload_status,
            },
          }
      }
    } catch (error) {
      if (operation_id && operation_session) {
        try {
          const evidence = this.core.debuggerControl.commandEvidence(
            this.principal,
            operation_session,
            operation_id
          )
          possible_dispatch ||= !!evidence && evidence.dispatch !== 'not_dispatched'
        } catch {
          possible_dispatch = true
        } // evidence unavailable: never assert non-dispatch
      }
      result = {
        outcome: possible_dispatch ? 'outcome_unknown' : 'rejected',
        ...(operation_id
          ? {
              operation_id,
              acceptance: possible_dispatch ? 'accepted' : 'rejected',
              dispatch: possible_dispatch ? 'possible' : 'not_dispatched',
            }
          : {}),
        code:
          error instanceof ChannelError || error instanceof DebuggerStateError
            ? error.code
            : 'debugger_unavailable',
      }
    }
    return this.publish(raw, result)
  }
  /** Release a superseded grant binding without settling its entire task/run.
   * A replacement grant may cover the same task and must remain usable. */
  dispose() {
    if (this.abort.signal.aborted) return
    this.abort.abort()
    for (const unsubscribe of this.subscriptions.values()) unsubscribe()
    this.subscriptions.clear()
    this.observed.clear()
    this.unsubscribePermissions()
  }
  close() {
    if (this.abort.signal.aborted) return
    this.dispose()
    if (this.core.debugger.enabled)
      this.core.debuggerControl.settleTask(this.principal.task_id, this.principal.run_id)
  }
}
