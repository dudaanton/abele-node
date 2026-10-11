import { afterEach, expect, it, vi } from 'vitest'
import { DebuggerClient } from '@abele/node-client'
import { agentFixture } from './review-fixture.js'

afterEach(() => vi.useRealTimers())
it.each(['late-cancellation-reply', 'late-null-reply', 'rejected-wait'] as const)(
  'notifies watch subscribers of last-known state on connection loss / %s',
  async (completion) => {
    vi.useFakeTimers()
    const f = agentFixture(),
      snapshot = f.core.debugger.snapshot(f.id)
    let resolve!: (result: unknown) => void, reject!: (error: Error) => void
    const client = new DebuggerClient(async (method) => {
      if (method === 'debugger.v1.status') return snapshot
      if (method === 'debugger.v1.cancelWait') return { cancelled: true }
      return new Promise((r, j) => {
        resolve = r
        reject = j
      })
    })
    const updates: any[] = [],
      abort = new AbortController()
    const watch = client.watch(f.id, (state) => updates.push(state), abort.signal)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(updates).toHaveLength(1)
      expect(updates[0]).toMatchObject({
        observation: 'current',
        snapshot: { execution: 'stopped' },
      })
      client.disconnected()
      expect(updates).toHaveLength(2)
      expect(updates[1]).toMatchObject({
        observation: 'last-known',
        reason: 'connection_lost',
        snapshot: { execution: 'stopped' },
      })
      if (completion === 'rejected-wait') reject(Error('disconnected'))
      else
        resolve({
          wait_id: 'wait',
          reason: 'cancelled',
          elapsed_ms: 1,
          snapshot: completion === 'late-null-reply' ? null : snapshot.snapshot,
        })
      await watch
      expect(updates).toHaveLength(2)
      expect(client.current(f.id)).toMatchObject({ observation: 'last-known' })
    } finally {
      abort.abort()
      resolve?.({
        wait_id: 'wait',
        reason: 'cancelled',
        elapsed_ms: 1,
        snapshot: snapshot.snapshot,
      })
      await watch
      f.close()
    }
  }
)

it('ordinary watch cancellation does not emit a connection-loss notification', async () => {
  vi.useFakeTimers()
  const f = agentFixture(),
    snapshot = f.core.debugger.snapshot(f.id)
  let resolve!: (result: unknown) => void
  const client = new DebuggerClient(async (method) =>
    method === 'debugger.v1.status'
      ? snapshot
      : method === 'debugger.v1.cancelWait'
        ? { cancelled: true }
        : new Promise((r) => {
            resolve = r
          })
  )
  const updates: any[] = [],
    abort = new AbortController()
  const watch = client.watch(f.id, (state) => updates.push(state), abort.signal)
  try {
    await vi.advanceTimersByTimeAsync(0)
    abort.abort()
    client.disconnected() // no longer a subscribed UI, even while cancellation settles
    resolve({ wait_id: 'wait', reason: 'cancelled', elapsed_ms: 1, snapshot: snapshot.snapshot })
    await watch
    expect(updates).toHaveLength(1)
    expect(updates[0].reason).toBeUndefined()
  } finally {
    abort.abort()
    resolve?.({ wait_id: 'wait', reason: 'cancelled', elapsed_ms: 1, snapshot: snapshot.snapshot })
    await watch
    f.close()
  }
})
