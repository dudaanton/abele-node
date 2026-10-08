import { it, expect, vi } from 'vitest'
const suppressClose = vi.hoisted(() => ({ active: false }))
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>()
  return {
    ...real,
    spawn: (...args: Parameters<typeof real.spawn>) => {
      const child = (real.spawn as Function)(...args) as import('node:child_process').ChildProcess
      if (suppressClose.active && JSON.stringify(args[1]).includes('worker.js')) {
        const emit = child.emit.bind(child)
        child.emit = ((event: string, ...data: unknown[]) =>
          event === 'close' ? false : emit(event, ...data)) as typeof child.emit
      }
      return child
    },
  }
})
import { mkdtempSync, cpSync, chmodSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  ClaudeProviderAdapter,
  ProcessSupervisor,
  systemProcessProbe,
  type ProcessIdentity,
  type ProcessProbe,
} from '@abele/provider-claude'
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(f: () => boolean) {
  for (let i = 0; i < 500; i++) {
    if (f()) return
    await delay(20)
  }
  throw Error('stop test deadline')
}
async function launch(probe?: ProcessProbe) {
  const cwd = mkdtempSync(join(tmpdir(), 'abele-stop-')),
    executable = join(cwd, 'cli.mjs')
  cpSync(resolve('tests/fixtures/claude.mjs'), executable)
  chmodSync(executable, 0o700)
  const evidence: ProcessIdentity[] = []
  const adapter = new ClaudeProviderAdapter({ executable, processProbe: probe })
  const run = await adapter.startTurn(
    { session_id: 's', run_id: 'r', cwd, text: 'hang' },
    {
      event: () => {},
      processes: (p) => evidence.push(...p),
      permission: async () => ({ choice: 'deny', delivered() {} }),
    }
  )
  await until(() => existsSync(join(cwd, 'descendant.pid')))
  return {
    cwd,
    evidence,
    run,
    worker: evidence[0]!,
    child: Number(readFileSync(join(cwd, 'descendant.pid'), 'utf8')),
    cleanup: async () => {
      await ProcessSupervisor.cleanup(evidence)
      await run.done
      rmSync(cwd, { recursive: true, force: true })
    },
  }
}
it('SIGSTOP worker cannot prevent forced cleanup of its whole group or settlement of done', async () => {
  const s = await launch()
  try {
    process.kill(s.worker.pid, 'SIGSTOP')
    let error: unknown
    try {
      await s.run.interrupt()
    } catch (e) {
      error = e
    }
    expect(error).toBeUndefined()
    const outcome = await Promise.race([s.run.done, delay(500).then(() => undefined)])
    expect(outcome).toMatchObject({ reason: 'interrupted' })
    expect(systemProcessProbe.identity(s.worker.pid)).toBeUndefined()
    expect(systemProcessProbe.identity(s.child)).toBeUndefined()
  } finally {
    await s.cleanup()
  }
}, 20000)
it('settles done after supervisor cleanup even when the worker close event is never emitted', async () => {
  suppressClose.active = true
  const s = await launch()
  try {
    await s.run.interrupt()
    expect(await s.run.done).toHaveProperty('reason', 'interrupted')
    expect(systemProcessProbe.identity(s.child)).toBeUndefined()
  } finally {
    suppressClose.active = false
    await s.cleanup()
  }
})
it('repeated interrupt retries a failed cleanup instead of caching a rejected stopping promise', async () => {
  let unavailable = true,
    calls = 0
  const probe: ProcessProbe = {
    identity: (pid) => systemProcessProbe.identity(pid),
    groupMembers: (leader) => {
      calls++
      if (unavailable) throw Error('process_probe_unavailable')
      return systemProcessProbe.groupMembers(leader)
    },
  }
  const s = await launch(probe)
  try {
    process.kill(s.worker.pid, 'SIGSTOP')
    await expect(s.run.interrupt()).rejects.toThrow()
    const before = calls
    unavailable = false
    await s.run.interrupt()
    expect(calls).toBeGreaterThan(before)
    expect(systemProcessProbe.identity(s.child)).toBeUndefined()
    expect(await s.run.done).toHaveProperty('reason')
  } finally {
    unavailable = false
    await s.cleanup()
  }
}, 20000)
