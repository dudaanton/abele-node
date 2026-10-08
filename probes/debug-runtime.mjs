// B0-only POSIX process-group ownership. Shared by the real probe and fake-process regressions.
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

function groupStatus(pid, kill) {
  try {
    kill(-pid, 0)
    return 'present'
  } catch (error) {
    if (error.code === 'ESRCH') return 'gone'
    if (error.code === 'EPERM') return 'denied'
    throw error
  }
}
export async function stopGroup(
  child,
  {
    kill = process.kill.bind(process),
    pause = delay,
    now = () => performance.now(),
    graceMs = 1000,
  } = {}
) {
  if (!child.pid || groupStatus(child.pid, kill) === 'gone') return
  // A reaped leader can leave descendants in its group. Never gate this on exitCode.
  // Darwin can transiently report EPERM while a signalled group is being reaped.
  // Wait for ESRCH, but never turn a persistent permission error into success.
  let denied
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      kill(-child.pid, signal)
    } catch (error) {
      if (error.code === 'ESRCH') return
      if (error.code !== 'EPERM') throw error
      denied = error
    }
    const deadline = now() + graceMs
    let status
    while ((status = groupStatus(child.pid, kill)) !== 'gone' && now() < deadline) await pause(20)
    if (status === 'gone') break
    if (signal === 'SIGKILL') {
      throw (
        denied ??
        Object.assign(new Error(`probe group ${child.pid} did not stop`), {
          code: status === 'denied' ? 'EPERM' : 'group_cleanup_timeout',
        })
      )
    }
  }
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 1000)
    child.exited.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

export class ProbeRuntime {
  children = []
  sockets = []
  daps = []
  controller = new AbortController()
  stopping = undefined
  constructor() {
    this.handlers = new Map(
      ['SIGINT', 'SIGTERM'].map((signal) => {
        const handler = () => {
          process.exitCode = signal === 'SIGINT' ? 130 : 143
          if (!this.signal.aborted)
            this.controller.abort(new Error(`probe interrupted by ${signal}`))
          // Start cleanup immediately, independently of whichever request/wait the probe awaits.
          void this.stop().catch((error) => console.error('probe cleanup failed:', error))
        }
        process.on(signal, handler)
        return [signal, handler]
      })
    )
  }
  get signal() {
    return this.controller.signal
  }
  check() {
    if (this.signal.aborted) throw this.signal.reason
    if (this.stopping) throw new Error('probe runtime closed')
  }
  start(command, args, options = {}) {
    this.check()
    const child = spawn(command, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options,
      detached: true,
    })
    child.text = ''
    child.stdout.on('data', (bytes) => {
      child.text += bytes
    })
    child.stderr.on('data', (bytes) => {
      child.text += bytes
    })
    // Observe spawn errors immediately and retain a non-rejecting reaping promise for cleanup.
    child.exited = new Promise((resolve) => {
      child.once('exit', resolve)
      child.once('error', (error) => {
        child.text += error.message
        resolve()
      })
    })
    this.children.push(child)
    return child
  }
  trackSocket(socket) {
    this.check()
    // Destroying an interrupted connect must reject its once('connect') wait without an unhandled error.
    socket.on('error', () => {})
    this.sockets.push(socket)
    return socket
  }
  trackDap(dap) {
    this.check()
    this.daps.push(dap)
    return dap
  }
  async pause(ms) {
    this.check()
    try {
      await delay(ms, undefined, { signal: this.signal })
    } catch (error) {
      throw this.signal.aborted ? this.signal.reason : error
    }
  }
  stop() {
    if (!this.stopping)
      this.stopping = (async () => {
        const reason = this.signal.reason ?? new Error('probe stopping')
        const errors = []
        for (const dap of this.daps) {
          try {
            dap.close(reason)
          } catch (error) {
            errors.push(error)
          }
        }
        for (const socket of this.sockets) {
          try {
            socket.destroy(reason)
          } catch (error) {
            errors.push(error)
          }
        }
        // Stop every group concurrently, even when a different group cannot be stopped.
        const outcomes = await Promise.allSettled(this.children.map(stopGroup))
        for (const outcome of outcomes)
          if (outcome.status === 'rejected') errors.push(outcome.reason)
        for (const child of this.children) {
          child.stdin?.destroy()
          child.stdout?.destroy()
          child.stderr?.destroy()
        }
        if (errors.length) throw new AggregateError(errors, 'probe cleanup failed')
      })()
    return this.stopping
  }
  async finish(save = async () => {}) {
    const errors = []
    try {
      await this.stop()
    } catch (error) {
      errors.push(error)
    }
    // Evidence is best effort AFTER stopping, not a prerequisite for process cleanup.
    try {
      await save()
    } catch (error) {
      errors.push(error)
    } finally {
      for (const [signal, handler] of this.handlers) process.off(signal, handler)
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'probe cleanup/evidence failed')
  }
}
