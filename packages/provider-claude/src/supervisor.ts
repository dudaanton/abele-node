import { spawnSync } from 'node:child_process'

export interface ProcessIdentity {
  pid: number
  fingerprint: string
  group: number
}
/** Undefined means positively gone. An unavailable inventory/probe must throw. */
export interface ProcessProbe {
  identity(pid: number): ProcessIdentity | undefined
  groupMembers(leader: ProcessIdentity): ProcessIdentity[]
}
export function identity(pid: number): ProcessIdentity | undefined {
  if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('process_probe_unavailable')
  const r = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'pgid=', '-o', 'lstart='], {
    encoding: 'utf8',
    timeout: 2000,
    maxBuffer: 65536,
  })
  if (r.error || r.signal) throw new Error('process_probe_unavailable')
  const match = r.stdout?.trim().match(/^(\d+)\s+(.+)$/)
  if (r.status === 0 && match) return { pid, group: Number(match[1]), fingerprint: match[2]! }
  // ps exit 1/empty is ambiguous. Only ESRCH from the kernel confirms absence.
  if (r.status === 1 && !r.stdout?.trim()) {
    try {
      process.kill(pid, 0)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return
    }
  }
  throw new Error('process_probe_unavailable')
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
  const actual = identity(leader.pid)
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
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      for (const leader of leaders)
        for (const member of probe.groupMembers(leader)) collected.set(member.pid, member)
      evidence = [...collected.values()]
      const signalledGroups = new Set<number>()
      for (const expected of [...evidence].reverse()) {
        if (expected.pid === process.pid) continue
        const actual = probe.identity(expected.pid)
        if (!actual) continue
        if (actual.fingerprint !== expected.fingerprint || actual.group !== expected.group)
          throw new Error('process_identity_changed')
        try {
          if (actual.group !== process.pid && leaders.some((p) => p.pid === actual.group)) {
            if (!signalledGroups.has(actual.group)) {
              process.kill(-actual.group, signal)
              signalledGroups.add(actual.group)
            }
          } else process.kill(actual.pid, signal)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      await delay(grace)
    }
    for (const leader of leaders)
      for (const member of probe.groupMembers(leader)) collected.set(member.pid, member)
    for (const expected of collected.values()) {
      if (expected.pid === process.pid) continue
      const actual = probe.identity(expected.pid)
      if (actual && actual.fingerprint === expected.fingerprint)
        throw new Error('process_cleanup_unconfirmed')
    }
  }
}
