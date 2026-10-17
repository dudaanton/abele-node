import { describe, expect, it } from 'vitest'
import {
  commandText,
  isKnownSessionUpdate,
  MethodSchemas,
  NodeEventSchema,
  SESSION_UPDATE_KINDS,
  SessionUpdateEventSchema,
  type SessionUpdate,
} from '../src/index.js'

const event = (type: string, data: unknown) => ({
  kind: 'event',
  node_id: 'node-fixture',
  stream_id: 'session-fixture',
  seq: 1,
  type,
  actor: { kind: 'provider', provider: 'claude', session_id: 'session-fixture' },
  at: '2026-10-16T00:00:00.000Z',
  data,
})

const samples: SessionUpdate[] = [
  {
    kind: 'debugger_access_requested',
    version: 1,
    request_id: 'request-1',
    installation_id: 'installation-1',
    run_id: 'r1',
    task_id: 'task-1',
    conversation_id: 'session-fixture',
    workspace_id: null,
    target_id: 'target-1',
    debug_session_id: 'debug-1',
    incarnation: 'incarnation-1',
    expires_at: '2026-10-16T01:00:00.000Z',
    actions: ['read'],
    method: 'status',
    access: 'read',
    target: {
      node_id: 'node-fixture',
      project_id: 'project-1',
      workspace_id: null,
      worktree_id: 'worktree-1',
      conversation_id: 'session-fixture',
      target_id: 'target-1',
      adapter_profile: 'js',
      adapter_version: '1',
      launch_configuration_id: 'launch-1',
      process_ownership: 'unknown',
      build_identity: 'unknown',
    },
    folder: null,
    program: 'config',
  },
  { kind: 'user_message', message_id: 'u1', text: 'hi' },
  {
    kind: 'agent_message_chunk',
    message_id: 'm1',
    block: 0,
    text: 'Hel',
    parent_tool_call_id: null,
  },
  { kind: 'agent_message', message_id: 'm1', block: 0, text: 'Hello' },
  { kind: 'agent_thought_chunk', message_id: 'm1', block: 1, text: 'hmm' },
  { kind: 'agent_thought', message_id: 'm1', block: 1, text: '', redacted: true },
  {
    kind: 'tool_call',
    tool_call_id: 't1',
    title: 'Edit a.ts',
    status: 'pending',
    locations: [{ path: 'a.ts', line: 3 }],
    content: [{ type: 'diff', path: 'a.ts', old_text: 'a', new_text: 'b' }],
    name: 'Edit',
    raw_input: { file_path: 'a.ts' },
    parent_tool_call_id: null,
  },
  {
    kind: 'tool_call_update',
    tool_call_id: 't1',
    status: 'completed',
    content: [{ type: 'content', text: 'ok' }],
  },
  {
    kind: 'plan',
    entries: [{ content: 'Write the schema', priority: 'high', status: 'in_progress' }],
  },
  { kind: 'current_mode_update', mode_id: 'plan' },
  {
    kind: 'available_commands_update',
    commands: [{ name: 'compact', description: null, source: 'builtin' }],
  },
  {
    kind: 'config_option_update',
    options: [{ id: 'model', name: 'Model', category: 'model', current_value: 'sonnet' }],
  },
  { kind: 'usage_update', used_tokens: 1200, max_tokens: 200000, percentage: 0.6 },
  {
    kind: 'compaction_update',
    state: 'completed',
    trigger: 'manual',
    pre_tokens: 9,
    post_tokens: 1,
  },
  { kind: 'compaction_summary', text: 'Summary' },
  { kind: 'notice', level: 'warning', text: 'Rate limited' },
]
describe('session.update', () => {
  it('round-trips every known kind through the journal envelope', () => {
    expect(new Set(samples.map((s) => s.kind))).toEqual(new Set(SESSION_UPDATE_KINDS))
    for (const update of samples) {
      const stored = JSON.parse(JSON.stringify(event('session.update', { run_id: 'r1', update })))
      expect(NodeEventSchema.parse(stored)).toEqual(stored)
      expect(SessionUpdateEventSchema.parse(stored.data)).toEqual({ run_id: 'r1', update })
      expect(isKnownSessionUpdate(update)).toBe(true)
    }
  })

  it('keeps a kind or a field from a newer node instead of refusing it', () => {
    const future = { kind: 'subagent_update', child: { id: 'x' } }
    const parsed = SessionUpdateEventSchema.parse({ update: future })
    expect(parsed.update).toEqual(future)
    expect(isKnownSessionUpdate(parsed.update)).toBe(false)
    expect(NodeEventSchema.safeParse(event('session.update', { update: future })).success).toBe(
      true
    )
    // A known kind with an extra field still parses; the field is not needed to render it.
    expect(
      SessionUpdateEventSchema.safeParse({ update: { kind: 'plan', entries: [], v2_field: 1 } })
        .success
    ).toBe(true)
  })

  it('refuses a known kind that is malformed', () => {
    expect(
      NodeEventSchema.safeParse(
        event('session.update', { update: { kind: 'tool_call', tool_call_id: 't1' } })
      ).success
    ).toBe(false)
    expect(
      NodeEventSchema.safeParse(
        event('session.update', { update: { kind: 'tool_call_update', status: 'done' } })
      ).success
    ).toBe(false)
  })

  it('leaves the journals written before it readable', () => {
    for (const [type, data] of [
      ['claude.block.delta', { message_id: 'm', index: 0, text: 'x', parent_tool_use_id: null }],
      ['claude.tool.call', { tool_use_id: 't', name: 'Bash', input: {}, run_id: 'r' }],
      ['turn.started', { run_id: 'r', turn_id: 't', trigger: 'input' }],
    ] as const)
      expect(NodeEventSchema.safeParse(event(type, data)).success).toBe(true)
  })

  it('lists commands per session and writes the text that runs one', () => {
    expect(MethodSchemas['session.commands'].parse({ session_id: 's' })).toEqual({
      session_id: 's',
    })
    expect(commandText('compact')).toBe('/compact')
    expect(commandText('code-review', '  high ')).toBe('/code-review high')
    expect(commandText('commit-commands:commit')).toBe('/commit-commands:commit')
    expect(() => commandText('/compact')).toThrow()
    expect(() => commandText('two words')).toThrow()
  })
})
