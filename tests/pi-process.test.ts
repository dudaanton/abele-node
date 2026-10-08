import { it, expect } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PiProviderAdapter } from '@abele/provider-pi'
import { systemProcessProbe, type ProcessIdentity } from '@abele/provider-claude'
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
it('cancels the exact durable question signal before an extension proceeds to another question', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abele-pi-dialog-cancel-'))
  let cancelled: AbortSignal | undefined,
    fresh = false
  const adapter = new PiProviderAdapter({ stateDir: dir, deadlineMs: 10000, profile: 'isolated' })
  const run = await adapter.startTurn(
    { session_id: randomUUID(), run_id: randomUUID(), cwd: dir, text: 'cancelui' },
    {
      event: () => {},
      processes: () => {},
      permission: async () => ({ choice: 'deny', delivered: () => true }),
      question: async (action, signal) => {
        if (action.title === 'Cancelled dialog') {
          cancelled = signal
          return new Promise((resolve) =>
            signal.addEventListener(
              'abort',
              () => resolve({ choice: 'deny', delivered: () => false }),
              { once: true }
            )
          )
        }
        expect(cancelled?.aborted).toBe(true)
        fresh = true
        return { choice: 'allow', value: 'B', delivered: () => true }
      },
    }
  )
  try {
    expect(await run.done).toMatchObject({ result: { subtype: 'success' } })
    expect(fresh).toBe(true)
    expect(JSON.parse(readFileSync(join(dir, 'pi-cancel-ui.json'), 'utf8'))).toEqual({ value: 'B' })
  } finally {
    await run.interrupt()
    rmSync(dir, { recursive: true, force: true })
  }
})
it('cleans the supervised worker and tool descendants after interrupt; worker-local errors never expose credentials', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abele-pi-process-')),
    events: any[] = [],
    evidence: ProcessIdentity[] = []
  const adapter = new PiProviderAdapter({ stateDir: dir, deadlineMs: 10000, profile: 'isolated' })
  let run: Awaited<ReturnType<typeof adapter.startTurn>> | undefined
  const sink = {
    event: (e: any) => events.push(e),
    processes: (e: ProcessIdentity[]) => evidence.push(...e),
    permission: async () => ({ choice: 'allow' as const, delivered: () => true }),
  }
  try {
    run = await adapter.startTurn(
      { session_id: randomUUID(), run_id: randomUUID(), cwd: dir, text: 'descendants' },
      sink
    )
    const end = Date.now() + 5000
    while (!existsSync(join(dir, 'pi-child.pid')) && Date.now() < end) await delay(20)
    expect(existsSync(join(dir, 'pi-child.pid'))).toBe(true)
    const pid = Number(readFileSync(join(dir, 'pi-child.pid'), 'utf8'))
    expect(systemProcessProbe.identity(pid)).toBeTruthy()
    await run.interrupt()
    expect((await run.done).reason).toBeTruthy()
    expect(systemProcessProbe.identity(pid)).toBeUndefined()
    for (const p of evidence) expect(systemProcessProbe.identity(p.pid)).toBeUndefined()
    for (const text of ['error', 'badmap', 'unsupported', 'crash']) {
      run = await adapter.startTurn(
        { session_id: randomUUID(), run_id: randomUUID(), cwd: dir, text },
        sink
      )
      expect((await run.done).reason).toBeTruthy()
    }
    expect(events.map((e) => e.type)).toContain('pi.capability.error')
    expect(JSON.stringify(events)).not.toContain('FAKE_CREDENTIAL')
  } finally {
    await run?.interrupt()
    rmSync(dir, { recursive: true, force: true })
  }
})
