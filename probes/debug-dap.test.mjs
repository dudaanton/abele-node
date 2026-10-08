import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { Dap, frame } from './debug-dap.mjs'

// Synthetic only: never starts a real adapter or a model provider.
test('DAP framing handles byte fragmentation, UTF-8 and coalesced out-of-order replies', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const dap = new Dap(input, output, { timeout: 200 })
  const a = dap.request('a')
  const b = dap.request('b')
  const bytes = Buffer.concat([
    frame({ type: 'response', request_seq: 2, success: true, body: { value: 'é' } }),
    frame({ type: 'response', request_seq: 1, success: true, body: { value: 1 } }),
  ])
  for (const byte of bytes) input.write(Buffer.from([byte]))
  assert.deepEqual(await a, { value: 1 })
  assert.deepEqual(await b, { value: 'é' })
  dap.close()
})

test('events committed before wait are retained; reverse requests receive responses', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  let reply = Buffer.alloc(0)
  output.on('data', (b) => {
    reply = Buffer.concat([reply, b])
  })
  const dap = new Dap(input, output, {
    timeout: 200,
    reverse: async (request) => {
      assert.equal(request.command, 'startDebugging')
      return { accepted: true }
    },
  })
  input.write(frame({ type: 'event', event: 'initialized' }))
  input.write(frame({ type: 'request', seq: 8, command: 'startDebugging', arguments: {} }))
  assert.equal((await dap.event('initialized')).event, 'initialized')
  await new Promise((r) => setImmediate(r))
  assert.match(reply.toString(), /"request_seq":8/)
  assert.match(reply.toString(), /"success":true/)
  dap.close()
})

test('timeout and adapter EOF reject requests rather than hanging', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const input = new PassThrough()
  const output = new PassThrough()
  const dap = new Dap(input, output, { timeout: 20 })
  const timedOut = assert.rejects(dap.request('never'), /timeout/)
  t.mock.timers.tick(21)
  await timedOut
  const pending = dap.request('dies')
  input.end()
  await assert.rejects(pending, /closed/)
  dap.close()
})
