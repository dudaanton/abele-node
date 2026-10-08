import { it, expect } from 'vitest'
import { PiEventMapper } from '../packages/provider-pi/src/host.js'
it('exposes only a bounded HTTP error status for explicit acceptance retry decisions', () => {
  const mapper = new PiEventMapper()
  const event = mapper.map({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: [],
      stopReason: 'error',
      errorMessage: '502 provider error Authorization Bearer SECRET',
    },
  })
  expect(event.data.http_status).toBe(502)
  expect(JSON.stringify(event)).not.toContain('SECRET')
  expect(
    mapper.map({
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: 'unclassified SECRET 502',
      },
    }).data.http_status
  ).toBeUndefined()
})
it('maps SDK partial snapshots to linear-sized deltas within worker/journal limits', () => {
  const mapper = new PiEventMapper()
  let bytes = 0,
    text = ''
  for (let i = 0; i < 3000; i++) {
    text += 'abcd'
    const partial = {
      role: 'assistant',
      content: [{ type: 'text', text }],
      usage: { output: i + 1 },
      headers: { authorization: 'SECRET' },
    }
    const event = mapper.map({
      type: 'message_update',
      message: partial,
      assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'abcd', partial },
    })
    bytes += Buffer.byteLength(JSON.stringify(event))
    expect(event.data.delta.delta).toBe('abcd')
  }
  expect(bytes).toBeLessThan(2 * 1024 * 1024)
  const call = { type: 'toolCall', id: 'call-a', name: 'bash', arguments: {} }
  const start = mapper.map({
    type: 'message_update',
    assistantMessageEvent: {
      type: 'toolcall_start',
      contentIndex: 1,
      partial: { content: [{ type: 'text', text }, call] },
    },
  })
  expect(start.data.delta).toMatchObject({ type: 'toolcall_start', id: 'call-a', toolName: 'bash' })
  expect(start.data.delta).not.toHaveProperty('partial')
  const final = mapper.map({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text }], stopReason: 'stop' },
  })
  expect(final.data.message.content[0].text).toBe(text)
})
