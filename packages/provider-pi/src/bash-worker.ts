// An owned, detached group anchor. The shell is NOT detached from this group.
// Remain alive after its exit so orphaned background jobs remain discoverable
// by PGID, even when their shell lived less than one inventory polling interval.
import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import { systemProcessProbe, ProcessSupervisor } from '@abele/provider-claude'
import { ShellStartSchema } from './shell-wire.js'
process.umask(0o077)
const identity = systemProcessProbe.identity(process.pid)
if (!identity || identity.group !== process.pid) process.exit(1)
let started = false,
  stopping = false,
  bytes = 0
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const send = (message: any) => {
  if (!process.connected) {
    void stop()
    return
  }
  process.send!(message, (error) => {
    if (error) void stop()
  })
}
async function stop() {
  if (stopping) return
  stopping = true
  for (;;) {
    try {
      await ProcessSupervisor.cleanup([identity!], 100)
      break
    } catch {
      await delay(1000)
    } // do not abandon the group on an unconfirmed probe
  }
  process.exit(1)
}
process.once('disconnect', () => {
  void stop()
})
process.once('SIGTERM', () => {
  void stop()
})
process.once('SIGINT', () => {
  void stop()
})
process.on('message', (raw) => {
  try {
    const m = ShellStartSchema.parse(raw)
    if (started || stopping) throw Error('invalid_shell_start')
    started = true
    const child = spawn(m.shell, ['-c', m.command], {
      cwd: m.cwd,
      env: m.env,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let accepting = true
    const onData = (chunk: Buffer) => {
      if (!accepting || stopping) return
      bytes += chunk.length
      if (bytes > 16 * 1024 * 1024) {
        send({ kind: 'error' })
        void stop()
        return
      }
      send({ kind: 'output', base64: chunk.toString('base64') })
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.once('error', () => {
      send({ kind: 'error' })
      void stop()
    })
    child.once('exit', (code, signal) => {
      // Drain queued pipe output briefly, but never await a close event held by
      // background children. The parent reaps this whole anchored group next.
      setTimeout(() => {
        accepting = false
        child.stdout.destroy()
        child.stderr.destroy()
        send({
          kind: 'result',
          exit_code: code ?? (signal ? 128 + (constants.signals[signal] ?? 0) : 1),
        })
      }, 20)
    })
  } catch {
    send({ kind: 'error' })
    void stop()
  }
})
send({ kind: 'ready', evidence: identity })
