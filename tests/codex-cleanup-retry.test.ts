import { expect } from 'vitest'
import { processIt as it } from './process-test.js'
import { waitForProcessCondition, withProcessDeadline } from '../scripts/process-test-budget.mjs'
import { VirtualDeadlineTimers } from './deadline-timers.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { systemProcessProbe } from '@abele/provider-claude'
import { startCodexTurn } from '../packages/provider-codex/src/worker.js'
import { discoverCodex } from '../packages/provider-codex/src/discovery.js'

it('bounds automatic retry attempts, keeps the deadline and ownership, then permits explicit recovery', async () => {
  const state = mkdtempSync(resolve('.scratch/codex-cleanup-bounded-')),
    home = join(state, 'home'),
    workspace = join(state, 'workspace')
  mkdirSync(home)
  mkdirSync(workspace)
  // Keep cold I/O slow while the retry/deadline budget advances only by test intent.
  writeFileSync(
    join(home, 'fixture.json'),
    JSON.stringify({ mode: 'normal', initialize_delay_ms: 1000 })
  )
  const timers = new VirtualDeadlineTimers()
  const events: any[] = [],
    evidence: any[] = []
  const failures = () => events.filter((e) => e.type === 'codex.cleanup.failed')
  let fault = false,
    settled = false,
    run: Awaited<ReturnType<typeof startCodexTurn>> | undefined
  try {
    run = await startCodexTurn(
      {
        executable: discoverCodex({
          executable: resolve('tests/fixtures/codex.mjs'),
          fixture: true,
        }),
        paths: { state, home, workspace, sibling: state },
        model: 'fixture-small',
        deadlineMs: 3500,
        timers,
        turn: { run_id: randomUUID(), session_id: randomUUID(), cwd: workspace, text: 'fixture' },
        probe: {
          identity: (pid) => systemProcessProbe.identity(pid),
          groupMembers: (leader) => {
            if (fault) throw new Error('injected_cleanup_failure')
            return systemProcessProbe.groupMembers(leader)
          },
        },
      },
      {
        processes: (p) => evidence.push(...p),
        permission: async () => ({ choice: 'deny', delivered: () => true }),
        event: (e) => {
          events.push(e)
          if (e.type === 'codex.turn.completed') fault = true
        },
      }
    )
    void run.done.then(() => {
      settled = true
    })
    const until = async (count: number) => {
      await waitForProcessCondition(() => failures().length >= count, `cleanup attempt ${count}`)
      expect(failures()).toHaveLength(count)
      expect(settled).toBe(false)
      expect(events.some((e) => e.type === 'codex.worker.exit')).toBe(false)
    }
    await until(1)
    for (const [i, delay] of [100, 250, 500].entries()) {
      timers.advance(delay - 1)
      expect(failures()).toHaveLength(i + 1)
      timers.advance(1)
      await until(i + 2)
    }
    expect(failures().map((e) => e.data.attempt)).toEqual([1, 2, 3, 4])
    expect(failures().map((e) => e.data.retrying)).toEqual([true, true, true, false])
    expect(failures().map((e) => e.data.retry_in_ms)).toEqual([100, 250, 500, undefined])
    expect(timers.pending).toBe(1) // Only the original deadline survives retry exhaustion.
    timers.advance(3500 - timers.now - 1)
    expect(failures()).toHaveLength(4)
    expect(settled).toBe(false)
    timers.advance(1)
    await until(5)
    expect(failures().at(-1).data).toMatchObject({ attempt: 5, retrying: false })
    expect(timers.pending).toBe(0)
    expect(systemProcessProbe.identity(evidence[0].pid)).toBeTruthy()
    fault = false
    await run.interrupt()
    expect(await run.done).toMatchObject({ reason: 'deadline', result: { subtype: 'success' } })
    expect(
      events.filter((e) => e.type === 'codex.worker.exit' && e.data.cleanup_confirmed)
    ).toHaveLength(1)
    expect(systemProcessProbe.identity(evidence[0].pid)).toBeUndefined()
    expect(timers.pending).toBe(0)
  } finally {
    fault = false
    await run?.interrupt()
    rmSync(state, { recursive: true, force: true })
  }
})
it('automatically retries transient terminal cleanup, reports the session error and resolves done only after confirmation', async () => {
  const state = mkdtempSync(resolve('.scratch/codex-cleanup-retry-')),
    home = join(state, 'home'),
    workspace = join(state, 'workspace')
  mkdirSync(home)
  mkdirSync(workspace)
  const timers = new VirtualDeadlineTimers()
  const events: any[] = []
  let failures = 0,
    terminal = false,
    settled = false,
    run: Awaited<ReturnType<typeof startCodexTurn>> | undefined
  try {
    run = await startCodexTurn(
      {
        executable: discoverCodex({
          executable: resolve('tests/fixtures/codex.mjs'),
          fixture: true,
        }),
        paths: { state, home, workspace, sibling: state },
        model: 'fixture-small',
        deadlineMs: 5000,
        timers,
        turn: { run_id: randomUUID(), session_id: randomUUID(), cwd: workspace, text: 'fixture' },
        probe: {
          identity: (pid) => systemProcessProbe.identity(pid),
          groupMembers: (leader) => {
            if (terminal && failures++ === 0) throw new Error('injected_cleanup_failure')
            return systemProcessProbe.groupMembers(leader)
          },
        },
      },
      {
        processes: () => {},
        permission: async () => ({ choice: 'deny', delivered: () => true }),
        event: (e) => {
          events.push(e)
          if (e.type === 'codex.turn.completed') terminal = true
        },
      }
    )
    void run.done.then(() => {
      settled = true
    })
    await waitForProcessCondition(
      () => events.some((e) => e.type === 'codex.cleanup.failed'),
      'transient cleanup failure'
    )
    expect(settled).toBe(false)
    expect(events.some((e) => e.type === 'codex.worker.exit')).toBe(false)
    timers.advance(99)
    expect(settled).toBe(false)
    timers.advance(1)
    const result = await withProcessDeadline(() => run!.done, 'automatic cleanup confirmation')
    expect(result, 'cleanup must progress without manual interrupt').toMatchObject({
      result: { subtype: 'success' },
    })
    expect(events.filter((e) => e.type === 'codex.cleanup.failed')).toHaveLength(1)
    expect(events.find((e) => e.type === 'codex.cleanup.failed').data).toMatchObject({
      code: 'process_cleanup_unconfirmed',
      retrying: true,
      attempt: 1,
    })
    expect(
      events.filter((e) => e.type === 'codex.worker.exit' && e.data.cleanup_confirmed)
    ).toHaveLength(1)
    expect(timers.pending).toBe(0)
  } finally {
    terminal = false
    await run?.interrupt()
    rmSync(state, { recursive: true, force: true })
  }
})
