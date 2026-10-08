import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isAbsolute } from 'node:path'
import { ProcessSupervisor, systemProcessProbe, type ProcessIdentity } from '@abele/provider-claude'
import type { BashOperations } from '@earendil-works/pi-coding-agent'
import { ShellMessageSchema } from './shell-wire.js'
export interface HostProcessHooks {
  bashOperations(shellPath?: string): BashOperations
}
export interface GroupCallbacks {
  claim(identity: ProcessIdentity): Promise<void>
  reaped(identity: ProcessIdentity): Promise<void>
}
/** A command cannot run until the group's immutable proof is committed by the
 * daemon. The anchor outlives the shell, so cleanup never relies on PPID polling. */
export function managedBashOperations(
  callbacks: GroupCallbacks,
  stopSignal: AbortSignal,
  shell = '/bin/bash'
): BashOperations {
  if (!isAbsolute(shell)) throw new Error('invalid_pi_shell')
  return {
    exec: async (command, cwd, options) => {
      const signal = AbortSignal.any([stopSignal, ...(options.signal ? [options.signal] : [])])
      if (signal.aborted) throw new Error('aborted')
      if (
        options.timeout !== undefined &&
        (!Number.isFinite(options.timeout) || options.timeout <= 0 || options.timeout > 2147483)
      )
        throw new Error('invalid_pi_shell_timeout')
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL('./bash-worker.js', import.meta.url))],
        { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
      )
      let proof: ProcessIdentity | undefined,
        output = 0,
        timer: ReturnType<typeof setTimeout> | undefined,
        closed = false
      let rejectRun!: (error: Error) => void
      const abort = () => rejectRun(new Error('aborted'))
      try {
        return await new Promise<{ exitCode: number | null }>((resolve, reject) => {
          rejectRun = reject
          signal.addEventListener('abort', abort, { once: true })
          // Deadline for the empty anchor's ready/claim handshake; tool timeout
          // starts only after the durable claim admits shell execution.
          timer = setTimeout(() => reject(new Error('pi_shell_claim_deadline')), 5000)
          child.on('message', (raw) => {
            void (async () => {
              const m = ShellMessageSchema.parse(raw)
              if (m.kind === 'ready') {
                if (proof || m.evidence.pid !== child.pid || m.evidence.group !== child.pid)
                  throw Error('invalid_pi_shell_evidence')
                proof = m.evidence
                await callbacks.claim(proof)
                if (closed || signal.aborted) throw Error('aborted')
                clearTimeout(timer)
                timer =
                  options.timeout === undefined
                    ? undefined
                    : setTimeout(
                        () => reject(new Error('timeout:' + options.timeout)),
                        options.timeout * 1000
                      )
                if (!child.connected) throw Error('pi_shell_lost')
                child.send({ kind: 'execute', command, cwd, shell, env: options.env }, (error) => {
                  if (error) reject(new Error('pi_shell_lost'))
                })
              } else if (m.kind === 'output') {
                const data = Buffer.from(m.base64, 'base64')
                output += data.length
                if (output > 16 * 1024 * 1024) throw Error('pi_shell_output_limit')
                options.onData(data)
              } else if (m.kind === 'result') resolve({ exitCode: m.exit_code })
              else throw Error('pi_shell_failed')
            })().catch((error) =>
              reject(error instanceof Error ? error : new Error('pi_shell_failed'))
            )
          })
          child.once('error', () => reject(new Error('pi_shell_failed')))
          child.once('close', () => reject(new Error('pi_shell_lost')))
        })
      } finally {
        closed = true
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        // The ready message can be lost on cancellation; an unadmitted anchor
        // has run no command, but still must be reaped with immutable evidence.
        const observed = proof ?? (child.pid ? systemProcessProbe.identity(child.pid) : undefined)
        if (observed) {
          if (observed.pid !== child.pid || observed.group !== child.pid)
            throw Error('invalid_pi_shell_evidence')
          await ProcessSupervisor.cleanup([observed], 100)
          if (proof) await callbacks.reaped(proof)
        }
      }
    },
  }
}
