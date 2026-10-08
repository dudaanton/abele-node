import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import * as checks from './debug-check.mjs'
import { Dap, frame } from './debug-dap.mjs'

for (const command of ['launch', 'attach']) {
  test(`${command} rejection interrupts configuration wait and clears DAP waiters`, async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const dap = new Dap(input, output, { timeout: 200 })
    output.once('data', () =>
      queueMicrotask(() =>
        input.write(
          frame({
            type: 'response',
            request_seq: 1,
            command,
            success: false,
            message: 'synthetic refusal',
          })
        )
      )
    )
    try {
      await assert.rejects(
        checks.startConfigured(dap, command, {}, () => checks.configure(dap, '/synthetic.py', 10)),
        /synthetic refusal/
      )
      assert.equal(dap.pending.size, 0)
      assert.equal(dap.listenerCount('event'), 0)
      assert.equal(dap.listenerCount('closed'), 0)
      assert.equal(dap.closed, true)
    } finally {
      dap.close()
      input.destroy()
      output.destroy()
    }
  })
}

test('configuration failure cancels the pending start request without an unhandled rejection', async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  const dap = new Dap(input, output, { timeout: 200 })
  try {
    await assert.rejects(
      checks.startConfigured(dap, 'launch', {}, async () => {
        throw new Error('bad breakpoint')
      }),
      /bad breakpoint/
    )
    assert.equal(dap.pending.size, 0)
    assert.equal(dap.closed, true)
  } finally {
    dap.close()
    input.destroy()
    output.destroy()
  }
})

function inspection(next) {
  let stepped = false
  return {
    cursor: 0,
    event: async () => ({ body: { reason: stepped ? 'step' : 'breakpoint', threadId: 1 } }),
    request: async (command) => {
      switch (command) {
        case 'threads':
          return { threads: [{ id: 1 }] }
        case 'stackTrace':
          return {
            stackFrames: [stepped ? next : { id: 1, source: { path: '/synthetic.ts' }, line: 10 }],
          }
        case 'scopes':
          return { scopes: [{ variablesReference: 1 }] }
        case 'variables':
          return { variables: [{ name: 'input', value: '40' }] }
        case 'evaluate':
          return { result: '42' }
        case 'next':
          stepped = true
          return {}
        default:
          throw new Error(command)
      }
    },
  }
}
for (const [name, next] of [
  [
    'generated JS rather than the TypeScript source',
    { id: 2, source: { path: '/synthetic.js' }, line: 11 },
  ],
  ['wrong TypeScript line', { id: 2, source: { path: '/synthetic.ts' }, line: 12 }],
]) {
  test(`step rejects ${name}`, async () => {
    await assert.rejects(
      checks.inspectAndStep(inspection(next), '/synthetic.ts', 10, 'input + 2', '42'),
      { name: 'AssertionError' }
    )
  })
}
test('step accepts the exact next TypeScript source and line', async () => {
  const result = await checks.inspectAndStep(
    inspection({ id: 2, source: { path: '/synthetic.ts' }, line: 11 }),
    '/synthetic.ts',
    10,
    'input + 2',
    '42'
  )
  assert.equal(result.next.source.path, '/synthetic.ts')
  assert.equal(result.next.line, 11)
})
