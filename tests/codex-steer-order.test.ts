import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RpcPeer, type RpcMessage, type RpcOptions } from '../packages/provider-codex/src/rpc.js'
import { startCodexLiveSession } from '../packages/provider-codex/src/live.js'
import { waitForProcessCondition } from '../scripts/process-test-budget.mjs'

vi.mock('../packages/provider-codex/src/thread.js', () => ({
  checkNativeBinding: () => {},
  openCodexThread: async () => ({
    thread_id: 'thread',
    model: 'fixture-small',
    params: {},
    inspect: async () => {},
  }),
}))

it('commits steering acceptance before completion in the same decoded batch', async () => {
  const dir = mkdtempSync(resolve('.scratch/codex-steer-order-'))
  const events: { type: string; data: any }[] = []
  let options: RpcOptions
  // Exercise the real request/receive ordering without an OS process or inference.
  const peer = Object.assign(Object.create(RpcPeer.prototype), {
    pending: new Map(),
    next: 0,
    timers: { setTimeout, clearTimeout },
    signal: new AbortController().signal,
    lost: new Promise(() => {}),
    options: { notification: (msg: RpcMessage) => options.notification?.(msg) },
    async write(this: { receive(msg: RpcMessage): void }, msg: RpcMessage) {
      const response = {
        id: msg.id,
        result: msg.method === 'turn/start' ? { turn: { id: 'turn' } } : {},
      }
      this.receive(response)
      if (msg.method === 'turn/steer') {
        this.receive({
          method: 'turn/completed',
          params: {
            threadId: 'thread',
            turn: { id: 'turn', status: 'completed' },
          },
        })
      }
    },
    close: async () => {},
  }) as RpcPeer
  const start = vi.spyOn(RpcPeer, 'start').mockImplementation(async (o) => {
    options = o
    return peer
  })
  try {
    const live = await startCodexLiveSession(
      {
        executable: {} as any,
        paths: { home: dir, workspace: dir, sibling: dir, state: dir },
        context: {
          session_id: randomUUID(),
          run_id: randomUUID(),
          cwd: dir,
          settings: {
            model: 'default',
            effort: 'low',
            account: 'default',
            permission_mode: 'manual',
          },
          permission_ttl_ms: 1000,
        },
      },
      {
        event: (e) => events.push(e),
        processes: () => {},
        permission: async () => {
          throw Error('unexpected approval')
        },
      }
    )
    live.send({ input_id: 'first', content: 'hold' })
    await waitForProcessCondition(
      () => events.some((e) => e.type === 'live.turn.started'),
      'turn started'
    )
    live.send({ input_id: 'steered', content: 'finish' })
    await waitForProcessCondition(
      () => events.some((e) => e.type === 'live.turn.completed'),
      'turn completed'
    )
    expect(events.find((e) => e.type === 'live.turn.completed')?.data.input_ids).toEqual([
      'first',
      'steered',
    ])
    expect(
      events
        .filter((e) => ['live.input.delivered', 'live.turn.completed'].includes(e.type))
        .map((e) => [e.type, e.data.input_id])
    ).toEqual([
      ['live.input.delivered', 'first'],
      ['live.input.delivered', 'steered'],
      ['live.turn.completed', undefined],
    ])
  } finally {
    start.mockRestore()
    rmSync(dir, { recursive: true, force: true })
  }
})
