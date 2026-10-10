import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { systemProcessProbe } from '@abele/provider-claude'
import { discoverCodex } from '../packages/provider-codex/src/discovery.js'
import { startCodexTurn } from '../packages/provider-codex/src/worker.js'

it('fences PID reuse and leaves done unsettled until cleanup is confirmed, allowing a cleanup retry', async () => {
  const dir = mkdtempSync(resolve('.scratch/codex-cleanup-')),
    home = join(dir, 'home'),
    workspace = join(dir, 'workspace')
  mkdirSync(home)
  mkdirSync(workspace)
  let fault = false,
    terminal!: () => void,
    run: Awaited<ReturnType<typeof startCodexTurn>> | undefined
  const terminalPromise = new Promise<void>((r) => {
      terminal = r
    }),
    events: any[] = []
  try {
    run = await startCodexTurn(
      {
        executable: discoverCodex({
          executable: resolve('tests/fixtures/codex.mjs'),
          fixture: true,
        }),
        paths: { home, workspace, state: dir, sibling: dir },
        model: 'fixture-small',
        deadlineMs: 3000,
        turn: { session_id: randomUUID(), run_id: randomUUID(), cwd: workspace, text: 'fixture' },
        probe: {
          identity: (pid) => {
            const actual = systemProcessProbe.identity(pid)
            return actual && fault ? { ...actual, fingerprint: 'different-process' } : actual
          },
          groupMembers: (leader) => {
            if (fault) throw new Error('process_identity_changed')
            return systemProcessProbe.groupMembers(leader)
          },
        },
      },
      {
        processes: () => {},
        event: (e) => {
          events.push(e)
          if (e.type === 'codex.turn.completed') {
            fault = true
            terminal()
          }
        },
        permission: async () => ({ choice: 'deny', delivered: () => true }),
      }
    )
    await terminalPromise
    expect(
      await Promise.race([
        run.done.then(() => true),
        new Promise<boolean>((r) => setTimeout(() => r(false), 100)),
      ])
    ).toBe(false)
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
    rmSync(dir, { recursive: true, force: true })
  }
})
