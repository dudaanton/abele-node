import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { discoverCodex } from '../packages/provider-codex/src/discovery.js'
import { startCodexTurn } from '../packages/provider-codex/src/worker.js'

it.each([
  'success',
  'crash-before-binding',
  'crash-after-binding',
  'crash-after-dispatch',
  'model-fallback',
  'approval',
  'approval-crash',
])('runs the supervised fake lifecycle %s without replay', async (mode) => {
  const dir = mkdtempSync(resolve('.scratch/codex-worker-')),
    home = join(dir, 'home'),
    workspace = join(dir, 'workspace')
  mkdirSync(home)
  mkdirSync(workspace)
  writeFileSync(join(home, 'fixture.json'), JSON.stringify({ mode }))
  const events: any[] = [],
    processes: any[] = []
  let consumed = 0
  try {
    const run = await startCodexTurn(
      {
        executable: discoverCodex({
          executable: resolve('tests/fixtures/codex.mjs'),
          fixture: true,
        }),
        paths: { home, workspace, sibling: dir, state: dir },
        model: 'fixture-small',
        deadlineMs: 3000,
        turn: {
          session_id: randomUUID(),
          run_id: randomUUID(),
          cwd: workspace,
          text: 'fake prompt',
        },
      },
      {
        event: (e) => events.push(e),
        processes: (p) => processes.push(...p),
        permission: async () => ({
          choice: 'allow',
          delivered: () => {
            consumed++
            return true
          },
        }),
      }
    )
    const result = await run.done
    expect(processes).toHaveLength(1)
    expect(() => process.kill(processes[0].pid, 0)).toThrow()
    if (['success', 'approval'].includes(mode))
      expect(result.result).toMatchObject({ subtype: 'success' })
    else expect(result.reason).toMatch(/codex_/)
    expect(events.filter((e) => e.type === 'codex.session.bound')).toHaveLength(
      ['crash-before-binding', 'model-fallback'].includes(mode) ? 0 : 1
    )
    expect(consumed).toBe(mode.startsWith('approval') ? 1 : 0)
    expect(existsSync(join(workspace, 'approved-effect.txt'))).toBe(mode.startsWith('approval'))
    if (existsSync(join(home, 'turn-log.jsonl')))
      expect(readFileSync(join(home, 'turn-log.jsonl'), 'utf8').trim().split('\n')).toHaveLength(1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
it('persists a binding before input, resumes exactly that thread and interrupts with confirmed cleanup', async () => {
  const dir = mkdtempSync(resolve('.scratch/codex-resume-')),
    home = join(dir, 'home'),
    workspace = join(dir, 'workspace')
  mkdirSync(home)
  mkdirSync(workspace)
  const executable = discoverCodex({
      executable: resolve('tests/fixtures/codex.mjs'),
      fixture: true,
    }),
    paths = { home, workspace, sibling: dir, state: dir },
    session_id = randomUUID()
  let binding: any
  const options = { executable, paths, model: 'fixture-small', deadlineMs: 3000 }
  const sink = {
    event: (e: any) => {
      if (e.type === 'codex.session.bound') {
        expect(existsSync(join(home, 'turn-log.jsonl'))).toBe(false)
        binding = e.data
      }
    },
    processes: () => {},
    permission: async () => ({ choice: 'deny' as const, delivered: () => true }),
  }
  try {
    const first = await startCodexTurn(
      { ...options, turn: { session_id, run_id: randomUUID(), cwd: workspace, text: 'first' } },
      sink
    )
    expect((await first.done).result?.subtype).toBe('success')
    writeFileSync(join(home, 'fixture.json'), JSON.stringify({ mode: 'hang' }))
    let accepted!: () => void
    const acceptedPromise = new Promise<void>((r) => {
      accepted = r
    })
    const second = await startCodexTurn(
      {
        ...options,
        turn: {
          session_id,
          run_id: randomUUID(),
          cwd: workspace,
          text: 'second',
          native_session_id: binding.native_session_id,
          native_binding: binding,
        },
      },
      {
        ...sink,
        event: (e: any) => {
          if (e.type === 'codex.input.accepted') accepted()
        },
      }
    )
    await acceptedPromise
    await second.interrupt()
    expect((await second.done).reason).toBe('interrupted')
    const turns = readFileSync(join(home, 'turn-log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s))
    expect(turns.map((t) => t.threadId)).toEqual([
      binding.native_session_id,
      binding.native_session_id,
    ])
    expect(turns.map((t) => t.input[0].text)).toEqual(['first', 'second'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
