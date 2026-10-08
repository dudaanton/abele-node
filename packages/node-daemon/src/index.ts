import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import { createServer, createConnection, type Server } from 'node:net'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { NodeCore, ClaudeProviderAdapter } from '@abele/node-core'
import type { ClaudeOptions } from '@abele/provider-claude'
import { TokenCommandSchema } from '@abele/node-protocol'
import { serveChannel } from '@abele/channel-server'
import { RecordQueue } from '@abele/channel-client'
import { ChannelError, LIMITS, type RecordTransport } from '@abele/channel-protocol'
import type WebSocket from 'ws'

export function readRuntime(
  dir: string
):
  | { pid: number; port?: number; node_id?: string; claude?: unknown; control_socket?: string }
  | undefined {
  try {
    const value = JSON.parse(readFileSync(join(dir, 'daemon.lock'), 'utf8')) as {
      pid: number
      port?: number
      node_id?: string
      claude?: unknown
      control_socket?: string
    }
    if (!Number.isSafeInteger(value.pid) || value.pid < 1) return
    process.kill(value.pid, 0)
    return value
  } catch {
    return
  }
}
export function takeLock(dir: string): () => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  const path = join(dir, 'daemon.lock')
  for (let i = 0; i < 2; i++) {
    try {
      writeFileSync(path, JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 })
      return () => {
        try {
          const lock = JSON.parse(readFileSync(path, 'utf8')) as { pid: number }
          if (lock.pid === process.pid) unlinkSync(path)
        } catch {}
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (readRuntime(dir)) throw new ChannelError('already_running')
      // An unreadable or half-written owner record is never proof that its owner died.
      let pid: number
      try {
        pid = (JSON.parse(readFileSync(path, 'utf8')) as { pid: number }).pid
      } catch {
        throw new ChannelError('lock_needs_doctor')
      }
      if (!Number.isSafeInteger(pid) || pid < 1) throw new ChannelError('lock_needs_doctor')
      try {
        process.kill(pid, 0)
        throw new ChannelError('already_running')
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ESRCH') throw e
      }
      unlinkSync(path)
    }
  }
  throw new ChannelError('already_running')
}
class WsTransport implements RecordTransport {
  private queue = new RecordQueue()
  constructor(private ws: WebSocket) {
    ws.on('message', (data, binary) => {
      try {
        if (!binary) throw new ChannelError('binary_required')
        const buffer = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[])
        this.queue.push(buffer)
      } catch {
        ws.terminate()
        this.queue.end()
      }
    })
    ws.on('close', () => this.queue.end())
    ws.on('error', () => this.queue.end())
  }
  async send(bytes: Uint8Array) {
    if (this.ws.readyState !== 1) throw new ChannelError('disconnected')
    if (this.ws.bufferedAmount + bytes.length > LIMITS.unacked_bytes) {
      this.ws.terminate()
      throw new ChannelError('slow_consumer')
    }
    await new Promise<void>((resolve, reject) =>
      this.ws.send(bytes, { binary: true }, (e) => (e ? reject(e) : resolve()))
    )
  }
  receive() {
    return this.queue
  }
  async close(reason: string) {
    this.queue.end()
    if (this.ws.readyState < 2) {
      this.ws.close(1000, reason.slice(0, 100))
      this.ws.terminate()
    }
  }
}
function tokenCommand(core: NodeCore, raw: unknown) {
  const command = TokenCommandSchema.parse(raw)
  switch (command.action) {
    case 'create':
      return core.createToken(command.value ?? 'installation')
    case 'list':
      return core.listTokens()
    case 'revoke':
      if (!command.value) throw new Error('installation_id_required')
      core.revokeToken(command.value)
      return { revoked: command.value }
    default:
      throw new Error('unknown_token_command')
  }
}
export async function control(
  dir: string,
  command: { action: string; value?: string }
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const runtime = readRuntime(dir)
    // Older running daemons did not publish an endpoint; keep their CLI compatible.
    const endpoint =
      typeof runtime?.control_socket === 'string'
        ? runtime.control_socket
        : join(dir, 'control.sock')
    const socket = createConnection(endpoint)
    let data = ''
    socket.setTimeout(3000, () => socket.destroy(new Error('control_timeout')))
    socket.on('connect', () => socket.end(JSON.stringify(command) + '\n'))
    socket.on('data', (chunk) => {
      data += chunk
      if (data.length > 65536) socket.destroy(new Error('control_too_large'))
    })
    socket.on('error', reject)
    socket.on('end', () => {
      try {
        const response = JSON.parse(data) as { result?: unknown; error?: string }
        if (response.error) reject(new Error(response.error))
        else resolve(response.result)
      } catch (error) {
        reject(error)
      }
    })
  })
}
export async function offlineToken(dir: string, command: { action: string; value?: string }) {
  if (readRuntime(dir)) return control(dir, command)
  const release = takeLock(dir)
  try {
    const core = new NodeCore(dir)
    try {
      return tokenCommand(core, command)
    } finally {
      core.close()
    }
  } finally {
    release()
  }
}
export async function startDaemon(
  dir: string,
  port = 7777,
  worktreeRoot?: string,
  claudeOptions: ClaudeOptions = {}
) {
  const release = takeLock(dir)
  let core: NodeCore | undefined, ipc: Server | undefined
  const app = Fastify({ logger: false, bodyLimit: LIMITS.record_bytes })
  const sockets = new Set<WebSocket>()
  const channels = new Set<Promise<void>>()
  let jobs: Promise<void> | undefined
  let execution: Promise<void> | undefined
  let timer: ReturnType<typeof setInterval> | undefined
  let stopped = false
  let controlDirectory: string | undefined
  const stop = async () => {
    if (stopped) return
    stopped = true
    if (timer) clearInterval(timer)
    for (const socket of sockets) socket.terminate()
    await app.close()
    await Promise.allSettled([...channels])
    await core?.claude.stop()
    await execution
    await core?.resources.stop()
    if (ipc) await new Promise<void>((r) => ipc!.close(() => r()))
    if (controlDirectory) rmSync(controlDirectory, { recursive: true, force: true })
    core?.close()
    release()
  }
  try {
    core = new NodeCore(dir, {
      ...(worktreeRoot ? { worktreeRoot } : {}),
      claude: new ClaudeProviderAdapter(claudeOptions),
    })
    await core.claude.reconcile()
    await app.register(websocket, {
      options: { maxPayload: LIMITS.record_bytes, perMessageDeflate: false },
    })
    app.addHook('onRequest', async (request, reply) => {
      const host = request.headers.host,
        origin = request.headers.origin
      const localAddress = request.socket.remoteAddress
      const bound = app.server.address()
      if (
        !bound ||
        typeof bound === 'string' ||
        host !== `127.0.0.1:${bound.port}` ||
        localAddress !== '127.0.0.1' ||
        (origin !== undefined && origin !== 'app://obsidian.md')
      )
        return reply.code(403).send()
      if (request.url !== '/channel') return reply.code(404).send()
      if (sockets.size >= LIMITS.connections) return reply.code(503).send()
    })
    app.get('/channel', { websocket: true }, (socket) => {
      // Several async upgrade hooks can pass simultaneously; enforce again here.
      if (sockets.size >= LIMITS.connections) {
        socket.terminate()
        return
      }
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
      const task = serveChannel(new WsTransport(socket), core!)
      channels.add(task)
      void task.finally(() => channels.delete(task)).catch(() => {})
    })
    await app.listen({ host: '127.0.0.1', port })
    const address = app.server.address()
    if (!address || typeof address === 'string') throw new Error('invalid_listener')
    // macOS/libuv can silently truncate long sun_path values. The state directory
    // is unbounded, so put the endpoint in a private, randomly named short directory
    // and publish it only after listen/chmod succeed. Long custom TMPDIRs use /tmp.
    const base =
      Buffer.byteLength(join(tmpdir(), 'abele-c-XXXXXX/c.sock')) <= 100 ? tmpdir() : '/tmp'
    controlDirectory = mkdtempSync(join(base, 'abele-c-'))
    chmodSync(controlDirectory, 0o700)
    const socketPath = join(controlDirectory, 'c.sock')
    ipc = createServer({ allowHalfOpen: true }, (socket) => {
      let data = ''
      socket.setTimeout(3000, () => socket.destroy())
      socket.on('error', () => {})
      socket.on('data', (chunk) => {
        data += chunk
        if (data.length > LIMITS.auth_bytes) socket.destroy()
      })
      socket.on('end', () => {
        try {
          socket.end(JSON.stringify({ result: tokenCommand(core!, JSON.parse(data)) }))
        } catch {
          socket.end(JSON.stringify({ error: 'invalid_control_command' }))
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      ipc!.once('error', reject)
      ipc!.listen(socketPath, () => resolve())
    })
    chmodSync(socketPath, 0o600)
    writeFileSync(
      join(dir, 'daemon.lock'),
      JSON.stringify({
        pid: process.pid,
        port: address.port,
        node_id: core.node_id,
        claude: core.claude.capabilities(),
        control_socket: socketPath,
      }),
      { mode: 0o600 }
    )
    timer = setInterval(() => {
      try {
        core!.tick()
        if (!execution) {
          execution = core!.claude.drain()
          void execution
            .catch(() => {
              console.error('provider execution paused: inspect durable runs and restart')
              if (timer) clearInterval(timer)
            })
            .finally(() => {
              execution = undefined
            })
        }
        if (!jobs) {
          jobs = core!.resources.jobs.drain()
          void jobs
            .catch(() => {
              console.error('provisioning paused: inspect durable jobs and restart')
              if (timer) clearInterval(timer)
            })
            .finally(() => {
              jobs = undefined
            })
        }
      } catch {
        console.error('storage_unavailable: execution paused until restart')
        if (timer) clearInterval(timer)
      }
    }, 20)
    return { port: address.port, node_id: core.node_id, stop }
  } catch (error) {
    await stop()
    throw error
  }
}
