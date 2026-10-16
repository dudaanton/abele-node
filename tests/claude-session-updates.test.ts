import { expect, afterEach } from 'vitest'
import { sessionUpdatesOf } from '@abele/node-protocol'
import { processIt as it } from './process-test.js'
import { setup, until, cleanupLive } from './live-harness.js'

// Claude's stream written once more as session updates, beside the records it came from.
afterEach(cleanupLive)

it('journals session updates after the Claude records, lists commands and runs one', async () => {
  const s = await setup()
  const id = await s.session()
  const first = s.send(id, 'hello')
  await until(() => s.input(first).state === 'completed')
  const bg = s.send(id, 'background 10 job')
  await until(() => s.input(bg).state === 'completed')
  await until(() =>
    s.events(id, 'session.update').some((e) => e.data.update.text === 'BG-NOTIFIED job')
  )

  const updates = s.events(id).flatMap(sessionUpdatesOf)
  expect(updates).toEqual(
    expect.arrayContaining([
      {
        kind: 'agent_message',
        message_id: expect.any(String),
        block: 0,
        text: 'reply:hello',
        parent_tool_call_id: null,
      },
      expect.objectContaining({ kind: 'current_mode_update' }),
      expect.objectContaining({
        kind: 'tool_call',
        tool_call_id: 'tool-job',
        tool_kind: 'execute',
        title: 'sleep',
        status: 'pending',
        name: 'Bash',
      }),
      {
        kind: 'tool_call_update',
        tool_call_id: 'tool-job',
        status: 'completed',
        content: [{ type: 'content', text: 'running' }],
      },
    ])
  )
  // Each update follows its record directly, and the record says it was mapped.
  const all = s.events(id)
  for (const [i, e] of all.entries())
    if (e.type === 'session.update') {
      const source = all
        .slice(0, i)
        .reverse()
        .find((p) => p.type !== 'session.update')!
      expect(source.data.mapped).toBe(true)
      expect(e.data.run_id).toBe(source.data.run_id)
    }

  const listed = await s.request('session.commands', { session_id: id })
  expect(listed.commands).toEqual([
    { name: 'review', description: null, source: 'skill' },
    { name: 'compact', description: null, source: 'builtin' },
    { name: 'context', description: null, source: 'builtin' },
    { name: 'plugin:act', description: null, source: 'skill' },
  ])
  expect(listed.seq).toBe(
    s
      .events(id, 'session.update')
      .filter((e) => e.data.update.kind === 'available_commands_update')
      .at(-1).seq
  )

  const compact = s.send(id, '/compact keep the plan')
  await until(() => s.input(compact).state === 'completed')
  const kinds = s.events(id).flatMap(sessionUpdatesOf)
  expect(kinds).toEqual(
    expect.arrayContaining([
      { kind: 'compaction_update', state: 'started' },
      {
        kind: 'compaction_update',
        state: 'completed',
        trigger: 'manual',
        pre_tokens: 5000,
        post_tokens: 300,
      },
      expect.objectContaining({ kind: 'compaction_summary' }),
    ])
  )

  // A journal from before the node wrote updates replays into the same updates.
  const current = s.events(id)
  const legacy = current
    .filter((e) => e.type !== 'session.update')
    .map((e) => {
      const { mapped: _mapped, ...data } = e.data
      return { ...e, data }
    })
  expect(legacy.flatMap(sessionUpdatesOf)).toEqual(current.flatMap(sessionUpdatesOf))
  // Beside the node's own context and compaction events, the journal's updates are all there is.
  expect(current.filter((e) => e.actor.kind !== 'node').flatMap(sessionUpdatesOf)).toEqual(
    s.events(id, 'session.update').map((e) => e.data.update)
  )
  expect(kinds.filter((u) => u.kind === 'compaction_update')).toHaveLength(2)
})

it('answers an empty command list before the agent reported one', async () => {
  const s = await setup()
  const id = await s.session()
  expect(await s.request('session.commands', { session_id: id })).toEqual({
    session_id: id,
    commands: [],
    seq: 0,
  })
})
