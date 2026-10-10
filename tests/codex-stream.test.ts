import { expect, it } from 'vitest'
import { JsonlDecoder } from '../packages/provider-codex/src/rpc.js'
import { CodexEventMapper } from '../packages/provider-codex/src/mapper.js'

it('decodes UTF-8 splits, multiple frames and strict bounded JSONL', () => {
  const bytes = Buffer.from(JSON.stringify({ id: 1, result: { text: 'é🙂' } }) + '\n')
  for (let at = 1; at < bytes.length; at++) {
    const d = new JsonlDecoder()
    expect([...d.push(bytes.subarray(0, at)), ...d.push(bytes.subarray(at))]).toEqual([
      { id: 1, result: { text: 'é🙂' } },
    ])
    d.end()
  }
  const d = new JsonlDecoder(30, 100)
  expect(d.push(Buffer.from('{"id":1,"result":1}\n{"id":2,"result":2}\n'))).toHaveLength(2)
  for (const input of [
    '\n',
    '[]\n',
    '{"id":{},"result":1}\n',
    '{"id":1,"result":1,"error":{}}\n',
    '{"id":1}\n',
    '{"id":1,"error":null}\n',
    '{"method":""}\n',
  ])
    expect(() => new JsonlDecoder().push(Buffer.from(input))).toThrow()
  expect(() => new JsonlDecoder(8).push(Buffer.from('123456789'))).toThrow('frame_limit')
  expect(() => new JsonlDecoder(100, 5).push(Buffer.alloc(6))).toThrow('output_limit')
  expect(() => new JsonlDecoder().push(Uint8Array.of(0xff))).toThrow()
  const partial = new JsonlDecoder()
  partial.push(Buffer.from('{"id":1'))
  expect(() => partial.end()).toThrow('truncated')
})
it('maps one native turn, replaces partial messages by item ID, excludes hidden reasoning and secrets', () => {
  const events: any[] = []
  const mapper = new CodexEventMapper('run', (e) => events.push(e))
  mapper.bind('thread')
  mapper.accepted('turn')
  mapper.accepted('turn')
  const notify = (method: string, params: any) =>
    mapper.notification({ method, params: { threadId: 'thread', turnId: 'turn', ...params } })
  notify('item/agentMessage/delta', { itemId: 'message', delta: 'partial' })
  notify('item/completed', { item: { type: 'agentMessage', id: 'message', text: 'replacement' } })
  notify('item/agentMessage/delta', { itemId: 'message', delta: 'late' })
  notify('item/reasoning/textDelta', { itemId: 'reason', delta: 'never journal hidden content' })
  notify('item/reasoning/summaryTextDelta', { itemId: 'reason', delta: 'summary' })
  notify('account/updated', { token: 'secret' })
  notify('new/notification', { token: 'secret', arbitrary: 'private' })
  notify('turn/diff/updated', { diff: 'diff' })
  notify('turn/completed', { turn: { id: 'turn', status: 'completed', error: null } })
  expect(events.filter((e) => e.type === 'codex.input.accepted')).toHaveLength(1)
  expect(events.find((e) => e.type === 'codex.message.final').data).toMatchObject({
    item_id: 'message',
    text: 'replacement',
    replace: true,
  })
  expect(events.filter((e) => e.type === 'codex.message.delta')).toHaveLength(1)
  expect(JSON.stringify(events)).not.toMatch(/secret|private|hidden content|late/)
  expect(events.every((e) => e.data.run_id === 'run')).toBe(true)
  expect(mapper.result).toEqual({ subtype: 'success', is_error: false })
  expect(() => mapper.accepted('different-turn')).toThrow('turn_mismatch')
})
it('rejects cross-thread records, model rerouting and unsupported native child activity', () => {
  for (const [method, params] of [
    ['item/agentMessage/delta', { threadId: 'other', turnId: 'turn', itemId: 'i', delta: 'x' }],
    ['model/rerouted', {}],
    [
      'item/started',
      { threadId: 'thread', turnId: 'turn', item: { id: 'child', type: 'collabAgentToolCall' } },
    ],
  ] as const) {
    const mapper = new CodexEventMapper('run', () => {})
    mapper.bind('thread')
    mapper.accepted('turn')
    expect(() => mapper.notification({ method, params })).toThrow()
  }
})
