// Turns of one long-lived pi session. The SDK runs one prompt at a time; what the owner writes
// while it works is steered into it at the next tool boundary, so a message never waits for the
// whole turn. Inputs are reported as taken, turns as started and finished, from the SDK's own events.
import type { PiEvent, PiTurnResult } from './host.js'

export interface PiLiveHost {
  /** One prompt, run until the session is idle again. */
  prompt(text: string): Promise<PiTurnResult>
  /** Queued into the running prompt; extension commands still run at once. */
  steer(text: string): Promise<void>
  streaming(): boolean
  clearQueue(): void
  compact(instructions?: string): Promise<{ tokens_before: number | null; summary: string }>
  context():
    | { tokens: number | null; contextWindow: number; percent: number | null; model: string | null }
    | undefined
  commands(): { name: string; description?: string; source: string }[]
  setModel(model: string): Promise<void>
  setEffort(effort: string): void
  setPermissionMode(mode: string): void
  abort(): Promise<void>
}
interface Pending {
  input_id: string
  text: string
}
const COMPACT = /^\/compact(?:\s+([\s\S]*))?$/
/** Commands the node itself runs for pi, besides the session's own. */
export const PI_BUILTIN_COMMANDS = [
  { name: 'compact', description: 'Summarize the conversation to free context', source: 'builtin' },
]
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
export class PiLiveController {
  private running = false
  private interrupted = false
  private turnInputs: string[] = []
  /** Steered into the running prompt, not taken by the model yet; FIFO like the SDK's queue. */
  private steered: Pending[] = []
  /** Not handed to the SDK yet. */
  private waiting: Pending[] = []
  private seen = new Set<string>()
  private steering = false
  constructor(
    private host: PiLiveHost,
    private emit: (event: PiEvent) => void
  ) {}
  /** Every SDK event passes here before it is reported. */
  observe(event: PiEvent) {
    if (event.type === 'pi.queue_update' && Array.isArray(event.data.steering)) {
      const taken = this.steered.length - event.data.steering.length
      for (const input of this.steered.splice(0, Math.max(0, taken))) this.delivered(input)
    } else if (event.type === 'pi.compaction_start') {
      this.emit({
        type: 'pi.compact.started',
        data: { trigger: event.data.reason === 'manual' ? 'manual' : 'auto' },
      })
    } else if (event.type === 'pi.compaction_end') {
      const result = event.data.result as Record<string, unknown> | undefined
      const trigger = event.data.reason === 'manual' ? 'manual' : 'auto'
      if (result && event.data.aborted !== true) {
        this.emit({
          type: 'pi.compact.boundary',
          data: {
            trigger,
            pre_tokens: n(result.tokensBefore),
            post_tokens: n(result.estimatedTokensAfter),
          },
        })
        if (typeof result.summary === 'string' && result.summary)
          this.emit({ type: 'pi.compact.summary', data: { text: result.summary } })
      } else
        this.emit({
          type: 'pi.compact.failed',
          data: { trigger, error: event.data.aborted === true ? 'aborted' : 'compaction_failed' },
        })
    }
    if (this.running && this.host.streaming()) void this.flush()
  }
  /** The session's "/" commands, reported once it is bound; the node maps them to the shared list. */
  announce() {
    let commands: { name: string; description?: string; source: string }[] = []
    try {
      commands = this.host.commands()
    } catch {}
    this.emit({
      type: 'pi.commands',
      data: {
        commands: [...PI_BUILTIN_COMMANDS, ...commands].slice(0, 512).map((c) => ({
          name: String(c.name).slice(0, 128),
          description: typeof c.description === 'string' ? c.description.slice(0, 512) : null,
          source: String(c.source).slice(0, 32),
        })),
      },
    })
    this.context()
  }
  send(input: Pending) {
    // A daemon that took over sends again what it is not sure was written.
    if (this.seen.has(input.input_id)) return
    this.seen.add(input.input_id)
    if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value!)
    if (!this.running) return void this.start(input)
    this.waiting.push(input)
    if (this.host.streaming()) void this.flush()
  }
  async interrupt() {
    if (!this.running) return
    this.interrupted = true
    // Everything written for this turn ends with it, taken or not.
    this.host.clearQueue()
    for (const input of [...this.steered.splice(0), ...this.waiting.splice(0)])
      this.turnInputs.push(input.input_id)
    await this.host.abort()
  }
  async control(subtype: string, params: Record<string, unknown>) {
    if (subtype === 'set_model' && typeof params.model === 'string')
      await this.host.setModel(params.model)
    else if (subtype === 'set_effort' && typeof params.effort === 'string')
      this.host.setEffort(params.effort)
    else if (subtype === 'set_permission_mode' && typeof params.mode === 'string')
      this.host.setPermissionMode(params.mode)
    else if (subtype === 'get_context_usage') this.context()
    else throw new Error('unsupported')
    return {}
  }
  private delivered(input: Pending) {
    this.turnInputs.push(input.input_id)
    this.emit({ type: 'pi.input.delivered', data: { input_id: input.input_id } })
  }
  /** Hands waiting messages to the running prompt; a compaction waits for the turn to end. */
  private async flush() {
    if (this.steering) return
    this.steering = true
    try {
      while (this.waiting.length && !COMPACT.test(this.waiting[0]!.text) && this.host.streaming()) {
        const input = this.waiting.shift()!
        this.steered.push(input)
        try {
          await this.host.steer(input.text)
        } catch {
          // Refused while steering (the turn just ended): it starts the next turn instead.
          const at = this.steered.indexOf(input)
          if (at >= 0) this.waiting.unshift(...this.steered.splice(at, 1))
          break
        }
      }
    } finally {
      this.steering = false
    }
  }
  private async start(input: Pending) {
    this.running = true
    this.interrupted = false
    this.turnInputs = []
    const compact = COMPACT.exec(input.text)
    this.emit({ type: 'pi.turn.started', data: { trigger: compact ? 'compact' : 'input' } })
    this.delivered(input)
    let outcome: 'success' | 'failed' | 'interrupted' = 'success',
      subtype: string | null = 'success',
      terminal: string | null = null
    try {
      if (compact) await this.host.compact(compact[1]?.trim() || undefined)
      else {
        const result = await this.host.prompt(input.text)
        if (result.is_error) {
          outcome = 'failed'
          subtype = result.subtype
          terminal = result.terminal_reason ?? null
        }
      }
    } catch (error) {
      outcome = 'failed'
      subtype = 'error'
      terminal = error instanceof Error ? error.message.slice(0, 128) : 'pi_turn_failed'
    }
    if (this.interrupted) outcome = 'interrupted'
    // Steered too late for the turn that just ended: they start the next one.
    if (this.steered.length) {
      this.host.clearQueue()
      this.waiting.unshift(...this.steered.splice(0))
    }
    this.emit({
      type: 'pi.turn.completed',
      data: {
        input_ids: this.turnInputs,
        outcome,
        subtype: outcome === 'interrupted' ? 'interrupted' : subtype,
        terminal_reason: terminal,
      },
    })
    this.running = false
    this.turnInputs = []
    this.context()
    const next = this.waiting.shift()
    if (next) {
      void this.start(next)
      if (this.waiting.length && this.host.streaming()) void this.flush()
    }
  }
  private context() {
    let usage: ReturnType<PiLiveHost['context']>
    try {
      usage = this.host.context()
    } catch {
      return
    }
    if (!usage) return
    this.emit({
      type: 'pi.context',
      data: {
        total_tokens: n(usage.tokens),
        max_tokens: n(usage.contextWindow),
        percentage: n(usage.percent),
        auto_compact_threshold: null,
        auto_compact_enabled: null,
        model: typeof usage.model === 'string' ? usage.model.slice(0, 256) : null,
      },
    })
  }
}
