import { it, expect } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { ProcessSupervisor, systemProcessProbe, type ProcessIdentity } from '@abele/provider-claude'
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean) {
  const end = Date.now() + 8000
  while (Date.now() < end) {
    if (fn()) return
    await delay(20)
  }
  throw Error('anchor loss fixture deadline')
}
it.each(['daemon', 'worker'])(
  'cleans a separate bash-anchor group after abrupt %s loss without supervisor recovery',
  async (target) => {
    const dir = mkdtempSync(join(tmpdir(), 'abele-pi-anchor-loss-'))
    let supervisor: ChildProcess | undefined,
      proofs: ProcessIdentity[] = []
    try {
      supervisor = spawn(
        process.execPath,
        [resolve('tests/fixtures/pi-supervisor.mjs'), dir, 'anchored-descendants'],
        { stdio: 'ignore' }
      )
      await until(() => existsSync(join(dir, 'pi-anchored-child.pid')))
      const pid = Number(readFileSync(join(dir, 'pi-anchored-child.pid'), 'utf8'))
      proofs = JSON.parse(readFileSync(join(dir, 'processes.json'), 'utf8'))
      const worker = proofs[0]!,
        child = systemProcessProbe.identity(pid)!,
        anchor = proofs.find((p) => p.pid === child.group)!
      expect(child).toBeTruthy()
      expect(anchor).toBeTruthy()
      expect(child.group).not.toBe(worker.group)
      expect(anchor.pid).toBe(anchor.group)
      proofs.push(child)
      if (target === 'daemon') {
        const exited = new Promise((r) => supervisor!.once('exit', r))
        supervisor.kill('SIGKILL')
        await exited
        await until(() => !systemProcessProbe.identity(worker.pid))
      } else {
        // Freeze the daemon first so its own adapter cleanup cannot rescue the
        // anchor. Then abruptly kill the SDK worker: anchor IPC-loss handling
        // must independently reap the shell and background child.
        supervisor.kill('SIGSTOP')
        process.kill(worker.pid, 'SIGKILL')
        expect(systemProcessProbe.identity(supervisor.pid!)).toBeTruthy()
      }
      await until(() => !systemProcessProbe.identity(anchor.pid))
      expect(systemProcessProbe.identity(pid)).toBeUndefined()
    } finally {
      if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
        const exited = new Promise((r) => supervisor!.once('exit', r))
        supervisor.kill('SIGKILL')
        await exited
      }
      await ProcessSupervisor.cleanup(proofs, 100)
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
