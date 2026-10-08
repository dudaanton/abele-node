// Disposable connectivity probe, NOT a production WebSocket implementation.
// Only unfragmented, masked client frames <= 4096 bytes; no compression or authentication.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { pathToFileURL } from 'node:url'

function frame(opcode, payload) {
  const header = Buffer.alloc(payload.length < 126 ? 2 : 4)
  header[0] = 0x80 | opcode
  header[1] = payload.length < 126 ? payload.length : 126
  if (payload.length >= 126) header.writeUInt16BE(payload.length, 2)
  return Buffer.concat([header, payload])
}

export function createEchoServer(log = console.log) {
  const sockets = new Set()
  const server = createServer((request, response) => {
    const message =
      new URL(request.url, 'http://probe.invalid').searchParams.get('message') ?? 'hello'
    response.writeHead(200, {
      'Content-Type': 'text/plain',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    })
    response.end(message.slice(0, 256))
    log(JSON.stringify({ type: 'http', method: request.method, message: message.slice(0, 256) }))
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    socket.setTimeout(30_000, () => socket.destroy())
  })
  server.on('upgrade', (request, socket, head) => {
    const key = request.headers['sec-websocket-key']
    if (request.headers.upgrade?.toLowerCase() !== 'websocket' || !key) return socket.destroy()
    const accept = createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    )
    log(JSON.stringify({ type: 'ws.open', origin: request.headers.origin ?? null }))
    let pending = Buffer.alloc(0)
    const consume = (chunk) => {
      pending = Buffer.concat([pending, chunk])
      while (pending.length >= 2) {
        const opcode = pending[0] & 15
        const shortLength = pending[1] & 127
        if (!(pending[0] & 128) || pending[0] & 112 || !(pending[1] & 128) || shortLength === 127) {
          return socket.destroy()
        }
        const offset = shortLength === 126 ? 4 : 2
        if (pending.length < offset) return
        const length = shortLength === 126 ? pending.readUInt16BE(2) : shortLength
        if (length > 4096) return socket.destroy()
        if (pending.length < offset + 4 + length) return
        const mask = pending.subarray(offset, offset + 4)
        const payload = Buffer.from(pending.subarray(offset + 4, offset + 4 + length))
        pending = pending.subarray(offset + 4 + length)
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]
        if (opcode === 8) return socket.end(frame(8, payload))
        if (opcode === 9) socket.write(frame(10, payload))
        else if (opcode === 1 || opcode === 2) {
          socket.write(frame(opcode, payload))
          log(JSON.stringify({ type: 'ws.echo', bytes: length, message: payload.toString('utf8') }))
        } else return socket.destroy()
      }
    }
    socket.on('data', consume)
    if (head.length) consume(head)
  })
  server.stop = () => {
    for (const socket of sockets) socket.destroy()
    server.close()
  }
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [host, rawPort = '43123', rawSeconds = '600'] = process.argv.slice(2)
  const port = Number(rawPort)
  const seconds = Number(rawSeconds)
  if (
    !host ||
    ['0.0.0.0', '::'].includes(host) ||
    !Number.isInteger(port) ||
    port <= 40000 ||
    port > 65535 ||
    !Number.isFinite(seconds) ||
    seconds <= 0 ||
    seconds > 600
  ) {
    throw new Error(
      'Usage: node probes/echo-server.mjs <LAN-or-Tailscale-address> [port>40000] [deadline-seconds<=600]'
    )
  }
  const server = createEchoServer()
  const timer = setTimeout(() => server.stop(), seconds * 1000)
  server.on('close', () => clearTimeout(timer))
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.stop())
  server.listen(port, host, () =>
    console.log(JSON.stringify({ type: 'listening', port, deadline_seconds: seconds }))
  )
}
