import { it, expect } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { PiProviderAdapter } from '@abele/provider-pi'
import { ProcessSupervisor, systemProcessProbe, type ProcessIdentity } from '@abele/provider-claude'
import { waitForProcessGuarantee as until } from './process-wait.js'
const sink = {
  event: () => {},
  processes: () => {},
  permission: async () => ({ choice: 'allow' as const, delivered: () => true }),
}
it('reaps detached bash background children that outlive their fast-exiting shell before reporting success', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abele-pi-detached-'))
  const adapter = new PiProviderAdapter({ stateDir: dir, deadlineMs: 10000, profile: 'isolated' })
  let run: Awaited<ReturnType<typeof adapter.startTurn>> | undefined,
    child: ProcessIdentity | undefined
  try {
    run = await adapter.startTurn(
      { session_id: randomUUID(), run_id: randomUUID(), cwd: dir, text: 'detached' },
      sink
    )
    await until(() => existsSync(join(dir, 'pi-detached.pid')))
    const pid = Number(readFileSync(join(dir, 'pi-detached.pid'), 'utf8'))
    child = systemProcessProbe.identity(pid)
    expect(await run.done).toMatchObject({ result: { subtype: 'success' } })
    expect(systemProcessProbe.identity(pid)).toBeUndefined()
  } finally {
    await run?.interrupt()
    if (child) await ProcessSupervisor.cleanup([child], 50)
    rmSync(dir, { recursive: true, force: true })
  }
}, 60000)
it('worker cleans its own group on abrupt daemon death without waiting for daemon restart or another inventory poll', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abele-pi-parent-loss-'))
  let supervisor: ChildProcess | undefined,
    child: ProcessIdentity | undefined,
    evidence: ProcessIdentity[] = []
  try {
    supervisor = spawn(process.execPath, [resolve('tests/fixtures/pi-supervisor.mjs'), dir], {
      stdio: 'ignore',
    })
    await until(() => existsSync(join(dir, 'pi-child.pid')))
    const pid = Number(readFileSync(join(dir, 'pi-child.pid'), 'utf8'))
    child = systemProcessProbe.identity(pid)
    expect(child).toBeTruthy()
    evidence = JSON.parse(readFileSync(join(dir, 'processes.json'), 'utf8'))
    const exited = new Promise((r) => supervisor!.once('exit', r))
    supervisor.kill('SIGKILL')
    await exited
    await until(
      () => !systemProcessProbe.identity(evidence[0]!.pid) && !systemProcessProbe.identity(pid)
    )
  } finally {
    if (supervisor && supervisor.exitCode === null && supervisor.signalCode === null) {
      const exited = new Promise((r) => supervisor!.once('exit', r))
      supervisor.kill('SIGKILL')
      await exited
    }
    await ProcessSupervisor.cleanup([...evidence, ...(child ? [child] : [])], 50)
    rmSync(dir, { recursive: true, force: true })
  }
}, 60000)
