import { expect, it } from 'vitest'
import { codexSessionUpdates } from '../src/codex-updates.js'
import { SessionUpdateEventSchema, isKnownSessionUpdate } from '../src/session-update.js'

const valid = (type: string, data: unknown) => {
  const updates = codexSessionUpdates(type, data)
  for (const update of updates) {
    expect(SessionUpdateEventSchema.safeParse({ update }).success).toBe(true)
    expect(isKnownSessionUpdate(update)).toBe(true)
  }
  return updates
}

it('maps Codex messages, reasoning, commands and file changes onto session updates', () => {
  expect(valid('codex.message.delta', { item_id: 'm', delta: 'he' })).toEqual([
    { kind: 'agent_message_chunk', message_id: 'm', text: 'he' },
  ])
  expect(valid('codex.message.final', { item_id: 'm', text: 'hello', replace: true })).toEqual([
    { kind: 'agent_message', message_id: 'm', text: 'hello' },
  ])
  expect(valid('codex.thinking', { item_id: 'r', delta: 'hmm' })[0]!.kind).toBe(
    'agent_thought_chunk'
  )
  expect(
    valid('codex.tool.call', {
      item_id: 'c',
      tool: 'commandExecution',
      command: 'npm test\n--watch',
      cwd: '/w',
      status: 'inProgress',
    })
  ).toEqual([
    {
      kind: 'tool_call',
      tool_call_id: 'c',
      status: 'in_progress',
      title: 'npm test',
      tool_kind: 'execute',
      name: 'commandExecution',
      raw_input: { command: 'npm test\n--watch', cwd: '/w' },
    },
  ])
  expect(
    valid('codex.tool.result', {
      item_id: 'c',
      tool: 'commandExecution',
      status: 'completed',
      exit_code: 1,
      output: 'boom',
    })
  ).toEqual([
    {
      kind: 'tool_call_update',
      tool_call_id: 'c',
      status: 'failed',
      content: [{ type: 'content', text: 'boom' }],
    },
  ])
  const changes = [
    { path: '/w/new.txt', kind: { type: 'add' }, diff: 'fresh' },
    { path: '/w/old.txt', kind: { type: 'update' }, diff: '@@ -1 +1 @@\n-a\n+b' },
  ]
  const call = valid('codex.tool.call', { item_id: 'f', tool: 'fileChange', changes })[0] as any
  expect(call).toMatchObject({ title: 'Edit 2 files', tool_kind: 'edit' })
  expect(call.locations).toEqual([{ path: '/w/new.txt' }, { path: '/w/old.txt' }])
  expect(call.content[0]).toEqual({
    type: 'diff',
    path: '/w/new.txt',
    old_text: null,
    new_text: 'fresh',
  })
  expect(call.content[1].type).toBe('content')
  expect(
    valid('codex.tool.call', {
      item_id: 'd',
      tool: 'fileChange',
      changes: [{ path: '/w/x', kind: { type: 'delete' }, diff: '' }],
    })[0]
  ).toMatchObject({ tool_kind: 'delete', title: 'Edit /w/x' })
  expect(valid('codex.tool.proposal', { item_id: 'f', changes })[0]!.kind).toBe('tool_call_update')
})

it('maps the plan, the command list and compaction status', () => {
  expect(
    valid('codex.plan', {
      explanation: null,
      plan: [
        { step: 'read', status: 'completed' },
        { step: 'write', status: 'inProgress' },
        { step: 'test', status: 'pending' },
      ],
    })
  ).toEqual([
    {
      kind: 'plan',
      entries: [
        { content: 'read', priority: 'medium', status: 'completed' },
        { content: 'write', priority: 'medium', status: 'in_progress' },
        { content: 'test', priority: 'medium', status: 'pending' },
      ],
    },
  ])
  const commands = [
    { name: 'compact', description: 'Compact', input_hint: 'focus (optional)', source: 'builtin' },
    { name: 'tidy', description: null, input_hint: null, source: 'skill' },
  ]
  expect(valid('codex.commands', { commands })).toEqual([
    { kind: 'available_commands_update', commands },
  ])
  expect(valid('live.status', { status: 'compacting' })).toEqual([
    { kind: 'compaction_update', state: 'started' },
  ])
  expect(
    valid('live.status', { status: null, compact_result: 'failed', compact_error: 'failed' })
  ).toEqual([{ kind: 'compaction_update', state: 'failed', error: 'failed' }])
})

it('maps nothing from records it does not know or that were kept as artifacts', () => {
  for (const type of ['codex.session.bound', 'codex.diff', 'codex.input.accepted', 'codex.other'])
    expect(codexSessionUpdates(type, { run_id: 'r' })).toEqual([])
  expect(codexSessionUpdates('codex.message.final', { run_id: 'r', artifact_id: 'a' })).toEqual([])
  expect(codexSessionUpdates('codex.tool.call', null)).toEqual([])
})
