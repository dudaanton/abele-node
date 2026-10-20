import { expect, it } from 'vitest'
import { piSessionUpdates, sessionUpdatesOf } from '@abele/node-protocol'

// pi's records in the shared transcript vocabulary.
const provider = { kind: 'provider', provider: 'pi' }
it('shows a post-answer hook failure as a named warning', () => {
  expect(
    piSessionUpdates('pi.extension.warning', {
      extension: '/extensions/status.ts',
      event: 'agent_end',
      error: 'status unavailable',
    })
  ).toEqual([
    {
      kind: 'notice',
      level: 'warning',
      code: 'extension_warning',
      text: 'pi extension /extensions/status.ts failed (agent_end): status unavailable',
    },
  ])
})

it('maps streamed and final text and reasoning by message and block', () => {
  const d = { message_id: 'ab-1', runtime_generation: 1 }
  expect(
    piSessionUpdates('pi.message.delta', {
      ...d,
      delta: { type: 'text_delta', contentIndex: 1, delta: 'Hel' },
    })
  ).toEqual([{ kind: 'agent_message_chunk', message_id: '1:ab-1', block: 1, text: 'Hel' }])
  expect(
    piSessionUpdates('pi.message.delta', {
      ...d,
      delta: { type: 'thinking_delta', contentIndex: 0, delta: 'hmm' },
    })
  ).toEqual([{ kind: 'agent_thought_chunk', message_id: '1:ab-1', block: 0, text: 'hmm' }])
  expect(
    piSessionUpdates('pi.message.final', {
      ...d,
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '', redacted: true },
          { type: 'text', text: 'Hello' },
          { type: 'toolCall', id: 't', name: 'read', arguments: {} },
        ],
      },
    })
  ).toEqual([
    { kind: 'agent_thought', message_id: '1:ab-1', block: 0, text: '', redacted: true },
    { kind: 'agent_message', message_id: '1:ab-1', block: 1, text: 'Hello' },
  ])
  expect(
    piSessionUpdates('pi.message.final', { ...d, message: { role: 'user', content: [] } })
  ).toEqual([])
})

it('maps built-in tools to kinds, titles, locations and diffs, and their results', () => {
  expect(
    piSessionUpdates('pi.tool.call', {
      tool_use_id: 't1',
      name: 'edit',
      input: { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }] },
    })
  ).toEqual([
    {
      kind: 'tool_call',
      tool_call_id: 't1',
      tool_kind: 'edit',
      title: 'Edit src/a.ts',
      locations: [{ path: 'src/a.ts', line: null }],
      content: [{ type: 'diff', path: 'src/a.ts', old_text: 'a', new_text: 'b' }],
      status: 'in_progress',
      name: 'edit',
      raw_input: { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }] },
      parent_tool_call_id: null,
    },
  ])
  const bash = piSessionUpdates('pi.tool.call', {
    tool_use_id: 't2',
    name: 'bash',
    input: { command: 'npm test\nmore' },
  })[0]
  expect(bash).toMatchObject({ tool_kind: 'execute', title: 'npm test' })
  expect(
    piSessionUpdates('pi.tool.call', { tool_use_id: 't3', name: 'node_sessions', input: {} })[0]
  ).toMatchObject({ tool_kind: 'other', title: 'node_sessions' })
  expect(
    piSessionUpdates('pi.tool.result', {
      tool_use_id: 't2',
      is_error: true,
      result: { content: [{ type: 'text', text: 'exit 1' }] },
    })
  ).toEqual([
    {
      kind: 'tool_call_update',
      tool_call_id: 't2',
      status: 'failed',
      content: [{ type: 'content', text: 'exit 1' }],
    },
  ])
})

it('maps compaction start and failure, model choice and notices; a finished compaction is the node event', () => {
  expect(piSessionUpdates('pi.compaction_start', { reason: 'threshold' })).toEqual([
    { kind: 'compaction_update', state: 'started', trigger: 'auto' },
  ])
  expect(
    piSessionUpdates('pi.compaction_end', { reason: 'manual', result: { summary: 'S' } })
  ).toEqual([])
  expect(piSessionUpdates('pi.compaction_end', { reason: 'manual', aborted: true })).toEqual([
    { kind: 'compaction_update', state: 'failed', trigger: 'manual', error: 'aborted' },
  ])
  expect(piSessionUpdates('pi.model.selected', { model_id: 'm1' })[0]).toMatchObject({
    kind: 'config_option_update',
    options: [{ id: 'model', current_value: 'm1' }],
  })
  expect(piSessionUpdates('pi.ui.notification', { message: 'hi', level: 'warning' })).toEqual([
    { kind: 'notice', level: 'warning', text: 'hi' },
  ])
})

it('maps the session commands into the shared list, leaving out names it cannot carry', () => {
  expect(
    piSessionUpdates('pi.commands', {
      commands: [
        { name: 'compact', description: 'Compact', source: 'builtin' },
        { name: 'two words', description: null, source: 'extension' },
        { name: 'skill:review', source: 'skill' },
        { name: 'compact', description: 'again', source: 'prompt' },
      ],
    })
  ).toEqual([
    {
      kind: 'available_commands_update',
      commands: [
        { name: 'compact', description: 'Compact', source: 'builtin' },
        { name: 'skill:review', description: null, source: 'skill' },
      ],
    },
  ])
})

it('replays an old pi journal record through the registry, and skips a mapped one', () => {
  const data = {
    run_id: 'r1',
    message_id: '1',
    runtime_generation: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: 'old' }] },
  }
  expect(sessionUpdatesOf({ type: 'pi.message.final', actor: provider, data })).toEqual([
    { kind: 'agent_message', message_id: 'r1:1:1', block: 0, text: 'old' },
  ])
  expect(
    sessionUpdatesOf({ type: 'pi.message.final', actor: provider, data: { ...data, mapped: true } })
  ).toEqual([])
})
