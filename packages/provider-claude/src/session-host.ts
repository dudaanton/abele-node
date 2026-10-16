// Holds one long-lived Claude process for a node session, independent of the node daemon.
// It runs in its own process group with no channel to the daemon that started it, so a node
// restart or update leaves it and its turn running. A daemon attaches over a token-checked
// socket, reads the output it has not acknowledged yet and writes input. Without a daemon it
// keeps the output (pausing the CLI when too much is waiting) and ends everything after a wait.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { chmodSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'
import { descendants, identity, ProcessSupervisor, type ProcessIdentity } from './supervisor.js'
import { cleanupRunIpc, HOST_PROTOCOL } from './ipc.js'

interface HostConfig {
  executable: string
  cwd: string
  args: string[]
  env?: { CLAUDE_CONFIG_DIR?: string }
  socket: string
  token: string
  ipc: string
  detachedMs: number
  bufferBytes: number
}
const CHUNK = 64 * 1024
let config: HostConfig
let child: ChildProcessWithoutNullStreams | undefined
const self = identity(process.pid)
let inventory: ProcessIdentity[] = self ? [self] : []
let childEvidence: ProcessIdentity | undefined
let timer: ReturnType<typeof setInterval> | undefined
let orphan: ReturnType<typeof setTimeout> | undefined
let stopping = false
let attached: Socket | undefined
// Output not acknowledged yet, by absolute byte offset since the CLI started.
let base = 0
let produced = 0
const chunks: Buffer[] = []
let buffered = 0
let paused = false
let exited: { code: number | null; signal: string | null } | undefined
// CLI requests that wait for an answer on stdin (permission questions), by request id.
const outstanding = new Map<string, string>()
let tail = ''

async function stop(code = 1) {
  if (stopping) return
  stopping = true
  if (timer) clearInterval(timer)
  if (orphan) clearTimeout(orphan)
  if (child?.pid && childEvidence) {
    try {
      const actual = identity(child.pid)
      if (actual?.fingerprint === childEvidence.fingerprint && actual.group === childEvidence.group)
        inventory = [...inventory, ...descendants(child.pid)]
    } catch {}
  }
  try {
    await ProcessSupervisor.cleanup(inventory)
    cleanupRunIpc(config.ipc)
  } catch {
    code = 1
  }
  process.exit(code)
}
const send = (message: unknown) => {
  if (attached && !attached.destroyed) attached.write(JSON.stringify(message) + '\n')
}
const flush = (from: number) => {
  let offset = base
  for (const chunk of chunks) {
    const end = offset + chunk.length
    if (end > from) {
      const start = Math.max(from, offset) - offset
      for (let at = start; at < chunk.length; at += CHUNK)
        send({
          kind: 'stdout',
          offset: offset + at,
          base64: chunk.subarray(at, Math.min(at + CHUNK, chunk.length)).toString('base64'),
        })
    }
    offset = end
  }
}
const acknowledge = (offset: number, settle = true) => {
  while (chunks.length && base + chunks[0]!.length <= offset) {
    base += chunks[0]!.length
    buffered -= chunks[0]!.length
    chunks.shift()
  }
  if (paused && buffered < config.bufferBytes / 2) {
    paused = false
    child?.stdout.resume()
  }
  if (settle && exited && base >= produced) void stop(0)
}
const detachedWait = () => {
  if (orphan) clearTimeout(orphan)
  orphan = setTimeout(() => void stop(), config.detachedMs)
}
// Only lines that may carry a pending CLI request are parsed.
const track = (data: Buffer) => {
  const text = tail + data.toString('utf8')
  const lines = text.split('\n')
  tail = lines.pop() ?? ''
  if (tail.length > 1024 * 1024) tail = ''
  for (const line of lines) {
    if (!line.includes('control_')) continue
    try {
      const r = JSON.parse(line)
      if (r?.type === 'control_request' && r.request?.subtype === 'can_use_tool')
        outstanding.set(String(r.request_id), line)
      else if (r?.type === 'control_cancel_request') outstanding.delete(String(r.request_id))
    } catch {}
  }
}
const accept = (socket: Socket) => {
  if (stopping) return void socket.destroy()
  let pending = Buffer.alloc(0),
    authenticated = false
  socket.on('error', () => {})
  socket.on('close', () => {
    if (attached !== socket) return
    attached = undefined
    detachedWait()
  })
  socket.on('data', (data) => {
    pending = Buffer.concat([pending, data])
    if (pending.length > 4 * 1024 * 1024) return void socket.destroy()
    let nl: number
    while ((nl = pending.indexOf(10)) >= 0) {
      const line = pending.subarray(0, nl)
      pending = pending.subarray(nl + 1)
      let m: any
      try {
        m = JSON.parse(line.toString('utf8'))
      } catch {
        return void socket.destroy()
      }
      if (!authenticated) {
        if (
          m?.kind !== 'attach' ||
          m.version !== HOST_PROTOCOL ||
          typeof m.token !== 'string' ||
          m.token.length !== config.token.length ||
          !timingSafeEqual(Buffer.from(m.token), Buffer.from(config.token)) ||
          !Number.isSafeInteger(m.offset) ||
          m.offset < base
        )
          return void socket.destroy()
        authenticated = true
        // One reader at a time: a new node replaces whatever was attached before.
        if (attached && attached !== socket) attached.destroy()
        attached = socket
        if (orphan) clearTimeout(orphan)
        orphan = undefined
        acknowledge(m.offset, false)
        send({
          kind: 'attached',
          version: HOST_PROTOCOL,
          inventory,
          child: childEvidence ?? null,
          pending: [...outstanding.values()],
        })
        flush(m.offset)
        if (exited) send({ kind: 'exit', ...exited, offset: produced })
        continue
      }
      if (attached !== socket) return void socket.destroy()
      if (m?.kind === 'write' && typeof m.line === 'string') {
        if (m.line.includes('control_response'))
          try {
            const r = JSON.parse(m.line)
            if (r?.type === 'control_response') outstanding.delete(String(r.response?.request_id))
          } catch {}
        if (child && !child.stdin.destroyed && !child.stdin.writableEnded)
          child.stdin.write(m.line + '\n')
      } else if (m?.kind === 'ack' && Number.isSafeInteger(m.offset)) acknowledge(m.offset)
      else if (m?.kind === 'close_input') child?.stdin.end()
      else if (m?.kind === 'stop') void stop()
    }
  })
}
function start() {
  const server = createServer(accept)
  server.on('error', () => void stop())
  server.listen(config.socket, () => {
    chmodSync(config.socket, 0o600)
    // Only the named configuration directory may differ from the daemon's environment.
    const directory = config.env?.CLAUDE_CONFIG_DIR
    child = spawn(config.executable, config.args, {
      cwd: config.cwd,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(directory ? { env: { ...process.env, CLAUDE_CONFIG_DIR: directory } } : {}),
    })
    child.stdin.on('error', () => {})
    child.once('error', () => {
      exited = { code: null, signal: null }
      announce({ kind: 'failed' })
      void stop()
    })
    child.once('spawn', () => {
      childEvidence = identity(child!.pid!)
      if (!childEvidence) {
        announce({ kind: 'failed' })
        return void stop()
      }
      inventory = self ? [self, childEvidence] : [childEvidence]
      announce({ kind: 'spawned', evidence: childEvidence })
      timer = setInterval(() => {
        try {
          const actual = identity(child!.pid!)
          if (
            actual &&
            (actual.fingerprint !== childEvidence!.fingerprint ||
              actual.group !== childEvidence!.group)
          )
            throw new Error('process_identity_changed')
          const map = new Map(inventory.map((p) => [p.pid, p]))
          for (const p of actual ? descendants(child!.pid!) : []) map.set(p.pid, p)
          inventory = [...map.values()]
          send({ kind: 'inventory', evidence: inventory })
        } catch {
          void stop()
        }
      }, 500)
    })
    child.stdout.on('data', (data: Buffer) => {
      track(data)
      chunks.push(data)
      buffered += data.length
      const offset = produced
      produced += data.length
      for (let at = 0; at < data.length; at += CHUNK)
        send({
          kind: 'stdout',
          offset: offset + at,
          base64: data.subarray(at, Math.min(at + CHUNK, data.length)).toString('base64'),
        })
      if (buffered > config.bufferBytes && !paused) {
        paused = true
        child!.stdout.pause()
      }
    })
    let stderrBytes = 0
    child.stderr.on('data', (data: Buffer) => {
      stderrBytes += data.length
      if (stderrBytes <= 65536) send({ kind: 'stderr', base64: data.toString('base64') })
    })
    child.once('close', (code, signal) => {
      exited = { code, signal }
      send({ kind: 'exit', code, signal, offset: produced })
      if (base >= produced && attached) void stop(0)
      else if (!attached) detachedWait()
    })
  })
  // Started without a reader: the daemon attaches right after it hears about the spawn.
  orphan = setTimeout(() => void stop(), Math.max(config.detachedMs, 30000))
}
// The daemon talks to a fresh host over its stdio once; both are closed after the spawn.
const announce = (message: unknown) => {
  try {
    process.stdout.write(JSON.stringify(message) + '\n')
    process.stdout.end()
  } catch {}
}
process.stdout.on('error', () => {})
process.on('SIGTERM', () => void stop())
process.on('SIGINT', () => void stop())
process.on('SIGHUP', () => {})
let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (data: string) => {
  input += data
  if (input.length > 1024 * 1024) process.exit(1)
})
process.stdin.on('end', () => {
  try {
    const raw = JSON.parse(input)
    if (
      typeof raw?.executable !== 'string' ||
      typeof raw.cwd !== 'string' ||
      !Array.isArray(raw.args) ||
      !raw.args.every((s: unknown) => typeof s === 'string') ||
      typeof raw.socket !== 'string' ||
      typeof raw.token !== 'string' ||
      typeof raw.ipc !== 'string' ||
      !Number.isSafeInteger(raw.detachedMs) ||
      !Number.isSafeInteger(raw.bufferBytes)
    )
      throw new Error('invalid_host_config')
    config = raw
  } catch {
    process.exit(1)
  }
  process.stdout.write(JSON.stringify({ kind: 'host', evidence: self ?? null }) + '\n')
  start()
})
