import { expect, it, vi } from 'vitest'
import { rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { endlessFixture as fixture } from './endless-cost-fixture.js'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NodeCore } from '../packages/node-core/src/index.js'
import { PromptSchema } from '@abele/node-protocol'
import { target as debuggerTarget } from './debugger/helpers.js'

it('bounds orphan recovery cleanup at startup and drains the remainder in bounded ticks', () => {
  const { dir, core } = fixture()
  let current = core
  try {
    const copies = join(core.stateDir, 'file-recovery', 'old-workspace')
    mkdirSync(copies, { recursive: true })
    for (let n = 0; n < 1000; n++) writeFileSync(join(copies, `${n}.bin`), '')
    current.close()
    const start = performance.now()
    current = new NodeCore(join(dir, 'state'))
    console.log(
      'restart with 1000 orphan files ms / files left for later ticks:',
      performance.now() - start,
      readdirSync(copies).length
    )
    expect(readdirSync(copies).length).toBeGreaterThanOrEqual(872)
    for (let n = 0; n < 20; n++) current.tick()
    expect(readdirSync(copies)).toEqual([])
  } finally {
    current.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('does not parse completed prompt/session history at restart or on internal prompt reads', async () => {
  const { dir, core, actor, session } = fixture()
  const snapshot = core.debugger.create(debuggerTarget)
  let current = core
  try {
    const seed = (from: number, to: number) =>
      current.transaction(() => {
        for (let n = from; n <= to; n++) {
          const id = `s-${String(n).padStart(6, '0')}`
          current.db.prepare('INSERT INTO streams(stream_id) VALUES(?)').run(id)
          current.db
            .prepare('INSERT INTO sessions VALUES(?,?)')
            .run(id, JSON.stringify({ ...session, session_id: id }))
          current.db.prepare('INSERT INTO prompts VALUES(?,?,?,?)').run(
            `p-${n}`,
            session.session_id,
            'old-run',
            JSON.stringify(
              PromptSchema.parse({
                prompt_id: `p-${n}`,
                session_id: session.session_id,
                run_id: 'old-run',
                revision: 1,
                action_digest: 'a'.repeat(64),
                expires_at: 0,
                state: 'resolved',
                choice: 'deny',
                installation_id: actor.installation_id,
                delivered: true,
              })
            )
          )
          current.db
            .prepare('INSERT INTO manager_runs VALUES(?,?)')
            .run(`manager-${n}`, JSON.stringify({ state: 'succeeded' }))
          current.db
            .prepare('INSERT INTO obsidian_tool_config VALUES(?,?)')
            .run(id, JSON.stringify({ revision: 'r1' }))
          current.db.prepare('INSERT INTO obsidian_tool_revisions VALUES(?,?)').run(id, 'r1')
          current.db
            .prepare('INSERT INTO debug_sessions(debug_session_id,body) VALUES(?,?)')
            .run(`debug-${n}`, JSON.stringify({ ...snapshot, debug_session_id: `debug-${n}` }))
          current.db
            .prepare('INSERT INTO debug_operations VALUES(?,?,?,?,?)')
            .run(
              'owner',
              `operation-${n}`,
              `debug-${n}`,
              'hash',
              JSON.stringify({ receipt: { outcome: 'completed' } })
            )
          current.db
            .prepare(
              'INSERT INTO inputs(input_id,session_id,principal_id,state,body) VALUES(?,?,?,?,?)'
            )
            .run(`input-${n}`, session.session_id, actor.installation_id, 'completed', '{}')
        }
      })
    const counts: number[] = [],
      times: number[] = []
    for (const [from, to] of [
      [1, 10],
      [11, 5000],
    ]) {
      seed(from!, to!)
      await current.resources.stop()
      current.close()
      const exec = vi.spyOn(DatabaseSync.prototype, 'exec')
      const parse = vi.spyOn(JSON, 'parse')
      const start = performance.now()
      current = new NodeCore(join(dir, 'state'), { debuggerEnabled: true })
      times.push(performance.now() - start)
      counts.push(parse.mock.calls.length)
      parse.mockRestore()
      expect(
        exec.mock.calls.some(([sql]) =>
          sql.includes('INSERT OR IGNORE INTO obsidian_tool_revisions SELECT')
        )
      ).toBe(false)
      exec.mockRestore()
      expect([...current.pendingPrompts(session.session_id)]).toEqual([])
    }
    expect(counts[1]! - counts[0]!).toBeLessThan(5)
    expect(times[1]).toBeLessThan(2000)
    expect(current.prompts(session.session_id)).toHaveLength(100)
    for (const [sql, params] of [
      [
        "SELECT 1 FROM prompts WHERE session_id=? AND json_extract(body,'$.state')='pending' LIMIT 1",
        [session.session_id],
      ],
      ["SELECT body FROM prompts WHERE json_extract(body,'$.state')='pending'", []],
      [
        "SELECT body FROM manager_runs WHERE json_extract(body,'$.state') IN ('pending_approval','running')",
        [],
      ],
      ["SELECT * FROM inputs WHERE state IN ('dispatching','delivered')", []],
    ] as [string, string[]][]) {
      const plan = JSON.stringify(current.db.prepare('EXPLAIN QUERY PLAN ' + sql).all(...params))
      expect(plan).toMatch(/INDEX/)
      expect(plan).not.toMatch(/SCAN (?:prompts|inputs|manager_runs)(?! USING INDEX)/)
    }
    console.log(
      'restart ms / JSON parses, 10 then 5000 sessions/prompts/inputs/manager runs/debug sessions/operations:',
      times,
      counts
    )
    current.transaction(() => {
      for (let n = 0; n < 205; n++) {
        const p = PromptSchema.parse({
          prompt_id: `pending-${String(n).padStart(3, '0')}`,
          session_id: session.session_id,
          run_id: 'obsidian:run',
          revision: 1,
          action_digest: 'b'.repeat(64),
          expires_at: Number.MAX_SAFE_INTEGER,
          state: 'pending',
          choice: null,
          installation_id: null,
          delivered: false,
        })
        current.db
          .prepare('INSERT INTO prompts VALUES(?,?,?,?)')
          .run(p.prompt_id, p.session_id, p.run_id, JSON.stringify(p))
      }
    })
    expect(current.pendingPromptCount(session.session_id)).toBe(205)
    expect(current.hasPendingPrompt(session.session_id)).toBe(true)
    expect(
      current.request(actor, 'prompt.list', {
        session_id: session.session_id,
        state: 'pending',
        limit: 100,
      })
    ).toHaveLength(100)
    current.transaction(() => {
      for (const p of current.pendingPrompts(session.session_id))
        current.resolvePrompt(p, 'invalidated', 'deny', null)
    })
    expect(current.pendingPromptCount(session.session_id)).toBe(0)
    expect(current.hasPendingPrompt(session.session_id)).toBe(false)
  } finally {
    vi.restoreAllMocks()
    current.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
