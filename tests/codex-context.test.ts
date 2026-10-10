import { it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { discoverCodex } from '../packages/provider-codex/src/discovery.js'
import { startCodexTurn } from '../packages/provider-codex/src/worker.js'
it('fails explicitly on missing recorded context without creating a replacement thread or replaying input', async () => {
  const dir = mkdtempSync(resolve('.scratch/codex-context-')),
    home = join(dir, 'home'),
    workspace = join(dir, 'workspace')
  mkdirSync(home)
  mkdirSync(workspace)
  const executable = discoverCodex({
      executable: resolve('tests/fixtures/codex.mjs'),
      fixture: true,
    }),
    paths = { home, workspace, state: dir, sibling: dir },
    session_id = randomUUID()
  let binding: any
  const sink = {
    processes: () => {},
    event: (e: any) => {
      if (e.type === 'codex.session.bound') binding = e.data
    },
    permission: async () => ({ choice: 'deny' as const, delivered: () => true }),
  }
  try {
    const first = await startCodexTurn(
      {
        executable,
        paths,
        model: 'fixture-small',
        deadlineMs: 3000,
        turn: { session_id, run_id: randomUUID(), cwd: workspace, text: 'once' },
      },
      sink
    )
    await first.done
    const turn = {
      session_id,
      run_id: randomUUID(),
      cwd: workspace,
      text: 'explicit followup',
      native_session_id: binding.native_session_id,
      native_binding: binding,
    }
    for (const changed of [
      { model: 'different' },
      { workspace_path: home },
      { policy_fingerprint: '0'.repeat(64) },
    ])
      await expect(
        startCodexTurn(
          {
            executable,
            paths,
            model: 'fixture-small',
            deadlineMs: 3000,
            turn: { ...turn, native_binding: { ...binding, ...changed } },
          },
          sink
        )
      ).rejects.toThrow('binding_mismatch')
    writeFileSync(join(home, 'threads.json'), '{}')
    const resumed = await startCodexTurn(
      { executable, paths, model: 'fixture-small', deadlineMs: 3000, turn },
      sink
    )
    expect((await resumed.done).reason).toBe('codex_native_context_unavailable')
    expect(JSON.parse(readFileSync(join(home, 'threads.json'), 'utf8'))).toEqual({})
    expect(readFileSync(join(home, 'turn-log.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
