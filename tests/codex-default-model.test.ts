import { expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { discoverCodex } from '../packages/provider-codex/src/discovery.js'
import { startCodexTurn } from '../packages/provider-codex/src/worker.js'

it.each(['user-model', 'no-model-metadata', 'empty', 'explicit'])(
  'uses Codex own model without thread/turn overrides, or honours an explicit model: %s',
  async (mode) => {
    const dir = mkdtempSync(resolve('.scratch/codex-own-model-'))
    const home = join(dir, 'home'),
      workspace = join(dir, 'workspace')
    mkdirSync(home)
    mkdirSync(workspace)
    writeFileSync(
      join(home, 'fixture.json'),
      JSON.stringify({ mode: mode === 'explicit' ? 'user-model' : mode, track_requests: true })
    )
    const model = mode === 'explicit' ? 'fixture-small' : mode === 'empty' ? '' : undefined
    const options = {
      executable: discoverCodex({ executable: resolve('tests/fixtures/codex.mjs'), fixture: true }),
      paths: { home, workspace, sibling: dir, state: dir },
      model,
      deadlineMs: 3000,
    }
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
      const first = await startCodexTurn(
        { ...options, turn: { session_id, run_id: randomUUID(), cwd: workspace, text: 'first' } },
        sink
      )
      expect((await first.done).result?.subtype).toBe('success')
      expect(binding.model).toBe(mode === 'user-model' ? 'fixture-user-default' : 'fixture-small')
      const resumed = await startCodexTurn(
        {
          ...options,
          turn: {
            session_id,
            run_id: randomUUID(),
            cwd: workspace,
            text: 'resume',
            native_session_id: binding.native_session_id,
            native_binding: binding,
          },
        },
        sink
      )
      expect((await resumed.done).result?.subtype).toBe('success')
      const requests = readFileSync(join(home, 'request-log.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      for (const request of requests.filter((r) =>
        ['thread/start', 'thread/resume', 'turn/start'].includes(r.method)
      )) {
        if (model) expect(request.params.model).toBe(model)
        else expect(request.params).not.toHaveProperty('model')
      }
      // A default model changing between turns must not silently rewrite the binding.
      if (!model) {
        writeFileSync(
          join(home, 'fixture.json'),
          JSON.stringify({ mode: mode === 'user-model' ? 'no-model-metadata' : 'user-model' })
        )
        const changed = await startCodexTurn(
          {
            ...options,
            turn: {
              session_id,
              run_id: randomUUID(),
              cwd: workspace,
              text: 'must not dispatch',
              native_session_id: binding.native_session_id,
              native_binding: binding,
            },
          },
          sink
        )
        expect((await changed.done).reason).toBe('codex_thread_policy_mismatch')
        expect(readFileSync(join(home, 'turn-log.jsonl'), 'utf8').trim().split('\n')).toHaveLength(
          2
        )
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
