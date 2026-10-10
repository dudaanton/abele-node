import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { ProcessSupervisor, descendants, systemProcessProbe } from '@abele/provider-claude'
import type { ProcessIdentity, ProcessProbe } from '@abele/provider-contract'

export const CODEX_PROCESS_MARKER = 'ABELE_CODEX_RUN_MARKER'
export const newProcessMarker = () => randomBytes(32).toString('hex')
export function validateProcessMarker(marker: string) {
  if (!/^[a-f0-9]{64}$/.test(marker)) throw new Error('codex_invalid_process_marker')
}
export function markerInEnvironment(value: Buffer | string, marker: string, platform: string) {
  validateProcessMarker(marker)
  const entry = `${CODEX_PROCESS_MARKER}=${marker}`
  return platform === 'linux'
    ? (Buffer.isBuffer(value) ? value.toString('utf8') : value).split('\0').includes(entry)
    : new RegExp(`(?:^|\\s)${entry}(?=\\s|$)`).test(String(value))
}
/** Inspect only this UID. Environment contents are neither returned nor journaled. */
export function markedProcesses(
  marker: string,
  probe: ProcessProbe = systemProcessProbe
): ProcessIdentity[] {
  validateProcessMarker(marker)
  const uid = process.getuid?.()
  if (uid === undefined) throw new Error('codex_process_inventory_unavailable')
  const found = new Map<number, ProcessIdentity>()
  const inspect = (pid: number, read: () => Buffer | string) => {
    const before = probe.identity(pid)
    if (!before) return
    const matches = markerInEnvironment(read(), marker, process.platform)
    const after = probe.identity(pid)
    if (matches && after) {
      if (before.fingerprint !== after.fingerprint) throw new Error('process_identity_changed')
      if (pid !== process.pid) found.set(pid, after)
    }
  }
  if (process.platform === 'linux') {
    for (const name of readdirSync('/proc')) {
      if (!/^\d+$/.test(name)) continue
      const pid = Number(name)
      if (pid < 2 || pid === process.pid) continue
      try {
        if (statSync(`/proc/${pid}`).uid !== uid) continue
        inspect(pid, () => readFileSync(`/proc/${pid}/environ`))
      } catch (error) {
        // Disappeared or protected processes provide no sweep evidence.
        if (
          !['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(
            (error as NodeJS.ErrnoException).code ?? ''
          )
        )
          throw error
      }
    }
  } else if (process.platform === 'darwin') {
    const list = spawnSync('/bin/ps', ['-axo', 'pid=,uid=,pgid=,lstart='], {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 1024 * 1024,
    })
    if (list.error || list.signal || list.status !== 0)
      throw new Error('codex_process_inventory_unavailable')
    const pids: number[] = [],
      before = new Map<number, ProcessIdentity>()
    for (const line of list.stdout.trim().split('\n')) {
      const match = /^\s*(\d+)\s+(-?\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
      if (!match) throw new Error('codex_process_inventory_unavailable')
      const pid = Number(match[1])
      if (Number(match[2]) === uid && pid > 1 && pid !== process.pid) {
        pids.push(pid)
        before.set(pid, { pid, group: Number(match[3]), fingerprint: match[4]! })
      }
    }
    for (let start = 0; start < pids.length; start += 64) {
      const batch = pids.slice(start, start + 64)
      const result = spawnSync(
        '/bin/ps',
        ['eww', '-p', batch.join(','), '-o', 'pid=', '-o', 'command='],
        { encoding: 'utf8', timeout: 2000, maxBuffer: 4 * 1024 * 1024 }
      )
      if (result.error || result.signal || ![0, 1].includes(result.status ?? -1))
        throw new Error('codex_process_inventory_unavailable')
      for (const line of result.stdout.split('\n')) {
        if (!line.trim()) continue
        const match = /^\s*(\d+)\s+([\s\S]*)$/.exec(line)
        if (!match || !batch.includes(Number(match[1])))
          throw new Error('codex_process_inventory_unavailable')
        // ps has already sampled the environment. Fence subsequent identity and signals.
        if (markerInEnvironment(match[2]!, marker, 'darwin')) {
          const current = probe.identity(Number(match[1]))
          if (current) {
            if (current.fingerprint !== before.get(current.pid)?.fingerprint)
              throw new Error('process_identity_changed')
            found.set(current.pid, current)
          }
        }
      }
    }
  } else throw new Error('codex_process_inventory_unavailable')
  return [...found.values()]
}

/** Same sampled descendant ownership as the shared supervisor, plus a marker sweep. */
export class CodexProcessInventory {
  private evidence = new Map<number, ProcessIdentity>()
  constructor(
    readonly marker: string,
    private persist: (p: ProcessIdentity[]) => void,
    private probe: ProcessProbe = systemProcessProbe,
    private sweep: (marker: string, probe: ProcessProbe) => ProcessIdentity[] = markedProcesses
  ) {
    validateProcessMarker(marker)
  }
  add(fresh: ProcessIdentity[]) {
    let changed = false
    for (const identity of fresh) {
      const previous = this.evidence.get(identity.pid)
      if (previous && previous.fingerprint !== identity.fingerprint)
        throw new Error('process_identity_changed')
      if (!previous || previous.group !== identity.group) changed = true
      this.evidence.set(identity.pid, identity)
    }
    if (changed) this.persist([...this.evidence.values()])
  }
  refresh() {
    for (const expected of this.evidence.values()) {
      const actual = this.probe.identity(expected.pid)
      if (!actual) continue
      if (actual.fingerprint !== expected.fingerprint) throw new Error('process_identity_changed')
      // A same-birth process can change its group by detaching; retain its new group.
      this.add([actual])
    }
  }
  sample(root: ProcessIdentity) {
    const actual = this.probe.identity(root.pid)
    if (!actual) return
    if (actual.fingerprint !== root.fingerprint) throw new Error('process_identity_changed')
    this.add([actual])
    if (this.probe === systemProcessProbe) this.add(descendants(root.pid))
    this.refresh()
  }
  async cleanup() {
    for (let pass = 0; pass < 3; pass++) {
      this.add(this.sweep(this.marker, this.probe))
      this.refresh()
      await ProcessSupervisor.cleanup([...this.evidence.values()], 100, this.probe)
      const remaining = this.sweep(this.marker, this.probe)
      if (!remaining.length) return
      this.add(remaining)
    }
    throw new Error('process_cleanup_unconfirmed')
  }
}
