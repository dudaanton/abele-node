import { spawn, type ChildProcess } from 'node:child_process'
// This group leader cannot start Git until the node durably records its identity
// and opens the IPC gate. No model, shell, hook or client-supplied argv is involved.
let child: ChildProcess | undefined
let started = false
let killTimer: NodeJS.Timeout | undefined
process.on('disconnect', () => {
  if (!child) process.exit(0)
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM')
    killTimer = setTimeout(() => child?.kill('SIGKILL'), 100)
  }
})
process.on('message', (raw: unknown) => {
  const m = raw as {
    kind?: string
    executable?: string
    args?: string[]
    cwd?: string
    env?: Record<string, string>
  }
  if (started || m.kind !== 'start' || !m.executable || !m.cwd || !Array.isArray(m.args)) return
  started = true
  child = spawn(m.executable, m.args, {
    cwd: m.cwd,
    env: m.env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout!.pipe(process.stdout)
  child.stderr!.pipe(process.stderr)
  child.once('error', () => {
    process.exitCode = 1
  })
  child.once('close', (code) => {
    if (killTimer) clearTimeout(killTimer)
    process.exitCode = code === 0 ? 0 : 1
    if (process.connected) process.disconnect()
  })
})
process.send?.({ kind: 'ready' })
