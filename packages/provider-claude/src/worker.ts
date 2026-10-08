// The worker survives daemon loss long enough to terminate its independent Claude process group.
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { descendants, identity, ProcessSupervisor, type ProcessIdentity } from './supervisor.js'
import { cleanupRunIpc } from './ipc.js'
import { dirname } from 'node:path'
let child: ChildProcessWithoutNullStreams | undefined
const self = identity(process.pid)
let inventory: ProcessIdentity[] = self ? [self] : []
let timer: ReturnType<typeof setInterval> | undefined
let stopping = false
let ipcDirectory: string | undefined
const send = (message: unknown) => {
  if (process.connected) process.send?.(message)
}
async function stop(code = 1) {
  if (stopping) return
  stopping = true
  if (timer) clearInterval(timer)
  if (child?.pid) {
    try {
      const expected = inventory.find((p) => p.pid === child!.pid)
      const actual = identity(child.pid)
      if (
        expected &&
        actual?.fingerprint === expected.fingerprint &&
        actual.group === expected.group
      )
        inventory = [...inventory, ...descendants(child.pid)]
    } catch {}
  }
  try {
    await ProcessSupervisor.cleanup(inventory)
    if (ipcDirectory) cleanupRunIpc(ipcDirectory)
  } catch {
    code = 1
  }
  process.exit(code)
}
process.on('disconnect', () => {
  void stop()
})
process.on('SIGTERM', () => {
  void stop()
})
process.on('SIGINT', () => {
  void stop()
})
process.on('message', (raw: any) => {
  if (
    raw?.kind === 'start' &&
    !child &&
    typeof raw.executable === 'string' &&
    typeof raw.cwd === 'string' &&
    Array.isArray(raw.args) &&
    raw.args.every((s: unknown) => typeof s === 'string')
  ) {
    const configIndex = raw.args.indexOf('--mcp-config')
    if (configIndex >= 0) ipcDirectory = dirname(raw.args[configIndex + 1])
    child = spawn(raw.executable, raw.args, {
      cwd: raw.cwd,
      detached: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    child.once('error', () => {
      send({ kind: 'exit', code: null, reason: 'spawn_failed' })
      void stop()
    })
    child.once('spawn', () => {
      const evidence = identity(child!.pid!)
      if (!evidence) {
        void stop()
        return
      }
      inventory = self ? [self, evidence] : [evidence]
      send({ kind: 'spawned', evidence })
      timer = setInterval(() => {
        try {
          const expected = inventory.find((p) => p.pid === child!.pid)
          const actual = identity(child!.pid!)
          if (
            actual &&
            expected &&
            (actual.fingerprint !== expected.fingerprint || actual.group !== expected.group)
          )
            throw new Error('process_identity_changed')
          const fresh = actual ? descendants(child!.pid!) : []
          const map = new Map(inventory.map((p) => [p.pid, p]))
          for (const p of fresh) map.set(p.pid, p)
          inventory = [...map.values()]
          send({ kind: 'inventory', evidence: inventory })
        } catch {
          void stop()
        }
      }, 500)
    })
    child.stdout.on('data', (data: Buffer) => {
      child!.stdout.pause()
      send({ kind: 'stdout', base64: data.toString('base64') })
    })
    let stderrBytes = 0
    child.stderr.on('data', (data: Buffer) => {
      stderrBytes += data.length
      if (stderrBytes <= 65536) send({ kind: 'stderr', base64: data.toString('base64') })
    })
    child.once('close', (code, signal) => {
      send({ kind: 'exit', code, signal })
      void stop(0)
    })
  } else if (raw?.kind === 'deliver' && child && typeof raw.text === 'string') {
    // Single input only; EOF makes this one invocation, never an interactive queue.
    child.stdin.end(raw.text)
  } else if (raw?.kind === 'output_ack') child?.stdout.resume()
  else if (raw?.kind === 'stop') void stop()
})
send({ kind: 'ready', evidence: identity(process.pid) })
