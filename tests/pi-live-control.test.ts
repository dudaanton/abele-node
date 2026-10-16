import { expect, it } from 'vitest'
import { PiLiveController, type PiLiveHost } from '../packages/provider-pi/dist/live-control.js'

// The turn bookkeeping of a long-lived pi session, over a host that answers on demand.
function fake() {
  const events: { type: string; data: any }[] = []
  const calls: string[] = []
  let streaming = false
  let finish: ((r: any) => void) | undefined
  let fail: ((e: Error) => void) | undefined
  const queue: string[] = []
  let controller!: PiLiveController
  const emit = (e: { type: string; data: any }) => {
    events.push(e)
  }
  const host: PiLiveHost = {
    prompt: (text) => {
      calls.push('prompt:' + text)
      streaming = true
      return new Promise((resolve, reject) => {
        finish = (r) => {
          streaming = false
          resolve(r)
        }
        fail = (e) => {
          streaming = false
          reject(e)
        }
      })
    },
    steer: async (text) => {
      calls.push('steer:' + text)
      queue.push(text)
      controller.observe({ type: 'pi.queue_update', data: { steering: [...queue] } })
    },
    streaming: () => streaming,
    clearQueue: () => {
      calls.push('clear')
      queue.splice(0)
    },
    compact: async (instructions) => {
      calls.push('compact:' + (instructions ?? ''))
      controller.observe({ type: 'pi.compaction_start', data: { reason: 'manual' } })
      controller.observe({
        type: 'pi.compaction_end',
        data: { reason: 'manual', result: { summary: 'S', tokensBefore: 10 }, aborted: false },
      })
      return { tokens_before: 10, summary: 'S' }
    },
    context: () => ({ tokens: 5, contextWindow: 100, percent: 5, model: 'm' }),
    commands: () => [],
    setModel: async (m) => void calls.push('model:' + m),
    setEffort: (e) => void calls.push('effort:' + e),
    setPermissionMode: (m) => void calls.push('mode:' + m),
    abort: async () => {
      calls.push('abort')
      fail?.(new Error('pi_aborted'))
    },
  }
  controller = new PiLiveController(host, emit)
  const take = () => {
    queue.shift()
    controller.observe({ type: 'pi.queue_update', data: { steering: [...queue] } })
  }
  const done = async (r = { subtype: 'success', is_error: false }) => {
    finish?.(r)
    await new Promise((r) => setTimeout(r, 0))
  }
  const of = (type: string) => events.filter((e) => e.type === type).map((e) => e.data)
  return { controller, calls, events, of, take, done, queue }
}

it('steers a message written mid-turn and reports both inputs with the turn', async () => {
  const f = fake()
  f.controller.send({ input_id: 'a', text: 'first' })
  f.controller.send({ input_id: 'b', text: 'second' })
  expect(f.calls).toEqual(['prompt:first', 'steer:second'])
  expect(f.of('pi.input.delivered').map((d) => d.input_id)).toEqual(['a'])
  f.take()
  expect(f.of('pi.input.delivered').map((d) => d.input_id)).toEqual(['a', 'b'])
  await f.done()
  expect(f.of('pi.turn.started')).toEqual([{ trigger: 'input' }])
  expect(f.of('pi.turn.completed')).toEqual([
    { input_ids: ['a', 'b'], outcome: 'success', subtype: 'success', terminal_reason: null },
  ])
  expect(f.of('pi.context').at(-1)).toMatchObject({ total_tokens: 5, max_tokens: 100 })
})

it('runs a steered message the turn ended before taking as the next turn', async () => {
  const f = fake()
  f.controller.send({ input_id: 'a', text: 'first' })
  f.controller.send({ input_id: 'b', text: 'late' })
  await f.done()
  expect(f.calls).toEqual(['prompt:first', 'steer:late', 'clear', 'prompt:late'])
  expect(f.of('pi.turn.completed')[0]!.input_ids).toEqual(['a'])
  await f.done()
  expect(f.of('pi.turn.completed')[1]!.input_ids).toEqual(['b'])
})

it('waits with a compaction until the turn ends, then reports its boundary and summary', async () => {
  const f = fake()
  f.controller.send({ input_id: 'a', text: 'work' })
  f.controller.send({ input_id: 'c', text: '/compact keep the plan' })
  expect(f.calls).toEqual(['prompt:work'])
  await f.done()
  await new Promise((r) => setTimeout(r, 0))
  expect(f.calls).toEqual(['prompt:work', 'compact:keep the plan'])
  expect(f.of('pi.turn.started').map((d) => d.trigger)).toEqual(['input', 'compact'])
  expect(f.of('pi.compact.started')).toEqual([{ trigger: 'manual' }])
  expect(f.of('pi.compact.boundary')).toEqual([
    { trigger: 'manual', pre_tokens: 10, post_tokens: null },
  ])
  expect(f.of('pi.compact.summary')).toEqual([{ text: 'S' }])
  expect(f.of('pi.turn.completed')[1]).toMatchObject({ input_ids: ['c'], outcome: 'success' })
})

it('ends everything written for the turn on interrupt and ignores an input sent twice', async () => {
  const f = fake()
  f.controller.send({ input_id: 'a', text: 'first' })
  f.controller.send({ input_id: 'b', text: 'steered' })
  f.controller.send({ input_id: 'b', text: 'steered' })
  await f.controller.interrupt()
  await new Promise((r) => setTimeout(r, 0))
  expect(f.calls).toEqual(['prompt:first', 'steer:steered', 'clear', 'abort'])
  expect(f.of('pi.turn.completed')).toEqual([
    {
      input_ids: ['a', 'b'],
      outcome: 'interrupted',
      subtype: 'interrupted',
      terminal_reason: 'pi_aborted',
    },
  ])
})

it('applies model, effort and permission mode in the running session', async () => {
  const f = fake()
  await f.controller.control('set_model', { model: 'big' })
  await f.controller.control('set_effort', { effort: 'high' })
  await f.controller.control('set_permission_mode', { mode: 'bypassPermissions' })
  await expect(f.controller.control('unknown', {})).rejects.toThrow('unsupported')
  expect(f.calls).toEqual(['model:big', 'effort:high', 'mode:bypassPermissions'])
})
