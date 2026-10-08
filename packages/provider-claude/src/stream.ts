import { randomUUID } from 'node:crypto'

/** Byte framing precedes UTF-8 decoding: arbitrary OS chunk splits are harmless. */
export class ClaudeStreamDecoder {
  private pending = Buffer.alloc(0)
  constructor(private limit = 1024 * 1024) {}
  push(chunk: Uint8Array): Record<string, any>[] {
    this.pending = Buffer.concat([this.pending, chunk])
    const records: Record<string, any>[] = []
    let newline: number
    while ((newline = this.pending.indexOf(10)) !== -1) {
      if (newline > this.limit) throw new Error('claude_record_limit')
      const bytes = this.pending.subarray(0, newline)
      this.pending = this.pending.subarray(newline + 1)
      if (!bytes.length) continue
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      const record: unknown = JSON.parse(text)
      if (
        !record ||
        typeof record !== 'object' ||
        Array.isArray(record) ||
        typeof (record as any).type !== 'string'
      )
        throw new Error('claude_invalid_record')
      records.push(record as Record<string, any>)
    }
    if (this.pending.length > this.limit) throw new Error('claude_record_limit')
    return records
  }
  end() {
    if (this.pending.length) throw new Error('claude_truncated_record')
  }
}
export interface ClaudeEvent {
  type: string
  data: Record<string, unknown>
}
/** Finals REPLACE message partials by ID; consumers must not append them to delta text. */
export class ClaudeEventMapper {
  private messages = new Map<string, string>()
  private blocks = new Map<
    string,
    { content: Map<number, Record<string, any>>; finalized: Set<number>; stopped?: number }
  >()
  private state(parent: string | null, id: string) {
    const key = JSON.stringify([parent, id])
    let state = this.blocks.get(key)
    if (!state) {
      state = { content: new Map(), finalized: new Set() }
      this.blocks.set(key, state)
    }
    return state
  }
  map(r: Record<string, any>): ClaudeEvent[] {
    const parent = typeof r.parent_tool_use_id === 'string' ? r.parent_tool_use_id : null
    const base = { parent_tool_use_id: parent }
    if (r.type === 'system' && r.subtype === 'init')
      return [{ type: 'claude.init', data: { ...base, configuration: r } }]
    if (r.type === 'result') return [{ type: 'claude.result', data: { ...base, result: r } }]
    if (r.type === 'stream_event' && r.event && typeof r.event.type === 'string') {
      const e = r.event
      const key = parent ?? 'root'
      if (e.type === 'message_start') this.messages.set(key, e.message?.id ?? randomUUID())
      const message_id = this.messages.get(key)
      if (!message_id) return [{ type: 'claude.unknown', data: { record: r } }]
      const context = { ...base, message_id, index: e.index ?? null }
      const state = this.state(parent, message_id)
      if (
        e.type === 'content_block_start' &&
        Number.isSafeInteger(e.index) &&
        e.content_block &&
        typeof e.content_block.type === 'string'
      )
        state.content.set(e.index, { ...e.content_block })
      if (e.type === 'content_block_stop' && Number.isSafeInteger(e.index)) state.stopped = e.index
      if (e.type === 'content_block_delta') {
        const block = state.content.get(e.index)
        if (block && e.delta?.type === 'text_delta')
          block.text = (block.text ?? '') + (e.delta.text ?? '')
        if (block && e.delta?.type === 'thinking_delta')
          block.thinking = (block.thinking ?? '') + (e.delta.thinking ?? '')
        if (e.delta?.type === 'text_delta')
          return [{ type: 'claude.block.delta', data: { ...context, text: e.delta.text } }]
        if (e.delta?.type === 'thinking_delta')
          return [
            {
              type: 'claude.thinking',
              data: {
                ...context,
                text: e.delta.thinking ?? '',
                visibility: e.delta.thinking ? 'exposed' : 'withheld_or_empty',
                estimated_tokens: e.delta.estimated_tokens ?? null,
              },
            },
          ]
        return [{ type: 'claude.block.delta', data: { ...context, delta: e.delta } }]
      }
      return [{ type: 'claude.block.lifecycle', data: { ...context, event: e } }]
    }
    if ((r.type === 'assistant' || r.type === 'user') && Array.isArray(r.message?.content)) {
      const message_id =
        r.message.id ??
        (r.type === 'assistant' ? this.messages.get(parent ?? 'root') : undefined) ??
        r.uuid ??
        randomUUID()
      const context = { ...base, message_id }
      const state = this.state(parent, message_id)
      const updates = r.message.content.map((block: Record<string, any>, offset: number) => {
        let index = offset
        if (r.message.content.length === 1 && state.content.size) {
          const exact = [...state.content].find(
            ([, b]) =>
              (block.type === 'tool_use' && b.id === block.id) ||
              (block.type === 'tool_result' && b.tool_use_id === block.tool_use_id)
          )
          if (exact) index = exact[0]
          else if (
            state.stopped !== undefined &&
            state.content.get(state.stopped)?.type === block.type
          )
            index = state.stopped
          else {
            const matching =
              [...state.content].find(
                ([i, b]) => b.type === block.type && !state.finalized.has(i)
              ) ?? [...state.content].find(([, b]) => b.type === block.type)
            index = matching?.[0] ?? Math.max(...state.content.keys()) + 1
          }
        }
        state.content.set(index, { ...block })
        state.finalized.add(index)
        return { index, block }
      })
      const snapshot = [...state.content].sort(([a], [b]) => a - b)
      const events: ClaudeEvent[] = [
        {
          type: 'claude.message.final',
          data: {
            ...context,
            role: r.type,
            replaces_partials: true,
            content: snapshot.map(([, block]) => ({ ...block })),
            block_indices: snapshot.map(([index]) => index),
            finalized_indices: [...state.finalized].sort((a, b) => a - b),
            usage: r.message.usage ?? null,
          },
        },
      ]
      for (const { index, block } of updates) {
        if (block.type === 'tool_use')
          events.push({
            type: 'claude.tool.call',
            data: {
              ...context,
              index,
              tool_use_id: block.id,
              name: block.name,
              input: block.input,
            },
          })
        if (block.type === 'tool_result')
          events.push({
            type: 'claude.tool.result',
            data: {
              ...context,
              index,
              tool_use_id: block.tool_use_id,
              content: block.content,
              is_error: block.is_error ?? false,
            },
          })
        if (block.type === 'thinking')
          events.push({
            type: 'claude.thinking',
            data: {
              ...context,
              index,
              text: block.thinking ?? '',
              visibility: block.thinking ? 'exposed' : 'withheld_or_empty',
            },
          })
      }
      return events
    }
    return [{ type: 'claude.unknown', data: { record: r } }]
  }
}
