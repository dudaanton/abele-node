import { expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import {
  readAgentConfig,
  discoverAgents,
  AcpEventMapper,
  AcpConnection,
  AcpRequestError,
} from '@abele/provider-acp'
import { acpSessionUpdates, providerSessionUpdates } from '@abele/node-protocol'

it('lays the owner file over the built-in agents and reports missing commands as unavailable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abele-acp-config-'))
  try {
    const tool = join(dir, 'opencode')
    writeFileSync(tool, '#!/bin/sh\n')
    chmodSync(tool, 0o700)
    writeFileSync(
      join(dir, 'acp-agents.json'),
      JSON.stringify({
        agents: [
          { id: 'gemini', enabled: false },
          { id: 'goose', name: 'Goose', command: 'goose', args: ['acp'] },
        ],
      })
    )
    const agents = discoverAgents(readAgentConfig(dir), dir)
    expect(agents.map((a) => [a.id, a.available, a.diagnostic])).toEqual([
      ['gemini', false, 'acp_agent_disabled'],
      ['opencode', true, null],
      ['goose', false, 'acp_agent_not_installed'],
    ])
    expect(agents[1]!.executable).toBe(tool)
    expect(agents[1]!.args).toEqual(['acp'])
    for (const bad of [
      { agents: [{ id: 'Bad Id', command: 'x' }] },
      { agents: [{ id: 'new' }] },
      { agents: [{ id: 'x', command: 'x', env: { 'A=B': 'c' } }] },
      { nope: true },
    ]) {
      writeFileSync(join(dir, 'acp-agents.json'), JSON.stringify(bad))
      expect(() => readAgentConfig(dir)).toThrow('acp_agents_invalid')
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it('maps recorded session/update frames into session updates, one message id per streamed message', () => {
  const records: { type: string; data: any }[] = []
  const recorder = new AcpEventMapper((e) => records.push(e))
  const frames = [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo' } },
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Hmm' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Let me ' } },
    { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'look.' } },
    {
      sessionUpdate: 'tool_call',
      toolCallId: 't1',
      title: 'Edit README.md',
      kind: 'edit',
      status: 'pending',
      locations: [{ path: '/w/README.md', line: 1 }],
      content: [
        { type: 'diff', path: '/w/README.md', oldText: 'a', newText: 'b' },
        { type: 'terminal', terminalId: 'x' },
      ],
      rawInput: { path: '/w/README.md' },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 't1',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'done' } }],
    },
    {
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'web', description: 'Search', input: { hint: 'query' } },
        { name: '/init', description: 'Init' },
        { name: 'bad name', description: 'x' },
      ],
    },
    {
      sessionUpdate: 'config_option_update',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          currentValue: 'm1',
          options: [{ group: 'g', options: [{ value: 'm1', name: 'M one' }] }],
        },
        { id: 'x', name: 'X', category: '_custom', currentValue: 'on' },
      ],
    },
    { sessionUpdate: 'compaction_summary_chunk', content: { type: 'text', text: 'So far' } },
    { sessionUpdate: 'notice', level: 'warning', message: 'Rate limited' },
    { sessionUpdate: 'usage_update', used: 10, size: 100 },
    { sessionUpdate: 'something_new', x: 1 },
  ]
  for (const frame of frames) recorder.update(frame)
  recorder.flush()
  const updates = records.flatMap((r) => acpSessionUpdates(r.type, r.data))
  const message = updates.find((u) => u.kind === 'agent_message') as any
  expect(updates).toEqual([
    { kind: 'agent_thought_chunk', message_id: expect.any(String), text: 'Hmm' },
    { kind: 'agent_thought', message_id: expect.any(String), text: 'Hmm' },
    { kind: 'agent_message_chunk', message_id: message.message_id, text: 'Let me ' },
    { kind: 'agent_message_chunk', message_id: message.message_id, text: 'look.' },
    { kind: 'agent_message', message_id: message.message_id, text: 'Let me look.' },
    {
      kind: 'tool_call',
      tool_call_id: 't1',
      title: 'Edit README.md',
      tool_kind: 'edit',
      status: 'pending',
      locations: [{ path: '/w/README.md', line: 1 }],
      content: [{ type: 'diff', path: '/w/README.md', old_text: 'a', new_text: 'b' }],
      raw_input: { path: '/w/README.md' },
    },
    {
      kind: 'tool_call_update',
      tool_call_id: 't1',
      status: 'completed',
      content: [{ type: 'content', text: 'done' }],
    },
    {
      kind: 'available_commands_update',
      commands: [
        { name: 'web', description: 'Search', input_hint: 'query' },
        { name: 'init', description: 'Init', input_hint: null },
      ],
    },
    {
      kind: 'config_option_update',
      options: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          current_value: 'm1',
          options: [{ value: 'm1', name: 'M one' }],
        },
        { id: 'x', name: 'X', category: 'other', current_value: 'on' },
      ],
    },
    { kind: 'compaction_summary', text: 'So far' },
    { kind: 'notice', level: 'warning', text: 'Rate limited' },
  ])
  // Every update is valid for the journal, and the registry routes `acp` records here.
  for (const r of records)
    expect(providerSessionUpdates('acp', r.type, r.data)).toEqual(acpSessionUpdates(r.type, r.data))
  expect(records.some((r) => JSON.stringify(r.data).includes('echo'))).toBe(false)
  // A call too big for one record loses its input first, and stays valid.
  const [big] = providerSessionUpdates('acp', 'acp.update', {
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'x'.repeat(300),
      title: 'Write',
      rawInput: { content: 'y'.repeat(200 * 1024) },
    },
  })
  expect(big).toEqual({ kind: 'tool_call', tool_call_id: 'x'.repeat(256), title: 'Write' })
})
it('answers the agent with method-not-found for what the client does not offer, and skips non-frames', async () => {
  const toClient = new PassThrough(),
    toAgent = new PassThrough()
  const conn = new AcpConnection(toClient, toAgent)
  const written: any[] = []
  toAgent.on('data', (c: Buffer) =>
    c
      .toString()
      .trim()
      .split('\n')
      .forEach((l) => written.push(JSON.parse(l)))
  )
  const call = conn.request('session/new', { cwd: '/w', mcpServers: [] })
  toClient.write('a log line\n')
  toClient.write(
    JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'fs/read_text_file', params: {} }) + '\n'
  )
  toClient.write(
    JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'auth' } }) + '\n'
  )
  await expect(call).rejects.toBeInstanceOf(AcpRequestError)
  expect(written).toEqual([
    { jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: '/w', mcpServers: [] } },
    {
      jsonrpc: '2.0',
      id: 7,
      error: { code: -32601, message: 'Method not supported by this client' },
    },
  ])
})
