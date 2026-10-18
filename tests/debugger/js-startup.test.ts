import { afterEach, expect, it, vi } from 'vitest'
import { holdJsStartup } from '../../packages/node-core/src/debugger/js-startup.js'

class Inspector extends EventTarget {
  static current: Inspector
  sent: { id: number; method: string }[] = []
  close = vi.fn()
  constructor() {
    super()
    Inspector.current = this
  }
  send(raw: string) {
    this.sent.push(JSON.parse(raw))
  }
  reply(value: object) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }))
  }
}
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('holds startup until the actual pause, without evaluating or resuming user code', async () => {
  vi.stubGlobal('WebSocket', Inspector)
  const pending = holdJsStartup('ws://127.0.0.1/fixture')
  const socket = Inspector.current
  socket.dispatchEvent(new Event('open'))
  expect(socket.sent).toEqual([{ id: 1, method: 'Debugger.enable' }])
  socket.reply({ id: 1, result: {} })
  socket.reply({ id: 2, result: {} })
  let ready = false
  void pending.then(() => {
    ready = true
  })
  await Promise.resolve()
  expect(ready).toBe(false)
  socket.reply({ method: 'Debugger.paused', params: {} })
  const release = await pending
  expect(socket.sent).toEqual([
    { id: 1, method: 'Debugger.enable' },
    { id: 2, method: 'Runtime.runIfWaitingForDebugger' },
  ])
  expect(socket.close).not.toHaveBeenCalled()
  release()
  expect(socket.close).toHaveBeenCalledOnce()
})

it.each(['error', 'close'])(
  'closes a startup connection lost before the pause (%s)',
  async (event) => {
    vi.stubGlobal('WebSocket', Inspector)
    const pending = holdJsStartup('ws://127.0.0.1/fixture')
    Inspector.current.dispatchEvent(new Event(event))
    await expect(pending).rejects.toThrow('debugger_startup_pause_lost')
    expect(Inspector.current.close).toHaveBeenCalledOnce()
  }
)

it('bounds startup waiting and closes the connection on timeout', async () => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', Inspector)
  const pending = expect(holdJsStartup('ws://127.0.0.1/fixture')).rejects.toThrow(
    'debugger_startup_pause_timeout'
  )
  await vi.advanceTimersByTimeAsync(10000)
  await pending
  expect(Inspector.current.close).toHaveBeenCalledOnce()
})

it('fails closed on an inspector request rejection', async () => {
  vi.stubGlobal('WebSocket', Inspector)
  const pending = holdJsStartup('ws://127.0.0.1/fixture')
  Inspector.current.reply({ id: 1, error: { message: 'unavailable' } })
  await expect(pending).rejects.toThrow('debugger_startup_pause_rejected')
  expect(Inspector.current.close).toHaveBeenCalledOnce()
})
