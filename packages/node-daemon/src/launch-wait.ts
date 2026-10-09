import { performance } from 'node:perf_hooks'
import { setTimeout } from 'node:timers/promises'
import { spawnSync } from 'node:child_process'

// A lock survives crashes and reboots; a live PID alone does not establish ownership.
export function daemonProcessPresent(pid: number, entry: string, state: string): boolean {
  if (processAbsent(pid)) return false
  const result = spawnSync('/bin/ps', ['-o', 'command=', '-p', String(pid)], {
    encoding: 'utf8',
    timeout: 1000,
  })
  if (result.status === 0 && result.stdout.trim()) {
    const command = result.stdout.trim()
    const invocation = ` ${entry} start --state-dir ${state}`
    const index = command.indexOf(invocation)
    return (
      index >= 0 &&
      (command.length === index + invocation.length || command[index + invocation.length] === ' ')
    )
  }
  if (processAbsent(pid)) return false
  throw new Error('daemon_process_ownership_unconfirmed')
}

export function processAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH'
  }
}

export async function waitForLaunch(
  confirmed: () => boolean,
  failure: () => string,
  timeoutMs = 20_000
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  let delay = 50
  for (;;) {
    if (confirmed()) return
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw new Error(failure())
    await setTimeout(Math.min(delay, remaining))
    delay = Math.min(delay * 2, 500)
  }
}
