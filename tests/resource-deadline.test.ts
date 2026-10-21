import { it, expect, vi } from 'vitest'
import { RequestChannel, RecordQueue } from '@abele/channel-client'
import { LIMITS, type AuthenticatedChannel } from '@abele/channel-protocol'
it('allows bounded Git resource calls past the five-second control deadline without making them unbounded', async () => {
  vi.useFakeTimers()
  const queue = new RecordQueue()
  let closed = false
  const channel = {
    authority: { installation_id: 'i' },
    welcome: {
      kind: 'welcome',
      version: { major: 0, minor: 0 },
      node_id: 'n',
      installation_id: 'i',
      instance_id: 'x',
      methods: [],
      limits: LIMITS,
      capabilities: {},
    },
    transport: {
      send: async () => {},
      receive: () => queue,
      close: async () => {
        closed = true
        queue.end()
      },
    },
  } satisfies AuthenticatedChannel
  const requests = new RequestChannel(channel)
  try {
    const pending = requests.request('workspace.diff', { workspace_id: 'w' })
    let settled = false
    void pending.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    const rejection = expect(pending).rejects.toThrow('outcome_unknown')
    await vi.advanceTimersByTimeAsync(6000)
    expect(settled).toBe(false)
    expect(closed).toBe(false)
    await vi.advanceTimersByTimeAsync(25000)
    await rejection
    expect(settled).toBe(true)
    // F55: the deadline bounds this request; heartbeat owns connection loss.
    expect(closed).toBe(false)
  } finally {
    await requests.close()
    vi.useRealTimers()
  }
})
