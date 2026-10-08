import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { NodeCore } from '@abele/node-core'
import { RecordQueue, LocalChannelConnector } from '@abele/channel-client'
import { NodeClient, MemoryClientStore } from '@abele/node-client'
import { serveChannel, RecordScheduler } from '../packages/channel-server/src/index.js'
import { FrameCodec, LIMITS, type RecordTransport, type RecordFrame } from '@abele/channel-protocol'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

it('control replies outrank queued artifact traffic and scheduler memory is bounded', async () => {
  const order: string[] = []
  let unblock: () => void = () => {}
  const transport: RecordTransport = {
    receive: async function* () {},
    close: async () => {},
    send: async (bytes) => {
      const frame = FrameCodec.decode(bytes)
      order.push(frame.kind === 'response' ? frame.request_id : frame.kind)
      if (order.length === 1)
        await new Promise<void>((r) => {
          unblock = r
        })
    },
  }
  const scheduler = new RecordScheduler(transport)
  const first = scheduler.send({ kind: 'response', request_id: 'in-flight', result: {} }, 2)
  await sleep(1)
  const artifact = scheduler.send({ kind: 'response', request_id: 'artifact', result: {} }, 2)
  const control = scheduler.send({ kind: 'response', request_id: 'prompt-answer', result: {} }, 0)
  unblock()
  await Promise.all([first, artifact, control])
  expect(order).toEqual(['in-flight', 'prompt-answer', 'artifact'])
  let release: () => void = () => {}
  const blocked = new RecordScheduler({
    ...transport,
    send: async () =>
      new Promise<void>((r) => {
        release = r
      }),
  })
  const queued = Array.from({ length: 9 }, (_, i) =>
    blocked
      .send({ kind: 'response', request_id: 'big-' + i, result: 'x'.repeat(230000) })
      .catch(() => {})
  )
  await expect(
    blocked.send({ kind: 'response', request_id: 'too-big', result: 'x'.repeat(230000) })
  ).rejects.toThrow('slow_consumer')
  blocked.close()
  release()
  await Promise.all(queued)
})

it('authentication deadline and heartbeat dead-connection timer close idle clients', async () => {
  const dir = mkdtempSync(resolve('.scratch/deadlines-')),
    core = new NodeCore(dir)
  vi.useFakeTimers()
  try {
    const queue = new RecordQueue()
    let closed = false
    const transport: RecordTransport = {
      receive: () => queue,
      send: async () => {},
      close: async () => {
        closed = true
        queue.end()
      },
    }
    const unauthenticated = serveChannel(transport, core)
    await vi.advanceTimersByTimeAsync(LIMITS.auth_ms)
    await unauthenticated
    expect(closed).toBe(true)
    const authenticatedQueue = new RecordQueue(),
      sent: RecordFrame[] = []
    closed = false
    const authenticated = serveChannel(
      {
        receive: () => authenticatedQueue,
        send: async (b) => {
          sent.push(FrameCodec.decode(b))
        },
        close: async () => {
          closed = true
          authenticatedQueue.end()
        },
      },
      core
    )
    const token = core.createToken('heartbeat')
    authenticatedQueue.push(
      FrameCodec.encode({ kind: 'auth', profile: 'local-token-v1', token: token.token })
    )
    await vi.advanceTimersByTimeAsync(0)
    authenticatedQueue.push(FrameCodec.encode({ kind: 'hello', version: { major: 0, minor: 0 } }))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(LIMITS.heartbeat_ms)
    expect(sent.some((f) => f.kind === 'ping')).toBe(true)
    expect(closed).toBe(false)
    await vi.advanceTimersByTimeAsync(LIMITS.dead_ms + LIMITS.heartbeat_ms)
    await authenticated
    expect(closed).toBe(true)
  } finally {
    vi.useRealTimers()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('post-commit internal failure does not turn an accepted mutation into a terminal client rejection', async () => {
  const dir = mkdtempSync(resolve('.scratch/post-commit-')),
    core = new NodeCore(dir)
  const credential = core.createToken('post-commit'),
    actor = core.authority.authenticate(credential.token)
  const session = core.request(actor, 'session.create', { title: 'post-commit' }, 'session') as {
    session_id: string
  }
  const incoming = new RecordQueue(),
    outgoing = new RecordQueue()
  const close = async () => {
    incoming.end()
    outgoing.end()
  }
  const serverTransport: RecordTransport = {
    receive: () => incoming,
    send: async (b) => outgoing.push(b),
    close,
  }
  const clientTransport: RecordTransport = {
    receive: () => outgoing,
    send: async (b) => incoming.push(b),
    close,
  }
  const server = serveChannel(serverTransport, core)
  const store = new MemoryClientStore(),
    client = new NodeClient(
      { url: 'ws://127.0.0.1:7777/channel', profile: 'local-token-v1', token: credential.token },
      store,
      new LocalChannelConnector(async () => clientTransport)
    )
  try {
    await client.connect()
    core.fault = (point) => {
      if (point === 'after_commit') throw new Error('injected_after_commit_failure')
    }
    await expect(client.send(session.session_id, 'accepted but reply lost', 0)).rejects.toThrow(
      'outcome_unknown'
    )
    const pending = await client.pending()
    expect(pending).toHaveLength(1)
    core.fault = undefined
    const result = core.request(
      actor,
      pending[0]!.method,
      pending[0]!.params,
      pending[0]!.operation_id
    )
    expect(result).toHaveProperty('accepted_seq')
    expect(
      core.read(session.session_id, 0).filter((e) => e.type === 'input.accepted')
    ).toHaveLength(1)
  } finally {
    await client.disconnect()
    await close()
    await server
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('revocation fences queued publication records, not only the start of a replay page', async () => {
  const dir = mkdtempSync(resolve('.scratch/revoke-publication-')),
    core = new NodeCore(dir)
  const token = core.createToken('publication'),
    actor = core.authority.authenticate(token.token)
  const session = core.request(actor, 'session.create', { title: 'publication' }, 'session') as {
    session_id: string
  }
  core.request(
    actor,
    'session.send',
    { session_id: session.session_id, text: 'history', observed_seq: 0 },
    'input'
  )
  core.tick()
  const incoming = new RecordQueue()
  let release: () => void = () => {},
    started: () => void = () => {},
    closed = false
  const firstEvent = new Promise<void>((r) => {
      started = r
    }),
    events: RecordFrame[] = []
  const transport: RecordTransport = {
    receive: () => incoming,
    close: async () => {
      closed = true
      incoming.end()
    },
    send: async (bytes) => {
      const frame = FrameCodec.decode(bytes)
      if (frame.kind === 'event') {
        events.push(frame)
        if (events.length === 1) {
          started()
          await new Promise<void>((r) => {
            release = r
          })
        }
      }
    },
  }
  const server = serveChannel(transport, core)
  try {
    incoming.push(
      FrameCodec.encode({ kind: 'auth', profile: 'local-token-v1', token: token.token })
    )
    await sleep(5)
    incoming.push(FrameCodec.encode({ kind: 'hello', version: { major: 0, minor: 0 } }))
    await sleep(5)
    incoming.push(
      FrameCodec.encode({
        kind: 'request',
        request_id: 'subscribe',
        method: 'stream.subscribe',
        params: { stream_id: session.session_id, after_seq: 0 },
      })
    )
    await firstEvent
    core.revokeToken(token.installation_id)
    release()
    await sleep(50)
    expect(closed).toBe(true)
    expect(events).toHaveLength(1)
  } finally {
    release()
    await transport.close('done')
    await server
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('a no-ack slow consumer is bounded across all streams and cannot stall another session', async () => {
  const dir = mkdtempSync(resolve('.scratch/slow-')),
    core = new NodeCore(dir)
  const token = core.createToken('slow'),
    actor = core.authority.authenticate(token.token)
  const streams: string[] = []
  for (let s = 0; s < 4; s++) {
    const session = core.request(actor, 'session.create', { title: 'slow' }, 'create-' + s) as {
      session_id: string
    }
    streams.push(session.session_id)
    for (let i = 0; i < 40; i++) {
      core.request(
        actor,
        'session.send',
        { session_id: session.session_id, text: 'x'.repeat(8000), observed_seq: 0 },
        'send-' + s + '-' + i
      )
      core.tick()
    }
  }
  const queue = new RecordQueue(),
    sent: RecordFrame[] = []
  let closed = false
  let bytes = 0
  const transport: RecordTransport = {
    receive: () => queue,
    send: async (record) => {
      const frame = FrameCodec.decode(record)
      if (frame.kind === 'event') bytes += record.byteLength
      else sent.push(frame)
    },
    close: async () => {
      closed = true
      queue.end()
    },
  }
  const server = serveChannel(transport, core)
  const push = (value: unknown) => queue.push(FrameCodec.encode(value))
  try {
    push({ kind: 'auth', profile: 'local-token-v1', token: token.token })
    await sleep(10)
    push({ kind: 'hello', version: { major: 0, minor: 0 } })
    await sleep(10)
    for (const [i, stream_id] of streams.entries())
      push({
        kind: 'request',
        request_id: 'subscribe-' + i,
        method: 'stream.subscribe',
        params: { stream_id, after_seq: 0 },
      })
    for (let i = 0; i < 100 && !closed; i++) await sleep(10)
    expect(closed).toBe(true)
    expect(bytes).toBeLessThanOrEqual(LIMITS.unacked_bytes)
    const fast = core.request(actor, 'session.create', { title: 'not stalled' }, 'fast') as {
      session_id: string
    }
    core.request(
      actor,
      'session.send',
      { session_id: fast.session_id, text: 'completed', observed_seq: 0 },
      'fast-send'
    )
    core.tick()
    expect(core.read(fast.session_id, 0).some((e) => e.type === 'input.completed')).toBe(true)
  } finally {
    await transport.close('test_done')
    await server
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('malformed/oversized first records, unknown versions and text-shaped records fail closed', async () => {
  const dir = mkdtempSync(resolve('.scratch/records-')),
    core = new NodeCore(dir)
  const token = core.createToken('records')
  try {
    for (const invalid of [
      new TextEncoder().encode('{'),
      new TextEncoder().encode('{"kind":"unknown"}'),
      new Uint8Array(LIMITS.auth_bytes + 1),
    ]) {
      const queue = new RecordQueue()
      let closed = false
      const transport: RecordTransport = {
        receive: () => queue,
        send: async () => {},
        close: async () => {
          closed = true
          queue.end()
        },
      }
      const server = serveChannel(transport, core)
      queue.push(invalid)
      await server
      expect(closed).toBe(true)
    }
    const queue = new RecordQueue(),
      frames: RecordFrame[] = []
    const transport: RecordTransport = {
      receive: () => queue,
      send: async (b) => {
        frames.push(FrameCodec.decode(b))
      },
      close: async () => queue.end(),
    }
    const server = serveChannel(transport, core)
    queue.push(FrameCodec.encode({ kind: 'auth', profile: 'local-token-v1', token: token.token }))
    await sleep(5)
    queue.push(
      new TextEncoder().encode(JSON.stringify({ kind: 'hello', version: { major: 1, minor: 0 } }))
    )
    await server
    expect(frames.map((f) => f.kind)).toEqual(['authenticated'])
  } finally {
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
