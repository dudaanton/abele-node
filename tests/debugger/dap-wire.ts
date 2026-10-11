import { PassThrough } from 'node:stream'
import { DapTransport } from '../../packages/node-core/src/debugger/dap.js'

export function wire(options: ConstructorParameters<typeof DapTransport>[2] = {}) {
  const input = new PassThrough(),
    output = new PassThrough()
  const messages: any[] = []
  let bytes = Buffer.alloc(0)
  output.on('data', (chunk) => {
    bytes = Buffer.concat([bytes, chunk])
    while (true) {
      const end = bytes.indexOf('\r\n\r\n')
      if (end < 0) return
      const length = Number(/Content-Length: (\d+)/.exec(bytes.subarray(0, end).toString())![1])
      if (bytes.length < end + 4 + length) return
      messages.push(JSON.parse(bytes.subarray(end + 4, end + 4 + length).toString()))
      bytes = bytes.subarray(end + 4 + length)
    }
  })
  const dap = new DapTransport(input, output, options)
  let seq = 1000
  const send = (message: object) => input.write(packet({ seq: seq++, ...message }))
  const reply = (request: any, body: object = {}, success = true) =>
    send({
      type: 'response',
      request_seq: request.seq,
      command: request.command,
      success,
      body,
    })
  return { dap, input, output, messages, send, reply }
}
export function packet(message: object) {
  const body = Buffer.from(JSON.stringify(message))
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
}
