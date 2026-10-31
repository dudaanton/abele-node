import { afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { activeRuns } from '../packages/node-daemon/src/update.js'
const cleanup: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn()
})
const idle = { tasks: [], crons: 0, wakeUntil: 0, compacting: false }
function fixture(saved: unknown = idle, live: string | null = null) {
  const dir = mkdtempSync(join(tmpdir(), 'abele-update-runs-'))
  const db = new DatabaseSync(join(dir, 'node.sqlite'))
  db.exec(`CREATE TABLE provider_runs(run_id TEXT, session_id TEXT, state TEXT, live TEXT, live_state TEXT);
    CREATE TABLE events(stream_id TEXT, seq INTEGER, body TEXT);
    CREATE TABLE inputs(session_id TEXT, state TEXT);
    CREATE TABLE prompts(session_id TEXT, body TEXT);`)
  db.prepare("INSERT INTO provider_runs VALUES ('run', 'session', 'active', ?, ?)").run(
    live,
    typeof saved === 'string' ? saved : JSON.stringify(saved)
  )
  cleanup.push(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { db, dir }
}
const run = { run_id: 'run', session_id: 'session' }
it('does not block update for a non-adoptable provider with proven idle durable state', () => {
  const f = fixture()
  expect(activeRuns(f.dir)).toEqual({ runs: [], kept: [] })
  expect(f.db.prepare('SELECT state FROM provider_runs').get()?.state).toBe('active')
})
it.each([
  { turn: { turn_id: 'turn' } },
  { tasks: [{}] },
  { crons: 1 },
  { wakeUntil: Date.now() + 60_000 },
  { compacting: true },
  { compaction: {} },
  { continueAfterTurn: {} },
])('blocks a provider with pending work %j', (pending) => {
  const f = fixture({ ...idle, ...pending })
  expect(activeRuns(f.dir).runs).toEqual([run])
})
it.each(['accepted', 'queued', 'dispatching', 'delivered'])(
  'blocks idle snapshots with %s input',
  (state) => {
    const f = fixture()
    f.db.prepare('INSERT INTO inputs VALUES (?, ?)').run('session', state)
    expect(activeRuns(f.dir).runs).toEqual([run])
  }
)
it('blocks pending prompts even when the saved provider is idle', () => {
  const f = fixture()
  f.db
    .prepare('INSERT INTO prompts VALUES (?, ?)')
    .run('session', JSON.stringify({ state: 'pending' }))
  expect(activeRuns(f.dir).runs).toEqual([run])
})
it.each([null, {}, '{invalid', { ...idle, tasks: null }])(
  'blocks ambiguous durable state %j',
  (saved) => {
    const f = fixture(saved)
    expect(activeRuns(f.dir).runs).toEqual([run])
  }
)
it('preserves adoptable session handoff', () => {
  const f = fixture(null, '{}')
  expect(activeRuns(f.dir)).toEqual({ runs: [], kept: [run] })
})
it('blocks legacy rows without live state', () => {
  const f = fixture()
  f.db.exec('ALTER TABLE provider_runs DROP COLUMN live_state')
  expect(activeRuns(f.dir).runs).toEqual([run])
})

it('blocks a quarantined process even if its last saved state was idle', () => {
  const f = fixture()
  f.db.prepare('INSERT INTO events VALUES (?, ?, ?)').run(
    'session',
    1,
    JSON.stringify({
      type: 'session.process',
      data: { run_id: 'run', state: 'exited', reason: 'process_cleanup_unconfirmed' },
    })
  )
  expect(activeRuns(f.dir).runs).toEqual([run])
})

it.each(['resolved', 'expired', 'invalidated'])(
  'does not count a %s prompt as pending work',
  (state) => {
    const f = fixture()
    f.db.prepare('INSERT INTO prompts VALUES (?, ?)').run('session', JSON.stringify({ state }))
    expect(activeRuns(f.dir).runs).toEqual([])
  }
)
