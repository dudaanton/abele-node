import { createServer } from 'node:https'
import { createConnection } from 'node:net'
import type { Duplex } from 'node:stream'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import WebSocket from 'ws'
import { BrowserRecordTransport } from '@abele/channel-client'
import type { RecordTransport } from '@abele/channel-protocol'

/** Real TLS termination for edited-route tests. Forward the ORIGINAL Host, never canonicalize it. */
export async function testTlsRoute() {
  const dir = mkdtempSync(join(tmpdir(), 'paired-route-'))
  const keyPath = join(dir, 'key.pem'),
    certPath = join(dir, 'cert.pem')
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=Pairing test',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-keyout',
      keyPath,
      '-out',
      certPath,
    ],
    { stdio: 'ignore' }
  )
  const cert = readFileSync(certPath),
    sockets = new Set<Duplex>(),
    hosts: string[] = []
  let backendPort = 0
  const server = createServer({ key: readFileSync(keyPath), cert })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (request, socket, head) => {
    hosts.push(request.headers.host ?? '')
    const backend = createConnection({ host: '127.0.0.1', port: backendPort })
    sockets.add(backend)
    backend.once('close', () => sockets.delete(backend))
    backend.on('error', () => socket.destroy())
    socket.on('error', () => backend.destroy())
    socket.once('close', () => backend.destroy())
    backend.on('connect', () => {
      const headers: string[] = []
      for (let i = 0; i < request.rawHeaders.length; i += 2)
        headers.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`)
      backend.write(`${request.method} ${request.url} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n`)
      if (head.length) backend.write(head)
      backend.pipe(socket)
      socket.pipe(backend)
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('invalid_test_listener')
  const endpoint = `wss://127.0.0.1:${address.port}/channel`
  const open = async (url: string): Promise<RecordTransport> => {
    // URL controls dial destination, certificate identity and HTTP Host. Only the test CA is added.
    const ws = new WebSocket(url, { ca: cert, family: 4, origin: 'app://obsidian.md' })
    const transport = new BrowserRecordTransport(ws as unknown as globalThis.WebSocket)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.on('error', reject)
      ws.once('unexpected-response', (_request, response) => {
        response.resume()
        const code =
          response.headers['x-abele-pairing-error'] === 'host_not_accepted'
            ? 'PAIRED_HOST_NOT_ACCEPTED'
            : 'PAIRED_ROUTE_REFUSED'
        reject(Object.assign(new Error(code), { code }))
        ws.terminate()
      })
    })
    return transport
  }
  return {
    endpoint,
    hosts,
    open,
    setBackendPort: (port: number) => {
      backendPort = port
    },
    stop: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
