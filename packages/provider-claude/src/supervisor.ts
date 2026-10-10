import { spawnSync } from 'node:child_process'

import type { ProcessIdentity, ProcessProbe } from '@abele/provider-contract'
export type { ProcessIdentity, ProcessProbe } from '@abele/provider-contract'
function processState(pid: number): { identity: ProcessIdentity; zombie: boolean } | undefined {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('process_probe_unavailable')
  const r = spawnSync(
    '/bin/ps',
    ['-p', String(pid), '-o', 'pgid=', '-o', 'stat=', '-o', 'lstart='],
    {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 65536,
    }
  )
  if (r.error || r.signal) throw new Error('process_probe_unavailable')
  const match = r.stdout?.trim().match(/^(\d+)\s+([RSDTtZXIWU]\S*)\s+(.+)$/)
  if (r.status === 0 && match)
    return {
      identity: { pid, group: Number(match[1]), fingerprint: match[3]! },
      zombie: match[2]!.startsWith('Z'),
    }
  // Darwin can exit 0 with no row when a process disappears during ps.
  // Empty output alone is ambiguous: only kernel ESRCH confirms absence.
  if ((r.status === 0 || r.status === 1) && !r.stdout?.trim()) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    }
  }
  throw new Error('process_probe_unavailable')
}
export function identity(pid: number): ProcessIdentity | undefined {
  const observed = processState(pid)
  // A zombie cannot execute/fork and needs its parent's waitpid, not a signal.
  // Darwin kill(-pgid) returns EPERM for a zombie-only group even for our UID.
  return observed?.zombie ? undefined : observed?.identity
}
function inventory(format: string): number[][] {
  const r = spawnSync('/bin/ps', ['-axo', format], {
    encoding: 'utf8',
    timeout: 2000,
    maxBuffer: 1024 * 1024,
  })
  if (r.error || r.signal || r.status !== 0 || !r.stdout?.trim())
    throw new Error('process_inventory_unavailable')
  const rows = r.stdout
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
  if (rows.some((row) => row.length !== 2 || row.some((n) => !Number.isSafeInteger(n) || n < 0)))
    throw new Error('process_inventory_unavailable')
  return rows
}
export function descendants(root: number): ProcessIdentity[] {
  const rows = inventory('pid=,ppid='),
    found = new Set([root])
  for (let pass = 0; pass < rows.length; pass++) {
    const before = found.size
    for (const [pid, parent] of rows) if (pid && parent && found.has(parent)) found.add(pid)
    if (before === found.size) break
  }
  return [...found].map(identity).filter((p): p is ProcessIdentity => !!p)
}
export function groupMembers(leader: ProcessIdentity): ProcessIdentity[] {
  // Even a zombie leader must fence group reuse by its immutable identity.
  // Ignore its non-executing state only when listing members, not this check.
  const actual = processState(leader.pid)?.identity
  if (actual && (actual.fingerprint !== leader.fingerprint || actual.group !== leader.group))
    throw new Error('process_identity_changed')
  return inventory('pid=,pgid=')
    .filter(([, group]) => group === leader.group)
    .map(([pid]) => identity(pid!))
    .filter((p): p is ProcessIdentity => !!p)
}
export const systemProcessProbe: ProcessProbe = { identity, groupMembers }
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
export class ProcessSupervisor {
  /** Immutable start/group evidence fences signals; failed probes never prove cleanup. */
  static async cleanup(
    evidence: ProcessIdentity[],
    grace = 500,
    probe: ProcessProbe = systemProcessProbe
  ): Promise<void> {
    const leaders = evidence.filter((p) => p.pid === p.group),
      collected = new Map(evidence.map((p) => [p.pid, p]))
    // Retry unavailable probes, never changed identities or signal failures.
    const retryProbe = async <T>(read: () => T): Promise<T> => {
      const deadline = Date.now() + 3000
      let backoff = 25
      for (;;) {
        try {
          return read()
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !['process_probe_unavailable', 'process_inventory_unavailable'].includes(
              error.message
            ) ||
            Date.now() >= deadline
          )
            throw error
          await delay(backoff)
          backoff = Math.min(backoff * 2, 250)
        }
      }
    }
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      for (const leader of leaders)
        for (const member of await retryProbe(() => probe.groupMembers(leader)))
          collected.set(member.pid, member)
      evidence = [...collected.values()]
      const signalledGroups = new Set<number>()
      for (const expected of [...evidence].reverse()) {
        if (expected.pid === process.pid) continue
        const actual = await retryProbe(() => probe.identity(expected.pid))
        if (!actual) continue
        if (actual.fingerprint !== expected.fingerprint || actual.group !== expected.group)
          throw new Error('process_identity_changed')
        const leader =
          actual.group !== process.pid ? leaders.find((p) => p.pid === actual.group) : undefined
        try {
          if (leader) {
            if (!signalledGroups.has(actual.group)) {
              process.kill(-actual.group, signal)
              signalledGroups.add(actual.group)
            }
          } else process.kill(actual.pid, signal)
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code
          if (code === 'ESRCH') continue
          // A live target can become a zombie after the pre-signal snapshot.
          // EPERM alone proves nothing: recheck the entire fenced group (or
          // individual PID). Live members, changed identities and failed probes
          // must still fail cleanup; final verification below remains required.
          if (
            code === 'EPERM' &&
            (await retryProbe(() =>
              leader ? probe.groupMembers(leader).length === 0 : !probe.identity(actual.pid)
            ))
          )
            continue
          throw error
        }
      }
      await delay(grace)
    }
    // SIGKILL delivery is asynchronous: positively confirm the entire fenced group.
    const deadline = Date.now() + 5000
    let backoff = 25
    for (;;) {
      const live = await retryProbe(() => {
        for (const leader of leaders)
          for (const member of probe.groupMembers(leader)) collected.set(member.pid, member)
        return [...collected.values()].some((expected) => {
          if (expected.pid === process.pid) return false
          const actual = probe.identity(expected.pid)
          return actual && actual.fingerprint === expected.fingerprint
        })
      })
      if (!live) return
      if (Date.now() >= deadline) throw new Error('process_cleanup_unconfirmed')
      await delay(backoff)
      backoff = Math.min(backoff * 2, 250)
    }
  }
}
