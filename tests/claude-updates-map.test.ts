import { describe, expect, it } from 'vitest'
import { claudeSessionUpdates, SessionUpdateEventSchema } from '@abele/node-protocol'
import { ClaudeEventMapper } from '../packages/provider-claude/src/stream.js'

// stream-json records in the shapes a headless CLI writes with partial messages on.
const records = [
  {
    type: 'system',
    subtype: 'init',
    session_id: 's',
    model: 'claude-sonnet',
    permissionMode: 'default',
    slash_commands: ['compact', 'doctor', 'review', 'review'],
    terminal_slash_commands: ['doctor'],
    skills: ['review'],
  },
  { type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } },
  {
    type: 'stream_event',
    event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
  },
  {
    type: 'stream_event',
    event: {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'thinking_delta', thinking: 'Let me look' },
    },
  },
  { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
  {
    type: 'assistant',
    message: { id: 'm1', content: [{ type: 'thinking', thinking: 'Let me look' }] },
  },
  {
    type: 'stream_event',
    event: { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
  },
  {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Fix' } },
  },
  {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ing.' } },
  },
  { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } },
  { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Fixing.' }] } },
  {
    type: 'stream_event',
    event: {
      type: 'content_block_start',
      index: 2,
      content_block: { type: 'tool_use', id: 't-edit', name: 'Edit', input: {} },
    },
  },
  { type: 'stream_event', event: { type: 'content_block_stop', index: 2 } },
  {
    type: 'assistant',
    message: {
      id: 'm1',
      content: [
        {
          type: 'tool_use',
          id: 't-edit',
          name: 'Edit',
          input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' },
        },
      ],
    },
  },
  {
    type: 'user',
    message: {
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 't-edit', content: 'String not found', is_error: true },
      ],
    },
  },
  {
    type: 'assistant',
    message: {
      id: 'm2',
      content: [
        {
          type: 'tool_use',
          id: 't-todo',
          name: 'TodoWrite',
          input: {
            todos: [
              { content: 'Read', status: 'completed', activeForm: 'Reading' },
              { content: 'Fix', status: 'in_progress', activeForm: 'Fixing' },
              { content: 'Test', status: 'odd' },
            ],
          },
        },
        {
          type: 'tool_use',
          id: 't-task',
          name: 'Task',
          input: { description: 'Look around', prompt: 'p', subagent_type: 'Explore' },
        },
      ],
    },
  },
  // The subagent's own output, nested under the call that started it.
  {
    type: 'assistant',
    parent_tool_use_id: 't-task',
    message: {
      id: 'sub1',
      content: [
        { type: 'tool_use', id: 't-grep', name: 'Grep', input: { pattern: 'TODO', path: 'src' } },
      ],
    },
  },
  {
    type: 'user',
    parent_tool_use_id: 't-task',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 't-grep',
          content: [
            { type: 'text', text: 'src/a.ts:1' },
            { type: 'image', source: {} },
          ],
        },
      ],
    },
  },
  {
    type: 'assistant',
    message: {
      id: 'm3',
      content: [
        { type: 'tool_use', id: 't-mcp', name: 'mcp__abele__node_sessions', input: {} },
        {
          type: 'tool_use',
          id: 't-big',
          name: 'Write',
          input: { file_path: 'big.txt', content: 'x'.repeat(200_000) },
        },
      ],
    },
  },
  { type: 'system', subtype: 'status', status: 'compacting' },
  {
    type: 'system',
    subtype: 'status',
    status: null,
    compact_result: 'failed',
    compact_error: 'too short',
  },
  { type: 'system', subtype: 'status', status: null, permissionMode: 'plan' },
  {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'auto', pre_tokens: 9000, post_tokens: 700 },
  },
  { type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } },
  { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_800_000_000 } },
]

describe('Claude records as session updates', () => {
  const mapper = new ClaudeEventMapper()
  const updates = records.flatMap((r) =>
    mapper.map(r).flatMap((e) => claudeSessionUpdates(e.type, e.data))
  )

  it('maps every record into valid updates in order', () => {
    for (const update of updates)
      expect(SessionUpdateEventSchema.parse({ update }).update).toEqual(update)
    expect(updates.map((u) => u.kind)).toEqual([
      'available_commands_update',
      'current_mode_update',
      'config_option_update',
      'agent_thought_chunk',
      'agent_thought',
      'agent_message_chunk',
      'agent_message_chunk',
      'agent_message',
      'tool_call',
      'tool_call_update',
      'tool_call',
      'plan',
      'tool_call',
      'tool_call',
      'tool_call_update',
      'tool_call',
      'tool_call',
      'compaction_update',
      'compaction_update',
      'current_mode_update',
      'compaction_update',
      'notice',
    ])
  })

  it('offers the commands the session can run, once each', () => {
    expect(updates[0]).toEqual({
      kind: 'available_commands_update',
      commands: [
        { name: 'compact', description: null, source: 'builtin' },
        { name: 'review', description: null, source: 'skill' },
      ],
    })
    expect(updates.slice(1, 3)).toEqual([
      { kind: 'current_mode_update', mode_id: 'default' },
      {
        kind: 'config_option_update',
        options: [
          { id: 'model', name: 'Model', category: 'model', current_value: 'claude-sonnet' },
        ],
      },
    ])
  })

  it('streams text and thoughts per block, and the final one replaces only its own block', () => {
    const top = { message_id: 'm1', parent_tool_call_id: null }
    expect(updates.slice(3, 8)).toEqual([
      { kind: 'agent_thought_chunk', ...top, block: 0, text: 'Let me look' },
      { kind: 'agent_thought', ...top, block: 0, text: 'Let me look' },
      { kind: 'agent_message_chunk', ...top, block: 1, text: 'Fix' },
      { kind: 'agent_message_chunk', ...top, block: 1, text: 'ing.' },
      { kind: 'agent_message', ...top, block: 1, text: 'Fixing.' },
    ])
  })

  it('shows an edit as a diff on its file, and its failure', () => {
    expect(updates[8]).toEqual({
      kind: 'tool_call',
      tool_call_id: 't-edit',
      tool_kind: 'edit',
      title: 'Edit src/a.ts',
      locations: [{ path: 'src/a.ts', line: null }],
      content: [{ type: 'diff', path: 'src/a.ts', old_text: 'a', new_text: 'b' }],
      status: 'pending',
      name: 'Edit',
      raw_input: { file_path: 'src/a.ts', old_string: 'a', new_string: 'b' },
      parent_tool_call_id: null,
    })
    expect(updates[9]).toEqual({
      kind: 'tool_call_update',
      tool_call_id: 't-edit',
      status: 'failed',
      content: [{ type: 'content', text: 'String not found' }],
    })
  })

  it('turns the todo list into the plan, and nests a subagent under its call', () => {
    expect(updates[11]).toEqual({
      kind: 'plan',
      entries: [
        { content: 'Read', status: 'completed', priority: 'medium' },
        { content: 'Fix', status: 'in_progress', priority: 'medium' },
        { content: 'Test', status: 'pending', priority: 'medium' },
      ],
    })
    expect(updates[12]).toMatchObject({ tool_kind: 'think', title: 'Look around' })
    expect(updates[13]).toMatchObject({
      tool_call_id: 't-grep',
      tool_kind: 'search',
      title: 'Search TODO',
      locations: [{ path: 'src', line: null }],
      parent_tool_call_id: 't-task',
    })
    expect(updates[14]).toMatchObject({
      tool_call_id: 't-grep',
      status: 'completed',
      content: [{ type: 'content', text: 'src/a.ts:1\n[image]' }],
    })
    expect(updates[15]).toMatchObject({ tool_kind: 'other', title: 'abele: node_sessions' })
  })

  it('keeps a huge write inside one journal record', () => {
    const big = updates[16]!
    expect(JSON.stringify(big).length).toBeLessThan(96 * 1024)
    expect(big).not.toHaveProperty('raw_input')
    expect(big).toMatchObject({
      kind: 'tool_call',
      title: 'Write big.txt',
      content: [{ type: 'diff', path: 'big.txt', old_text: null, truncated: true }],
    })
  })

  it('reports compaction, the mode the CLI switched to, and a refused request', () => {
    expect(updates.slice(17)).toEqual([
      { kind: 'compaction_update', state: 'started' },
      { kind: 'compaction_update', state: 'failed', error: 'too short' },
      { kind: 'current_mode_update', mode_id: 'plan' },
      {
        kind: 'compaction_update',
        state: 'completed',
        trigger: 'auto',
        pre_tokens: 9000,
        post_tokens: 700,
      },
      {
        kind: 'notice',
        level: 'error',
        code: 'rate_limit',
        status: 'rejected',
        resets_at: 1_800_000_000,
        text: 'Usage limit reached, resets 2027-01-15T08:00:00.000Z',
      },
    ])
  })

  it('maps nothing from a record kept as an artifact', () => {
    expect(
      claudeSessionUpdates('claude.message.final', { run_id: 'r', artifact_id: 'a', size: 9 })
    ).toEqual([])
    expect(claudeSessionUpdates('claude.init', { run_id: 'r', artifact_id: 'a', size: 9 })).toEqual(
      []
    )
  })
})
