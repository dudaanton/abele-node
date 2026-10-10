import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
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
  const events: any[] = []
  let fault = false,
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
        processes: () => {},
        permission: async () => ({ choice: 'deny', delivered: () => true }),
        event: (e) => {
          events.push(e)
          if (e.type === 'codex.turn.completed') fault = true
        },
      }
    )
    const until = async (count: number, timeout: number) => {
      const end = Date.now() + timeout
      while (
        events.filter((e) => e.type === 'codex.cleanup.failed').length < count &&
        Date.now() < end
      )
        await new Promise((r) => setTimeout(r, 20))
      expect(events.filter((e) => e.type === 'codex.cleanup.failed')).toHaveLength(count)
    }
    await until(4, 2800)
    expect(events.filter((e) => e.type === 'codex.cleanup.failed').at(-1).data.retrying).toBe(false)
    expect(
      await Promise.race([
        run.done.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 100)),
      ])
    ).toBe(false)
    await until(5, 1800) // The original deadline still invokes one bounded cleanup attempt.
    expect(events.some((e) => e.type === 'codex.worker.exit')).toBe(false)
    fault = false
    await run.interrupt()
    await run.done
    expect(
      events.filter((e) => e.type === 'codex.worker.exit' && e.data.cleanup_confirmed)
    ).toHaveLength(1)
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
  const events: any[] = []
  let failures = 0,
    terminal = false,
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
    const result = await Promise.race([
      run.done,
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 2500)),
    ])
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
  } finally {
    terminal = false
    await run?.interrupt()
    rmSync(state, { recursive: true, force: true })
  }
})
