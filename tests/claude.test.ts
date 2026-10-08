import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { ClaudeStreamDecoder, ClaudeEventMapper } from '../packages/provider-claude/src/stream.js'

describe('Claude stream boundary and projection', () => {
  it('maps the anonymized measured CLI fixture and retains sparse native evidence', () => {
    const fixture = JSON.parse(
      readFileSync(new URL('../probes/fixtures/provider-records.json', import.meta.url), 'utf8')
    ) as { records: Record<string, any>[] }
    const mapper = new ClaudeEventMapper()
    const events = fixture.records
      .filter((r) => typeof r.type === 'string')
      .flatMap((r) => mapper.map(r))
    expect(events.find((e) => e.type === 'claude.tool.result')?.data).toMatchObject({
      tool_use_id: 'fixture-bash',
      is_error: false,
    })
    expect(
      events.filter(
        (e) => e.type === 'claude.message.final' && e.data.parent_tool_use_id === 'fixture-agent'
      )
    ).toHaveLength(2)
    expect(events.find((e) => e.type === 'claude.result')?.data.result).toHaveProperty(
      'permission_denials'
    )
    expect(events.find((e) => e.type === 'claude.unknown')?.data.record).toMatchObject({
      type: 'stream_event',
      event: { delta: { type: 'thinking_delta', thinking: '' } },
    })
  })
  it('decodes byte splits including UTF-8, rejects malformed/truncated/oversized records', () => {
    const bytes = Buffer.from('{"type":"assistant","text":"雪"}\n{"type":"result"}\n')
    const decoder = new ClaudeStreamDecoder()
    const records: unknown[] = []
    for (const byte of bytes) records.push(...decoder.push(Buffer.from([byte])))
    expect(records).toEqual([{ type: 'assistant', text: '雪' }, { type: 'result' }])
    decoder.end()
    expect(() => new ClaudeStreamDecoder().push(Buffer.from('bad\n'))).toThrow()
    const partial = new ClaudeStreamDecoder()
    partial.push(Buffer.from('{'))
    expect(() => partial.end()).toThrow(/truncated/)
    expect(() => new ClaudeStreamDecoder(16).push(Buffer.alloc(17, 120))).toThrow(/limit/)
  })
  it('reconciles per-block assistant finals sharing one native message ID without dropping earlier text', () => {
    const mapper = new ClaudeEventMapper()
    const records = [
      { type: 'stream_event', event: { type: 'message_start', message: { id: 'm' } } },
      {
        type: 'stream_event',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hello' },
        },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
      { type: 'assistant', message: { id: 'm', content: [{ type: 'text', text: 'hello' }] } },
      {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 't', name: 'Bash', input: {} },
        },
      },
      { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
      {
        type: 'assistant',
        message: {
          id: 'm',
          content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'pwd' } }],
        },
      },
    ]
    const events = records.flatMap((r) => mapper.map(r))
    expect(events.filter((e) => e.type === 'claude.message.final').at(-1)?.data.content).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'pwd' } },
    ])
    expect(events.filter((e) => e.type === 'claude.tool.call')).toHaveLength(1)
  })
  it('uses replacement final blocks, correlates tools/children, and preserves withheld thinking and unknowns', () => {
    const mapper = new ClaudeEventMapper()
    const records = [
      {
        type: 'stream_event',
        parent_tool_use_id: 'parent',
        event: { type: 'message_start', message: { id: 'm' } },
      },
      {
        type: 'stream_event',
        parent_tool_use_id: 'parent',
        event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      },
      {
        type: 'stream_event',
        parent_tool_use_id: 'parent',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'hel' },
        },
      },
      {
        type: 'assistant',
        parent_tool_use_id: 'parent',
        message: {
          id: 'm',
          content: [
            { type: 'text', text: 'hello' },
            { type: 'thinking', thinking: '' },
            { type: 'tool_use', id: 'call', name: 'Bash', input: { command: 'pwd' } },
          ],
        },
      },
      {
        type: 'user',
        parent_tool_use_id: 'parent',
        message: { content: [{ type: 'tool_result', tool_use_id: 'call', content: 'output' }] },
      },
      { type: 'future', value: 3 },
    ]
    const events = records.flatMap((r) => mapper.map(r))
    expect(events.find((e) => e.type === 'claude.block.delta')?.data).toMatchObject({
      message_id: 'm',
      index: 0,
      parent_tool_use_id: 'parent',
      text: 'hel',
    })
    expect(events.find((e) => e.type === 'claude.message.final')?.data).toMatchObject({
      message_id: 'm',
      replaces_partials: true,
      parent_tool_use_id: 'parent',
    })
    expect(events.find((e) => e.type === 'claude.thinking')?.data).toMatchObject({
      visibility: 'withheld_or_empty',
    })
    expect(events.find((e) => e.type === 'claude.tool.call')?.data).toMatchObject({
      tool_use_id: 'call',
    })
    expect(events.find((e) => e.type === 'claude.tool.result')?.data).toMatchObject({
      tool_use_id: 'call',
    })
    expect(events.at(-1)?.type).toBe('claude.unknown')
  })
})
