import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { isAbsolute } from 'node:path'

export type ProcessEvidence = {
  pid: number
  ownership_id: string
  start_identity: string
  executable_sha256: string
}
/** Processes the debugger started and still holds: its adapters and the programs it runs. Not
 * offered for attaching, as they are already under it. */
export const ownedDebugPids = new Set<number>()
export interface DebugProcessOwner {
  readonly evidence: ProcessEvidence
  terminate(): Promise<void>
}

/** OS start identity, independent of adapter claims. No shell and no user-supplied
 * executable for this query. PID alone is not ownership or proof of liveness. */
export async function processStartIdentity(pid: number): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('invalid_pid')
  if (process.platform === 'linux') {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const start = fields[19]
    if (!start || !/^\d+$/.test(start)) throw new Error('process_identity_unavailable')
    const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    return `linux:${boot}:${start}`
  }
  if (process.platform === 'darwin') {
    return new Promise((resolve, reject) =>
      execFile(
        '/bin/ps',
        ['-p', String(pid), '-o', 'lstart='],
        { timeout: 1000, maxBuffer: 4096, env: { LC_ALL: 'C' } },
        (error, stdout) => {
          const start = stdout.trim()
          if (error || !start) reject(new Error('process_identity_unavailable'))
          else resolve(`darwin:${start}`)
        }
      )
    )
  }
  throw new Error('unsupported_debugger_host')
}

/** Owns only a process directly spawned by the node. Never adopts adapter-reported
 * PIDs, never kills an attached process, and never signals an unproven process group.
 * Child exit state + OS start identity fence each signal; no promise of OS sandboxing. */
export class OwnedDebugProcess extends EventEmitter implements DebugProcessOwner {
  readonly evidence: ProcessEvidence
  private text = ''
  private constructor(
    private readonly child: ChildProcess,
    evidence: ProcessEvidence,
    private readonly identity: (pid: number) => Promise<string>
  ) {
    super()
    this.evidence = evidence
    for (const stream of [child.stdout, child.stderr])
      stream?.on('data', (chunk: Buffer) => {
        // A rolling, private startup preview, never raw traffic in persisted history.
        this.text = (this.text + chunk.toString('utf8')).slice(-16384)
        this.emit('text')
      })
    ownedDebugPids.add(evidence.pid)
    child.on('exit', () => {
      ownedDebugPids.delete(evidence.pid)
      this.emit('exit')
    })
    child.on('error', () => this.emit('exit'))
  }
  static async spawn(
    executable: string,
    argv: string[],
    options: { cwd?: string; env?: Record<string, string> },
    identity = processStartIdentity
  ): Promise<OwnedDebugProcess> {
    if (
      !isAbsolute(executable) ||
      argv.length > 256 ||
      argv.some((v) => typeof v !== 'string' || v.includes('\0') || Buffer.byteLength(v) > 8192)
    )
      throw new Error('invalid_debugger_argv')
    const path = await realpath(executable)
    const hash = createHash('sha256')
      .update(await readFile(path))
      .digest('hex')
    const child = spawn(path, argv, {
      cwd: options.cwd,
      env: options.env ?? {},
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    // Retain an error listener for the whole lifetime, including early cleanup.
    child.on('error', () => {})
    await new Promise<void>((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    try {
      const start = await identity(child.pid!)
      return new OwnedDebugProcess(
        child,
        {
          pid: child.pid!,
          ownership_id: randomUUID(),
          start_identity: start,
          executable_sha256: hash,
        },
        identity
      )
    } catch (error) {
      // Startup has not handed ownership out. An exited/reaped child is never
      // signalled. A live, unreaped direct child cannot have its PID reused yet.
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      await new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) resolve()
        else child.once('exit', () => resolve())
      })
      throw error
    }
  }
  get pid() {
    return this.evidence.pid
  }
  get alive() {
    return this.child.exitCode === null && this.child.signalCode === null
  }
  waitForText(pattern: RegExp, timeoutMs = 10000, signal?: AbortSignal): Promise<RegExpExecArray> {
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, match?: RegExpExecArray) => {
        clearTimeout(timer)
        this.off('text', check)
        this.off('exit', check)
        signal?.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve(match!)
      }
      const check = () => {
        const match = pattern.exec(this.text)
        if (match) finish(undefined, match)
        else if (!this.alive) finish(new Error('debugger_process_exited'))
      }
      const abort = () => finish(new Error('debugger_cancelled'))
      const timer = setTimeout(() => finish(new Error('debugger_start_timeout')), timeoutMs)
      this.on('text', check)
      this.on('exit', check)
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
      else check()
    })
  }
  waitForExit(timeoutMs = 2000): Promise<void> {
    if (!this.alive) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const exit = () => {
        clearTimeout(timer)
        resolve()
      }
      const timer = setTimeout(() => {
        this.off('exit', exit)
        reject(new Error('debugger_exit_timeout'))
      }, timeoutMs)
      this.once('exit', exit)
    })
  }
  private async signal(signal: NodeJS.Signals) {
    if (!this.alive) return
    let current: string
    try {
      current = await this.identity(this.pid)
    } catch (error) {
      // A program that ended by itself is gone from the OS a moment before its exit arrives here.
      await this.waitForExit(1000).catch(() => {})
      if (!this.alive) return
      throw error
    }
    // Check again after the asynchronous OS query, before issuing a signal.
    if (!this.alive) return
    if (current !== this.evidence.start_identity) throw new Error('pid_reused')
    if (!this.child.kill(signal)) throw new Error('debugger_signal_failed')
  }
  release() {
    // Let go, it is a program of its own again: one that may be attached to later.
    ownedDebugPids.delete(this.pid)
    this.child.unref()
    // Continue draining bounded private startup output while the host is alive,
    // but an explicitly detached target must not keep the node event loop alive.
    for (const stream of [this.child.stdout, this.child.stderr]) {
      const handle = stream as typeof stream & { unref?: () => void }
      handle?.unref?.()
    }
  }
  async terminate() {
    if (!this.alive) return
    await this.signal('SIGTERM')
    try {
      await this.waitForExit(1000)
    } catch {
      await this.signal('SIGKILL')
      await this.waitForExit(1000)
    }
    if (this.alive) throw new Error('debugger_exit_unproven')
  }
}
