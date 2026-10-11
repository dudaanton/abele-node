import { PassThrough, Writable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { DapTransport } from '../../packages/node-core/src/debugger/dap.js'
import { wire, packet } from './dap-wire.js'

describe('bounded production DAP transport', () => {
  it('decodes fragmented UTF-8 and batches; correlates out-of-order replies by request_seq', async () => {
    const w = wire(),
      events: any[] = []
    w.dap.onEvent((e) => events.push(e))
    const a = w.dap.request('threads'),
      b = w.dap.request('stackTrace')
    w.reply(w.messages[1], { second: true })
    w.reply(w.messages[0], { first: true })
    expect(await a).toEqual({ first: true })
    expect(await b).toEqual({ second: true })
    const bytes = Buffer.concat([
      packet({ seq: 1, type: 'event', event: 'output', body: { output: 'hé 🌲' } }),
      packet({ seq: 2, type: 'event', event: 'initialized' }),
    ])
    for (const byte of bytes) w.input.write(Buffer.from([byte]))
    expect(events[0].body.output).toBe('hé 🌲')
    expect(events[1].event).toBe('initialized')
    w.dap.close()
  })
  it.each([
    ['Content-Length: nope\r\n\r\n', 'dap_header'],
    ['Content-Length: 9\r\nContent-Length: 9\r\n\r\n', 'dap_header'],
    ['Content-Length: 99999999\r\n\r\n', 'dap_frame_limit'],
    ['x'.repeat(8193), 'dap_header_limit'],
    ['Content-Length: 1\r\n\r\n{', 'dap_json'],
    ['Content-Length: 2\r\n\r\n{}', 'dap_message'],
  ])('fails pending requests closed on malformed input %s', async (bytes, error) => {
    const w = wire(),
      pending = w.dap.request('threads')
    const failed = expect(pending).rejects.toThrow(error)
    w.input.write(bytes)
    await failed
    expect(w.dap.pendingCount).toBe(0)
    await expect(w.dap.request('threads')).rejects.toThrow(error)
  })
  it('rejects invalid UTF-8 instead of replacing bytes', async () => {
    const w = wire(),
      p = w.dap.request('threads')
    const rejected = expect(p).rejects.toThrow('dap_json')
    w.input.write(Buffer.concat([Buffer.from('Content-Length: 1\r\n\r\n'), Buffer.from([255])]))
    await rejected
  })
  it('bounds partial-frame lifetime and clears requests on EOF', async () => {
    vi.useFakeTimers()
    try {
      const w = wire({ frameTimeoutMs: 20 }),
        p = w.dap.request('threads')
      const rejected = expect(p).rejects.toThrow('dap_frame_timeout')
      w.input.write('Content-Length: 100\r\n\r\n{')
      await vi.advanceTimersByTimeAsync(20)
      await rejected
      const other = wire(),
        pending = other.dap.request('threads')
      other.input.end()
      await expect(pending).rejects.toThrow('dap_eof')
      expect(other.dap.pendingCount).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('times out, cancels, ignores late replies, and bounds pending requests', async () => {
    vi.useFakeTimers()
    try {
      const w = wire({ requestTimeoutMs: 10, maxPending: 1 })
      const pending = w.dap.request('threads')
      const timeout = expect(pending).rejects.toThrow('dap_timeout')
      await expect(w.dap.request('threads')).rejects.toThrow('dap_pending_limit')
      await vi.advanceTimersByTimeAsync(10)
      await timeout
      w.reply(w.messages[0])
      const controller = new AbortController()
      const cancelled = w.dap.request('threads', {}, { signal: controller.signal })
      controller.abort()
      await expect(cancelled).rejects.toThrow('dap_cancelled')
      expect(w.dap.pendingCount).toBe(0)
      w.reply(w.messages[1])
      w.dap.close()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('sends protocol cancellation only when negotiated and never dispatches pre-aborted requests', async () => {
    const w = wire()
    w.dap.supportsCancellation = true
    const controller = new AbortController()
    const p = w.dap.request('threads', {}, { signal: controller.signal })
    controller.abort()
    await expect(p).rejects.toThrow('dap_cancelled')
    expect(w.messages[1]).toMatchObject({
      command: 'cancel',
      arguments: { requestId: w.messages[0].seq },
    })
    w.reply(w.messages[1])
    await Promise.resolve()
    const before = w.messages.length
    await expect(w.dap.request('threads', {}, { signal: controller.signal })).rejects.toThrow(
      'dap_cancelled'
    )
    expect(w.messages).toHaveLength(before)
    w.dap.close()
  })
  it('denies reverse requests by default without executing anything', async () => {
    const w = wire()
    for (const command of ['runInTerminal', 'startDebugging', 'unknown'])
      w.send({ type: 'request', command, arguments: {} })
    await Promise.resolve()
    expect(w.messages).toHaveLength(3)
    expect(
      w.messages.every(
        (m) => m.type === 'response' && !m.success && m.message === 'reverse_request_denied'
      )
    ).toBe(true)
    w.dap.close()
  })
  it('bounds reverse request lifetimes, concurrency, and duplicate requests', async () => {
    vi.useFakeTimers()
    try {
      const w = wire({ reverseTimeoutMs: 10, maxReverse: 1, reverse: () => new Promise(() => {}) })
      w.send({ seq: 9, type: 'request', command: 'startDebugging' })
      w.send({ seq: 10, type: 'request', command: 'startDebugging' })
      expect(w.messages[0].success).toBe(false)
      await vi.advanceTimersByTimeAsync(10)
      expect(w.messages[1]).toMatchObject({ request_seq: 9, success: false })
      w.dap.close()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
  it('retains active reverse sequence protection while completed history overflows', async () => {
    vi.useFakeTimers()
    const signals: AbortSignal[] = [],
      calls: number[] = []
    const w = wire({
      maxReverse: 2,
      reverse: async (request, signal) => {
        calls.push(request.seq)
        signals.push(signal)
        if (request.seq === 1) return new Promise(() => {})
        return {}
      },
    })
    try {
      w.send({ seq: 1, type: 'request', command: 'startDebugging' })
      await Promise.resolve()
      for (let seq = 2; seq <= 130; seq++) {
        w.send({ seq, type: 'request', command: 'startDebugging' })
        for (let i = 0; i < 5; i++) await Promise.resolve()
      }
      expect(w.messages).toHaveLength(129)
      w.send({ seq: 1, type: 'request', command: 'startDebugging' })
      await Promise.resolve()
      expect(w.dap.closed).toBe(true)
      expect(calls.filter((seq) => seq === 1)).toHaveLength(1)
      expect(signals.every((signal) => signal.aborted)).toBe(true)
    } finally {
      w.dap.close()
      const timers = vi.getTimerCount()
      vi.useRealTimers()
      expect(timers).toBe(0)
    }
  })
  it('bounds capacity waits, cancels before dispatch and rechecks admission at the actual slot', async () => {
    vi.useFakeTimers()
    const w = wire({ maxPending: 1 })
    try {
      const holder = w.dap.request('threads')
      const controller = new AbortController()
      const cancelled = w.dap.requestWhenAvailable('stackTrace', {}, { signal: controller.signal })
      controller.abort()
      await expect(cancelled).rejects.toThrow('dap_cancelled')
      expect(w.messages).toHaveLength(1)
      const timed = w.dap.requestWhenAvailable('stackTrace', {}, { timeoutMs: 10 })
      const timeout = expect(timed).rejects.toThrow('dap_slot_timeout')
      await vi.advanceTimersByTimeAsync(10)
      await timeout
      let allowed = true
      const queued = w.dap.requestWhenAvailable(
        'stackTrace',
        {},
        {
          beforeDispatch: () => {
            if (!allowed) throw new Error('storage_unavailable')
          },
        }
      )
      const denied = expect(queued).rejects.toThrow('storage_unavailable')
      await expect(w.dap.requestWhenAvailable('variables')).rejects.toThrow('dap_queue_limit')
      allowed = false
      w.reply(w.messages[0])
      await holder
      await denied
      expect(w.messages).toHaveLength(1)
      expect(w.dap.closed).toBe(false)
      const last = w.dap.request('threads'),
        waiting = w.dap.requestWhenAvailable('stackTrace')
      w.dap.close()
      await expect(last).rejects.toThrow('dap_closed')
      await expect(waiting).rejects.toThrow('dap_closed')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      w.dap.close()
      vi.useRealTimers()
    }
  })
  it('fails on command mismatches, unknown replies and write backpressure', async () => {
    for (const mismatch of [true, false]) {
      const w = wire(),
        p = w.dap.request('threads')
      w.send({
        type: 'response',
        request_seq: mismatch ? w.messages[0].seq : 999,
        command: 'wrong',
        success: true,
      })
      await expect(p).rejects.toThrow('dap_correlation')
    }
    const input = new PassThrough()
    const output = new Writable({ write(_chunk, _encoding, _callback) {} })
    const dap = new DapTransport(input, output, { maxWriteBytes: 256 })
    const p = dap.request('threads', { text: 'x'.repeat(180) })
    const rejection = expect(p).rejects.toThrow('dap_backpressure')
    await expect(dap.request('threads')).rejects.toThrow('dap_backpressure')
    await rejection
    dap.close()
  })
  it('keeps independent connections isolated', async () => {
    const a = wire(),
      b = wire(),
      p = a.dap.request('threads'),
      q = b.dap.request('threads')
    a.input.destroy(new Error('adapter_broken'))
    b.reply(b.messages[0], { threads: [] })
    await expect(p).rejects.toThrow('adapter_broken')
    expect(await q).toEqual({ threads: [] })
    b.dap.close()
  })
})
