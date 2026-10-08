// Explicit scratch-library comparison, not part of the ordinary test suite.
import assert from 'node:assert/strict'
import { PassThrough } from 'node:stream'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { frame } from './debug-dap.mjs'
const require = createRequire(resolve('.scratch/adapters/npm/package.json'))
const { ProtocolClient } = require('@vscode/debugadapter-testsupport/lib/protocolClient')
const input = new PassThrough()
const output = new PassThrough()
const client = new ProtocolClient()
client.connect(input, output)
const a = client.send('a')
const b = client.send('b')
const bytes = Buffer.concat([
  frame({ type: 'response', request_seq: 2, success: true, body: { value: 'é' } }),
  frame({ type: 'response', request_seq: 1, success: true, body: { value: 1 } }),
])
for (const byte of bytes) input.write(Buffer.from([byte]))
assert.equal((await a).body.value, 1)
assert.equal((await b).body.value, 'é')
let reverseReplies = 0
output.on('data', () => reverseReplies++)
input.write(frame({ type: 'request', seq: 9, command: 'startDebugging', arguments: {} }))
assert.equal(reverseReplies, 0, 'testsupport silently drops reverse requests')
const pending = client.send('never')
void pending
assert.equal(client.pendingRequests.size, 1, 'no per-request deadline/cancellation API')
console.log(
  'PASS testsupport fragmented UTF-8/out-of-order responses; reverse request dropped; pending request remains'
)
input.destroy()
output.destroy()
