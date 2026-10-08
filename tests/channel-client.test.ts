import { expect, it, vi } from 'vitest'
import { LocalChannelConnector } from '../packages/channel-client/src/index.js'
import { LIMITS, type RecordTransport } from '@abele/channel-protocol'

it('a transport completing after the auth deadline is closed without sending credentials', async () => {
  vi.useFakeTimers()
  try {
    let complete: (transport: RecordTransport) => void = () => {},
      sent = 0,
      closed = false
    const connector = new LocalChannelConnector(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    const attempt = connector.connect({
      url: 'ws://127.0.0.1:7777/channel',
      profile: 'local-token-v1',
      token: 'a'.repeat(64),
    })
    const rejected = expect(attempt).rejects.toThrow('connection_timeout')
    await vi.advanceTimersByTimeAsync(LIMITS.auth_ms)
    await rejected
    complete({
      send: async () => {
        sent++
      },
      receive: async function* () {},
      close: async () => {
        closed = true
      },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(sent).toBe(0)
    expect(closed).toBe(true)
  } finally {
    vi.useRealTimers()
  }
})
