import { randomUUID } from 'node:crypto'
import type { ProviderAction as PiAction, Answer } from '@abele/provider-contract'
export type { ProviderAction as PiAction, Answer } from '@abele/provider-contract'
export type Ask = (action: PiAction, signal: AbortSignal) => Promise<Answer>
export interface PiTurnResult {
  subtype: 'success' | 'error'
  is_error: boolean
  terminal_reason?: string
}
export interface PiEvent {
  type: string
  data: Record<string, any>
}
const canonical = (v: any): string =>
  Array.isArray(v)
    ? '[' + v.map(canonical).join(',') + ']'
    : v && typeof v === 'object'
      ? '{' +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
          .join(',') +
        '}'
      : JSON.stringify(v)
/** All SDK tools, including reads and extension tools, require a single exact node grant.
 * Trusted extensions are executable local code, not sandboxed by this policy. */
export class PiApprovalPolicy {
  private claimed = new Set<string>()
  constructor(
    private ask: Ask,
    private signal: AbortSignal
  ) {}
  async intercept(
    action: PiAction,
    actionSignal?: AbortSignal
  ): Promise<{ block: true; reason: string; terminate: true } | undefined> {
    const signal = AbortSignal.any([this.signal, ...(actionSignal ? [actionSignal] : [])])
    const deny = {
      block: true,
      reason: 'Node denied, expired or lost this exact approval',
      terminate: true,
    } as const
    const key = `${action.native_session_id ?? ''}:${action.tool_use_id}`
    if (signal.aborted || this.claimed.has(key)) return deny
    this.claimed.add(key)
    const before = canonical(action)
    try {
      const answer = await this.ask(structuredClone(action), signal)
      if (signal.aborted || canonical(action) !== before) return deny
      const confirmed = answer.delivered() === true
      if (!confirmed || answer.choice !== 'allow') return deny
      return undefined
    } catch {
      return deny
    }
  }
}
/** The host owns prompt transport; unavailable answers never become true/allow. */
export class PiExtensionUiBridge {
  readonly context: any
  constructor(
    private ask: Ask,
    private signal: AbortSignal,
    private emit: (event: PiEvent) => void
  ) {
    this.context = new Proxy(
      {
        select: async (title: string, options: string[], config?: any) => {
          const a = await this.dialog('select', title, { options }, config)
          return a?.choice === 'allow' && options.includes(a.value ?? '') ? a.value : undefined
        },
        confirm: async (title: string, message = '', config?: any) =>
          (await this.dialog('confirm', title, { message }, config))?.choice === 'allow',
        input: async (title: string, placeholder = '', config?: any) => {
          const a = await this.dialog('input', title, { placeholder }, config)
          return a?.choice === 'allow' ? a.value : undefined
        },
        custom: async () => {
          this.emit({
            type: 'pi.capability.error',
            data: { capability: 'custom', reason: 'unsupported_extension_ui' },
          })
          throw new Error('unsupported_extension_ui')
        },
        notify: (message: string, level = 'info') =>
          this.emit({ type: 'pi.ui.notification', data: { message, level } }),
        setStatus: (key: string, text?: string) =>
          this.emit({ type: 'pi.ui.status', data: { key, text: text ?? null } }),
      },
      {
        get: (target, key) => {
          if (key in target) return target[key as keyof typeof target]
          return () => {
            this.emit({
              type: 'pi.capability.error',
              data: { capability: String(key), reason: 'unsupported_extension_ui' },
            })
            throw new Error('unsupported_extension_ui')
          }
        },
      }
    )
  }
  async trust(cwd: string) {
    return (
      (await this.dialog('trust', 'Trust executable project resources?', { cwd }))?.choice ===
      'allow'
    )
  }
  private async dialog(
    kind: 'select' | 'confirm' | 'input' | 'trust',
    title: string,
    input: Record<string, unknown>,
    config?: { signal?: AbortSignal; timeout?: number }
  ) {
    const signal = AbortSignal.any([this.signal, ...(config?.signal ? [config.signal] : [])])
    if (signal.aborted) return undefined
    try {
      const a = await this.ask(
        {
          kind,
          title,
          tool_use_id: randomUUID(),
          tool_name: 'extension_ui.' + kind,
          input,
          ...(kind === 'select' ? { options: input.options as string[] } : {}),
          ...(config?.timeout ? { ttl_ms: config.timeout } : {}),
        },
        signal
      )
      if (signal.aborted || a.delivered() !== true) return undefined
      return a
    } catch {
      return undefined
    }
  }
}
const sensitive =
  /^(apiKey|api_key|auth|authorization|headers|baseUrl|credentials|credential|token|access|refresh|secret|payload|environment|env|diagnostics|thinkingSignature|textSignature)$/i
function safe(v: any): any {
  if (Array.isArray(v)) return v.map(safe)
  if (v && typeof v === 'object')
    return Object.fromEntries(
      Object.entries(v)
        .filter(([k]) => !sensitive.test(k))
        .map(([k, value]) => [
          k,
          /^(errorMessage|error|finalError)$/i.test(k)
            ? 'provider_error (details retained only locally by SDK)'
            : safe(value),
        ])
    )
  return v
}
/** Never serialize SDK runtime/model/auth objects or HTTP request/response diagnostics. */
export class PiEventMapper {
  private message = 0
  map(raw: any): PiEvent {
    if (!raw || typeof raw.type !== 'string') throw new Error('invalid_pi_event')
    if (raw.type === 'message_update') {
      // SDK partial/message are response-so-far helpers, not deltas. Do not even
      // traverse/copy them on every token: that makes output and work quadratic.
      const update = raw.assistantMessageEvent ?? {}
      const delta = Object.fromEntries(
        ['type', 'contentIndex', 'delta', 'content', 'toolCall', 'reason', 'id', 'toolName']
          .filter((key) => update[key] !== undefined)
          .map((key) => [key, safe(update[key])])
      )
      if (update.type === 'toolcall_start') {
        const block = update.partial?.content?.[update.contentIndex]
        if (block?.type === 'toolCall') {
          delta.id = block.id
          delta.toolName = block.name
        }
      }
      return {
        type: 'pi.message.delta',
        data: {
          message_id: String(this.message),
          delta,
          usage: safe(raw.usage ?? update.partial?.usage),
        },
      }
    }
    const e = safe(raw)
    if (raw.type === 'model_select')
      return {
        type: 'pi.model.selected',
        data: { provider: raw.model?.provider, model_id: raw.model?.id, source: raw.source },
      }
    if (raw.type === 'message_start') this.message++
    if (raw.type === 'message_start' || raw.type === 'message_end')
      return {
        type: raw.type === 'message_end' ? 'pi.message.final' : 'pi.message.start',
        data: {
          message_id: String(this.message),
          message: e.message,
          replaces_partials: raw.type === 'message_end',
          ...(raw.message?.stopReason === 'error' &&
          typeof raw.message.errorMessage === 'string' &&
          /^\s*(?:HTTP\s+)?[45]\d\d\b/.test(raw.message.errorMessage)
            ? { http_status: Number(raw.message.errorMessage.match(/[45]\d\d/)![0]) }
            : {}),
        },
      }
    if (raw.type.startsWith('tool_execution_'))
      return {
        type:
          'pi.tool.' +
          (raw.type === 'tool_execution_start'
            ? 'call'
            : raw.type === 'tool_execution_end'
              ? 'result'
              : 'update'),
        data: {
          tool_use_id: e.toolCallId,
          name: e.toolName,
          input: e.args,
          result: e.result ?? e.partialResult,
          is_error: e.isError,
          parent_tool_use_id: e.parent_tool_use_id,
        },
      }
    return {
      type: 'pi.' + raw.type,
      data: {
        ...Object.fromEntries(
          Object.entries(e).filter(([k]) => !['type', 'run_id', 'session_id'].includes(k))
        ),
        ...(e.run_id !== undefined ? { native_run_id: e.run_id } : {}),
        ...(e.session_id !== undefined ? { native_child_session_id: e.session_id } : {}),
      },
    }
  }
}
export interface HostSession {
  sessionId: string
  sessionFile?: string
  subscribe(listener: (event: any) => void): () => void
  bindExtensions(bindings: any): Promise<void>
  prompt(text: string, options: any): Promise<void>
  waitForIdle(): Promise<void>
  abort(): Promise<void>
}
export interface HostRuntime {
  session: HostSession
  setRebindSession(callback: (session: HostSession) => Promise<void>): void
  setBeforeSessionInvalidate?(callback: () => void): void
}
/** Session-level idle is the completion boundary, never low-level agent_end.
 * Every subscription and UI binding is rebuilt after runtime replacement. */
export class PiSdkWorker {
  private unsubscribe?: () => void
  private generation = 0
  private lastStop?: string
  private extensionFailure = false
  private mapper = new PiEventMapper()
  constructor(
    private runtime: HostRuntime,
    private emit: (event: PiEvent) => void,
    private bindings: () => any
  ) {}
  async bind() {
    this.runtime.setRebindSession((s) => this.rebind(s))
    this.runtime.setBeforeSessionInvalidate?.(() => this.unsubscribe?.())
    await this.rebind(this.runtime.session)
  }
  private async rebind(session: HostSession) {
    this.unsubscribe?.()
    const generation = ++this.generation
    this.lastStop = undefined
    this.mapper = new PiEventMapper()
    this.emit({
      type: 'pi.session.bound',
      data: { native_session_id: session.sessionId, native_session_file: session.sessionFile },
    })
    this.unsubscribe = session.subscribe((e) => {
      if (generation !== this.generation) return
      if (e.type === 'message_end' && e.message?.role === 'assistant')
        this.lastStop = e.message.stopReason
      const mapped = this.mapper.map(e)
      this.emit({
        ...mapped,
        data: {
          ...mapped.data,
          ...(mapped.data.native_session_id && mapped.data.native_session_id !== session.sessionId
            ? { native_child_session_id: mapped.data.native_session_id }
            : {}),
          native_session_id: session.sessionId,
          runtime_generation: generation,
        },
      })
    })
    const bindings = this.bindings()
    await session.bindExtensions({
      ...bindings,
      onError: (error: unknown) => {
        // The SDK swallows registered command/hook exceptions. Acceptance is
        // not completion evidence; keep this failure across runtime replacement.
        this.extensionFailure = true
        if (bindings.onError) bindings.onError(error)
        else this.emit({ type: 'pi.extension.error', data: { reason: 'extension_error' } })
      },
    })
  }
  async prompt(text: string): Promise<PiTurnResult> {
    this.lastStop = undefined
    let accepted = false
    await this.runtime.session.prompt(text, {
      preflightResult: (ok: boolean) => {
        accepted = ok
        if (ok) this.emit({ type: 'pi.input.accepted', data: { evidence: 'sdk_preflight' } })
      },
    })
    // The prompt may have been an extension command that replaced runtime.session.
    for (;;) {
      const current = this.runtime.session
      await current.waitForIdle()
      if (current === this.runtime.session) break
    }
    if (!accepted) throw new Error('pi_preflight_rejected')
    if (this.lastStop === 'aborted') throw new Error('pi_aborted')
    const extensionFailure = this.extensionFailure
    this.extensionFailure = false
    const failed = extensionFailure || this.lastStop === 'error' || this.lastStop === 'deferred'
    return {
      subtype: failed ? 'error' : 'success',
      is_error: failed,
      terminal_reason: extensionFailure
        ? 'extension_error'
        : this.lastStop === 'deferred'
          ? 'unsupported_deferred_response'
          : this.lastStop === 'error'
            ? 'provider_error'
            : undefined,
    }
  }
  /** Prompt completion is provisional until SDK session_shutdown/dispose has
   * finished. A swallowed late extension error must never upgrade to success. */
  completionResult(result: PiTurnResult): PiTurnResult {
    return this.extensionFailure
      ? { ...result, subtype: 'error', is_error: true, terminal_reason: 'extension_error' }
      : result
  }
  abort() {
    return this.runtime.session.abort()
  }
  dispose() {
    this.unsubscribe?.()
  }
}
