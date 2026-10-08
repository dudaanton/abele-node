// Container-only port forwarding. The native daemon remains loopback-only.
import { createServer, createConnection } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { startDaemon, readRuntime } from '../packages/node-daemon/dist/index.js'

export async function createForwarder(targetPort, port = 7778, host = '0.0.0.0') {
  const sockets = new Set()
  const server = createServer((client) => {
    // At most 32 client/backend pairs. The daemon also bounds admission and records.
    if (sockets.size >= 64) return client.destroy()
    const backend = createConnection({ host: '127.0.0.1', port: targetPort })
    sockets.add(client)
    sockets.add(backend)
    const close = () => {
      client.destroy()
      backend.destroy()
      sockets.delete(client)
      sockets.delete(backend)
    }
    client.on('error', close).on('close', close)
    backend.on('error', close).on('close', close)
    // Preserve Host, Origin and all application bytes; no auth/header rewriting.
    client.pipe(backend).pipe(client)
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  return {
    port: server.address().port,
    close: async () => {
      for (const socket of sockets) socket.destroy()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

export async function checkHealth(stateDir, proxyPort = 7778) {
  const runtime = readRuntime(stateDir)
  if (!runtime?.port || !runtime.node_id) throw new Error('daemon_not_running')
  // Exercise the published TCP path + daemon admission, not merely a live lock PID.
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/channel`, {
      headers: { Host: `127.0.0.1:${runtime.port}` },
      handshakeTimeout: 3000,
    })
    ws.once('error', reject)
    ws.once('open', () => {
      ws.terminate()
      resolve()
    })
    ws.once('close', () => reject(new Error('health_channel_closed')))
  })
}

async function main() {
  const state = process.env.ABELE_STATE_DIR ?? '/home/node/.local/state/abele-node'
  if (process.argv[2] === 'healthcheck') return checkHealth(state)
  if (process.argv[2] !== 'start') throw new Error('Usage: container.mjs start|healthcheck')
  const daemon = await startDaemon(state, 7777, '/workspaces', {
    ...(process.env.ABELE_CLAUDE_PATH ? { executable: process.env.ABELE_CLAUDE_PATH } : {}),
    profile: process.env.ABELE_CLAUDE_PROFILE ?? 'inherited',
    budgetUsd: Number(process.env.ABELE_CLAUDE_BUDGET ?? '0.35'),
    deadlineMs: Number(process.env.ABELE_CLAUDE_DEADLINE_MS ?? '120000'),
    permissionTtlMs: Number(process.env.ABELE_PERMISSION_TTL_MS ?? '60000'),
  })
  let proxy
  try {
    proxy = await createForwarder(daemon.port)
  } catch (error) {
    await daemon.stop()
    throw error
  }
  let stopping = false
  const stop = () => {
    if (stopping) return
    stopping = true
    void (async () => {
      await proxy.close()
      await daemon.stop()
    })().then(
      () => process.exit(0),
      (error) => {
        console.error(error)
        process.exit(1)
      }
    )
  }
  process.once('SIGTERM', stop)
  process.once('SIGINT', stop)
  console.log(JSON.stringify({ type: 'listening', port: daemon.port, node_id: daemon.node_id }))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
