import { expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import { endlessFixture as fixture } from './endless-cost-fixture.js'
import { SessionMessageTools } from '../packages/node-core/src/session-messages.js'
import type { LiveSessions } from '../packages/node-core/src/live-sessions.js'

it('pages node_sessions with bounded deserialization and can address a target without listing history', async () => {
  const { dir, core, actor, session } = fixture()
  try {
    core.transaction(() => {
      for (let n = 0; n < 5000; n++) {
        const id = `s-${String(n).padStart(6, '0')}`
        core.db.prepare('INSERT INTO streams(stream_id) VALUES(?)').run(id)
        core.db
          .prepare('INSERT INTO sessions VALUES(?,?)')
          .run(id, JSON.stringify({ ...session, session_id: id }))
      }
    })
    const live = {
      effective: () => ({ messaging: true }),
      handles: () => true,
      runningSessionIds: () => [],
      modes: () => ['manual'],
      state: () => ({ process: 'idle', settings: { messaging: true } }),
    } as unknown as LiveSessions
    const tools = new SessionMessageTools(
      core,
      live,
      {
        session_id: session.session_id,
        principal: actor.installation_id,
        run_id: 'run',
      },
      () => true
    )
    const parse = vi.spyOn(JSON, 'parse')
    const first = (await tools.call('node_sessions', { all: true, limit: 10 })) as any
    expect(first.sessions).toHaveLength(10)
    const count = parse.mock.calls.length
    parse.mockRestore()
    expect(count).toBeLessThan(150)
    expect(first.next_after_id).toBe(first.sessions.at(-1).session_id)
    const next = (await tools.call('node_sessions', {
      all: true,
      limit: 10,
      after_id: first.next_after_id,
    })) as any
    expect(next.sessions[0].session_id > first.next_after_id).toBe(true)
    expect(await tools.call('node_sessions', { limit: 101 })).toEqual({ code: 'invalid_params' })
    console.log('node_sessions JSON parses for page of 10 among 5001:', count)
    const sendParse = vi.spyOn(JSON, 'parse')
    expect(
      await tools.call('node_session_send', { session_id: 's-004999', text: 'hello' })
    ).toMatchObject({ session_id: 's-004999', state: 'queued' })
    expect(sendParse.mock.calls.length).toBeLessThan(40)
    sendParse.mockRestore()
    live.handles = () => false
    const empty = (await tools.call('node_sessions', { all: true, limit: 10 })) as any
    expect(empty.sessions).toEqual([])
    expect(empty.next_after_id).toBeTruthy()
  } finally {
    vi.restoreAllMocks()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
