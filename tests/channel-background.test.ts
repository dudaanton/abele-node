import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  BrowserRecordTransport,
  RecordQueue,
  RequestChannel,
} from '../packages/channel-client/src/index.js'
import { FrameCodec, LIMITS, type AuthenticatedChannel } from '@abele/channel-protocol'

const runtime = RequestChannel as typeof RequestChannel & {
  backgroundActive: () => boolean
  debug: (...args: unknown[]) => void
}
let active = false
const channels: RequestChannel[] = []
beforeEach(() => {
  vi.useFakeTimers()
  active = false
  runtime.backgroundActive = () => active
  runtime.debug = (...args) => console.debug(...args)
})
afterEach(async () => {
  for (const channel of channels.splice(0)) await channel.close()
  runtime.backgroundActive = () => false
  runtime.debug = () => {}
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const flush = async () => {
  for (let i = 0; i < 15; i++) await Promise.resolve()
}
function channel() {
  const queue = new RecordQueue()
  const transport = {
    receive: () => queue,
    send: vi.fn(async (_bytes: Uint8Array) => {}),
    close: vi.fn(async (_reason: string) => queue.end()),
  }
  const admitted = {
    transport,
    authority: { installation_id: 'sample-installation' },
    welcome: {
      kind: 'welcome',
      node_id: 'sample-node',
      installation_id: 'sample-installation',
      version: { major: 0, minor: 0 },
      instance_id: 'sample-instance',
      methods: [],
      limits: LIMITS,
      capabilities: {},
    },
  } satisfies AuthenticatedChannel
  const requests = new RequestChannel(admitted)
  requests.start()
  channels.push(requests)
  return { requests, queue, transport }
}
const frames = (transport: ReturnType<typeof channel>['transport']) =>
  transport.send.mock.calls.map(([bytes]) => FrameCodec.decode(bytes))

describe('opt-in background channel liveness', () => {
  it('probes a delayed heartbeat instead of closing a live channel', async () => {
    active = true
    const { queue, transport } = channel()
    vi.setSystemTime(Date.now() + LIMITS.dead_ms + 1000)
    await vi.advanceTimersByTimeAsync(LIMITS.heartbeat_ms)
    expect(transport.close).not.toHaveBeenCalled()
    expect(frames(transport)).toContainEqual({ kind: 'ping' })
    queue.push(FrameCodec.encode({ kind: 'pong' }))
    await flush()
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport.close).not.toHaveBeenCalled()
  })

  it('reprobes a throttled probe deadline, but closes after a timely unanswered probe', async () => {
    active = true
    const { transport } = channel()
    vi.setSystemTime(Date.now() + LIMITS.dead_ms + 1000)
    await vi.advanceTimersByTimeAsync(LIMITS.heartbeat_ms)
    expect(transport.close).not.toHaveBeenCalled()
    const sent = transport.send.mock.calls.length
    vi.setSystemTime(Date.now() + 60_000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport.close).not.toHaveBeenCalled()
    expect(transport.send.mock.calls.length).toBeGreaterThan(sent)
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport.close).toHaveBeenCalledWith('heartbeat_probe_timeout')
  })

  it('retains immediate heartbeat expiry when background protection is off', async () => {
    const { transport } = channel()
    vi.setSystemTime(Date.now() + LIMITS.dead_ms + 1000)
    await vi.advanceTimersByTimeAsync(LIMITS.heartbeat_ms)
    expect(transport.close).toHaveBeenCalled()
  })

  it('uses the current host policy, not the policy at connection admission', async () => {
    const { transport } = channel()
    active = true
    vi.setSystemTime(Date.now() + LIMITS.dead_ms + 1000)
    await vi.advanceTimersByTimeAsync(LIMITS.heartbeat_ms)
    expect(transport.close).not.toHaveBeenCalled()
    active = false
    vi.setSystemTime(Date.now() + 40_000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport.close).toHaveBeenCalledWith('heartbeat_probe_timeout')
  })

  it('admits a buffered response after a delayed request deadline without replaying a mutation', async () => {
    active = true
    const { requests, queue, transport } = channel()
    const result = requests.request('session.send', {}, 'sample-operation').catch((error) => error)
    vi.setSystemTime(Date.now() + 60_000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport.close).not.toHaveBeenCalled()
    const request = frames(transport).find((frame) => frame.kind === 'request')!
    queue.push(
      FrameCodec.encode({
        kind: 'response',
        request_id: (request as { request_id: string }).request_id,
        result: { accepted: true },
      })
    )
    await flush()
    expect(await result).toEqual({ accepted: true })
    expect(frames(transport).filter((frame) => frame.kind === 'request')).toHaveLength(1)
  })

  it('keeps an expired mutation uncertain while a pong preserves only the transport', async () => {
    active = true
    const { requests, queue, transport } = channel()
    const result = requests.request('session.send', {}, 'sample-operation').catch((error) => error)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await result).toMatchObject({ code: 'outcome_unknown' })
    expect(transport.close).not.toHaveBeenCalled()
    queue.push(FrameCodec.encode({ kind: 'pong' }))
    await flush()
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport.close).not.toHaveBeenCalled()
    expect(frames(transport).filter((frame) => frame.kind === 'request')).toHaveLength(1)
  })

  it('retains request deadlines without closing the channel when protection is off', async () => {
    const { requests, transport } = channel()
    const result = requests.request('session.send', {}).catch((error) => error)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await result).toMatchObject({ code: 'outcome_unknown' })
    expect(transport.close).not.toHaveBeenCalled()
  })

  it('clears probes and request grace timers on explicit disconnect', async () => {
    active = true
    const { requests, transport } = channel()
    const result = requests.request('session.send', {}).catch((error) => error)
    vi.setSystemTime(Date.now() + 60_000)
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport.close).not.toHaveBeenCalled()
    await requests.close()
    expect(await result).toMatchObject({ code: 'outcome_unknown' })
    await vi.advanceTimersByTimeAsync(100_000)
    expect(transport.close).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('closes once when a heartbeat send fails', async () => {
    active = true
    const { requests, transport } = channel()
    transport.send.mockRejectedValueOnce(new Error('Sample transport failure'))
    await vi.advanceTimersByTimeAsync(LIMITS.heartbeat_ms)
    await requests.close()
    expect(transport.close).toHaveBeenCalledTimes(1)
  })

  it('keeps diagnostics off unless a host installs a sink, preserving CLI stdout', async () => {
    runtime.debug = () => {}
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const { requests } = channel()
    await requests.close()
    expect(debug).not.toHaveBeenCalled()
  })

  it('logs bounded remote close reasons without arbitrary peer payloads', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {})
    const socket = {
      close: vi.fn(),
      binaryType: '',
      onclose: (_event: { code: number; wasClean: boolean; reason: string }) => {},
    }
    new BrowserRecordTransport(socket as unknown as WebSocket)
    socket.onclose({ code: 1000, wasClean: true, reason: 'heartbeat_timeout' })
    expect(debug).toHaveBeenCalledWith('[Abele node] socket closed', {
      code: 1000,
      clean: true,
      reason: 'heartbeat_timeout',
    })
    debug.mockClear()
    socket.onclose({ code: 1006, wasClean: false, reason: 'sample private payload' })
    expect(debug).toHaveBeenCalledWith('[Abele node] socket closed', {
      code: 1006,
      clean: false,
      reason: 'peer_close',
    })
  })
})

it('times out only the slow request and accepts late replies without closing other work', async () => {
  const { requests, queue, transport } = channel()
  const slow = requests.request('node.describe', {}).catch((e) => e)
  await vi.advanceTimersByTimeAsync(2000)
  const other = requests.request('debugger.v1.status', {})
  await vi.advanceTimersByTimeAsync(3000)
  expect(await slow).toMatchObject({ code: 'outcome_unknown' })
  expect(transport.close).not.toHaveBeenCalled()
  const sent = frames(transport).filter((f) => f.kind === 'request')
  for (const f of sent)
    if (f.kind === 'request')
      queue.push(
        FrameCodec.encode({ kind: 'response', request_id: f.request_id, result: f.method })
      )
  await expect(other).resolves.toBe('debugger.v1.status')
  expect(transport.close).not.toHaveBeenCalled()
})
it('allows the advertised debugger long-poll duration without a five-second timeout', async () => {
  const { requests, queue, transport } = channel()
  let expired = false
  const wait = requests.request('debugger.v1.wait', { timeout_ms: 60000 }).catch((e) => {
    expired = true
    return e
  })
  await vi.advanceTimersByTimeAsync(5001)
  expect(expired).toBe(false)
  const sent = frames(transport).find((f) => f.kind === 'request')!
  if (sent.kind === 'request')
    queue.push(
      FrameCodec.encode({ kind: 'response', request_id: sent.request_id, result: 'ready' })
    )
  await expect(wait).resolves.toBe('ready')
})
