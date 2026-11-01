import { expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { CodexProviderAdapter } from '../packages/provider-codex/src/adapter.js'
import { discoverCodex } from '../packages/provider-codex/src/discovery.js'
import { startCodexTurn } from '../packages/provider-codex/src/worker.js'
import { startCodexLiveSession } from '../packages/provider-codex/src/live.js'

it('reports Codex default effort and accepts its effective settings', () => {
  const adapter = new CodexProviderAdapter({ stateDir: resolve('.scratch'), enabled: false })
  expect(adapter.sessionDefaults().effort).toBe('default')
  expect(() => adapter.validateSettings(adapter.sessionDefaults())).not.toThrow()
})

function setup(mode: string) {
  const dir = mkdtempSync(resolve('.scratch/codex-effort-'))
  const home = join(dir, 'home'),
    workspace = join(dir, 'workspace')
  mkdirSync(home)
  mkdirSync(workspace)
  writeFileSync(join(home, 'fixture.json'), JSON.stringify({ mode, track_requests: true }))
  return {
    dir,
    home,
    workspace,
    executable: discoverCodex({ executable: resolve('tests/fixtures/codex.mjs'), fixture: true }),
    paths: { home, workspace, sibling: dir, state: dir },
    requests: () =>
      readFileSync(join(home, 'request-log.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
        .filter((r) => r.method === 'turn/start'),
  }
}
const efforts = ['default', 'low', 'medium', 'high', 'xhigh']
const assertEffort = (params: Record<string, unknown>, effort: string | undefined) => {
  if (!effort || effort === 'default') expect(params).not.toHaveProperty('effort')
  else expect(params.effort).toBe(effort)
}

it('uses current worker effort on every resumed turn, omitting unset/default', async () => {
  const t = setup('success')
  let binding: any
  const sink = {
    event: (e: any) => {
      if (e.type === 'codex.session.bound') binding = e.data
    },
    processes: () => {},
    permission: async () => ({ choice: 'deny' as const, delivered: () => true }),
  }
  const session_id = randomUUID()
  try {
    for (const effort of [undefined, ...efforts, 'default']) {
      const run = await startCodexTurn(
        {
          executable: t.executable,
          paths: t.paths,
          deadlineMs: 3000,
          turn: {
            session_id,
            run_id: randomUUID(),
            cwd: t.workspace,
            text: 'next',
            effort,
            ...(binding
              ? { native_session_id: binding.native_session_id, native_binding: binding }
              : {}),
          },
        },
        sink
      )
      expect((await run.done).result?.subtype).toBe('success')
      assertEffort(t.requests().at(-1).params, effort)
    }
    expect(t.requests()).toHaveLength(7)
  } finally {
    rmSync(t.dir, { recursive: true, force: true })
  }
})

it.each(efforts)('uses %s effort for every live turn', async (effort) => {
  const t = setup('live')
  let completed = 0
  let live: Awaited<ReturnType<typeof startCodexLiveSession>> | undefined
  try {
    live = await startCodexLiveSession(
      {
        executable: t.executable,
        paths: t.paths,
        context: {
          session_id: randomUUID(),
          run_id: randomUUID(),
          cwd: t.workspace,
          settings: { model: 'default', effort, account: 'default', permission_mode: 'manual' },
          permission_ttl_ms: 60000,
        },
      },
      {
        event: (e) => {
          if (e.type === 'live.turn.completed') completed++
        },
        processes: () => {},
        permission: async () => ({ choice: 'deny' as const, delivered: () => true }),
      }
    )
    for (let i = 1; i <= 2; i++) {
      live.send({ input_id: String(i), content: 'next' })
      const until = Date.now() + 5000
      while (completed < i) {
        if (Date.now() > until) throw new Error('timed out')
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    expect(t.requests()).toHaveLength(2)
    for (const request of t.requests()) assertEffort(request.params, effort)
  } finally {
    await live?.stop()
    rmSync(t.dir, { recursive: true, force: true })
  }
})
