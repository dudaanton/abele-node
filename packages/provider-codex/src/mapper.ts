import type { ProviderEvent } from '@abele/provider-contract'
import type { RpcMessage } from './rpc.js'
export const opaqueId = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9_:-]{1,256}$/.test(v)
const text = (v: unknown, limit = 512 * 1024): string => {
  if (typeof v !== 'string' || Buffer.byteLength(v) > limit) throw new Error('codex_invalid_text')
  return v
}
export class CodexEventMapper {
  threadId?: string
  turnId?: string
  result?: { subtype: 'success' | 'error'; is_error: boolean; terminal_reason?: string }
  private items = new Map<string, Record<string, any>>()
  private finals = new Set<string>()
  private bytes = new Map<string, number>()
  constructor(
    private runId: string,
    private emit: (event: ProviderEvent) => void
  ) {}
  bind(thread: string) {
    if (!opaqueId(thread) || (this.threadId && this.threadId !== thread))
      throw new Error('codex_thread_mismatch')
    this.threadId = thread
  }
  accepted(turn: string) {
    if (!opaqueId(turn) || (this.turnId && this.turnId !== turn))
      throw new Error('codex_turn_mismatch')
    if (!this.threadId) throw new Error('codex_unbound_turn')
    if (this.turnId) return
    this.turnId = turn
    this.event('input.accepted', {})
  }
  item(id: string) {
    return this.items.get(id)
  }
  private event(type: string, data: Record<string, unknown>) {
    this.emit({
      type: `codex.${type}`,
      data: { run_id: this.runId, thread_id: this.threadId, turn_id: this.turnId, ...data },
    })
  }
  notification(msg: RpcMessage) {
    const method = msg.method!,
      p = msg.params
    if (
      /^(account\/|modelProvider\/|rawResponse|mcpServer\/|configWarning$|warning$|guardianWarning$)/.test(
        method
      )
    )
      return
    if (method === 'item/reasoning/textDelta') return
    if (method === 'model/rerouted' || method.startsWith('thread/realtime/'))
      throw new Error('codex_unsupported_native_feature')
    if (method === 'thread/started') {
      if (this.threadId && p?.thread?.id !== this.threadId) throw new Error('codex_thread_mismatch')
      return
    }
    if (p?.threadId !== undefined && p.threadId !== this.threadId)
      throw new Error('codex_thread_mismatch')
    if (method === 'turn/started') {
      this.accepted(p?.turn?.id)
      return
    }
    if (
      p?.turnId !== undefined &&
      p.turnId !== this.turnId &&
      (method.startsWith('item/') || method.startsWith('turn/'))
    )
      throw new Error('codex_turn_mismatch')
    if (method === 'turn/completed') {
      if (
        p?.turn?.id !== this.turnId ||
        this.result ||
        !['completed', 'failed', 'interrupted'].includes(p.turn.status)
      )
        throw new Error('codex_terminal_mismatch')
      this.result = {
        subtype: p.turn.status === 'completed' ? 'success' : 'error',
        is_error: p.turn.status !== 'completed',
        ...(p.turn.status === 'interrupted' ? { terminal_reason: 'interrupted' } : {}),
      }
      this.event('turn.completed', { status: p.turn.status })
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = p?.item
      if (
        !this.turnId ||
        !opaqueId(item?.id) ||
        typeof item.type !== 'string' ||
        this.items.size >= 2048
      )
        throw new Error('codex_invalid_item')
      if (
        item.type === 'collabAgentToolCall' ||
        item.type === 'mcpToolCall' ||
        item.type === 'dynamicToolCall'
      )
        throw new Error('codex_unsupported_native_feature')
      if (this.finals.has(item.id)) return
      if (item.type === 'agentMessage') {
        if (method === 'item/completed') {
          this.finals.add(item.id)
          this.event('message.final', { item_id: item.id, text: text(item.text), replace: true })
        }
      } else if (item.type === 'commandExecution' || item.type === 'fileChange') {
        const clean =
          item.type === 'commandExecution'
            ? {
                id: item.id,
                type: item.type,
                command: text(item.command),
                cwd: text(item.cwd, 4096),
                status: item.status,
                exit_code: item.exitCode,
                output: item.aggregatedOutput == null ? null : text(item.aggregatedOutput),
              }
            : {
                id: item.id,
                type: item.type,
                changes: structuredClone(item.changes),
                status: item.status,
              }
        if (
          Buffer.byteLength(JSON.stringify(clean)) > 512 * 1024 ||
          (item.type === 'fileChange' &&
            (!Array.isArray(item.changes) || item.changes.length > 128))
        )
          throw new Error('codex_invalid_item')
        this.items.set(item.id, clean)
        if (method === 'item/completed') this.finals.add(item.id)
        this.event(method === 'item/started' ? 'tool.call' : 'tool.result', {
          item_id: item.id,
          tool: item.type,
          ...clean,
        })
      }
      return
    }
    if (method === 'item/fileChange/patchUpdated') {
      const item = this.items.get(p?.itemId)
      if (
        !item ||
        item.type !== 'fileChange' ||
        this.finals.has(p.itemId) ||
        !Array.isArray(p.changes) ||
        p.changes.length > 128 ||
        Buffer.byteLength(JSON.stringify(p.changes)) > 512 * 1024
      )
        throw new Error('codex_patch_evidence_mismatch')
      this.items.set(p.itemId, { ...item, changes: structuredClone(p.changes) })
      this.event('tool.proposal', { item_id: p.itemId, changes: p.changes })
      return
    }
    const delta = (
      {
        'item/agentMessage/delta': 'message.delta',
        'item/commandExecution/outputDelta': 'tool.output.delta',
        'item/reasoning/summaryTextDelta': 'thinking',
      } as Record<string, string>
    )[method]
    if (delta) {
      if (!this.turnId || !opaqueId(p?.itemId)) throw new Error('codex_invalid_item')
      if (this.finals.has(p.itemId)) return
      const value = text(p.delta),
        bytes = (this.bytes.get(p.itemId) ?? 0) + Buffer.byteLength(value)
      if (bytes > 4 * 1024 * 1024 || this.bytes.size > 2048)
        throw new Error('codex_item_output_limit')
      this.bytes.set(p.itemId, bytes)
      this.event(delta, { item_id: p.itemId, delta: value })
      return
    }
    if (method === 'turn/diff/updated') {
      this.event('diff', { diff: text(p?.diff) })
      return
    }
    if (method === 'turn/plan/updated') {
      if (!Array.isArray(p?.plan) || p.plan.length > 128) throw new Error('codex_invalid_plan')
      this.event('plan', {
        explanation: p.explanation == null ? null : text(p.explanation, 8192),
        plan: p.plan.map((e: any) => ({ step: text(e.step, 8192), status: text(e.status, 64) })),
      })
      return
    }
    if (method === 'serverRequest/resolved') {
      this.event('request.resolved', { request_id: p?.requestId })
      return
    }
    // Preserve only identifiers from unrecognized notifications, not arbitrary diagnostics.
    this.event('notification.unknown', {
      method: text(method, 256),
      ...(opaqueId(p?.itemId) ? { item_id: p.itemId } : {}),
    })
  }
}
