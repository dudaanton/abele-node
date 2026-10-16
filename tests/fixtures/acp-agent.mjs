#!/usr/bin/env node
// A fake ACP agent speaking recorded frames over stdio. What it was asked is appended to
// acp-calls.jsonl in its working directory.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const log = (entry) =>
  appendFileSync(
    join(process.cwd(), 'acp-calls.jsonl'),
    JSON.stringify({ pid: process.pid, ...entry }) + '\n'
  )
const send = (message) =>
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n')
const update = (sessionId, u) =>
  send({ method: 'session/update', params: { sessionId, update: u } })
let nextId = 1000
const waiting = new Map()
const ask = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++
    waiting.set(id, resolve)
    send({ id, method, params })
  })
let cancel
let calls = 0
const loadSession = process.env.ACP_FAKE_NO_LOAD !== '1'

async function prompt(sessionId, blocks) {
  const text = blocks.map((b) => b.text ?? '').join('\n')
  if (text.includes('wait')) {
    update(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Waiting' },
    })
    await new Promise((resolve) => (cancel = resolve))
    return { stopReason: 'cancelled' }
  }
  if (text.includes('tool')) {
    const toolCallId = `call_${++calls}`
    update(sessionId, {
      sessionUpdate: 'tool_call',
      toolCallId,
      title: 'Edit file',
      kind: 'edit',
      status: 'pending',
      locations: [{ path: 'file' }],
      rawInput: { path: 'file' },
    })
    const answer = await ask('session/request_permission', {
      sessionId,
      toolCall: { toolCallId, title: 'Edit file', kind: 'edit', rawInput: { path: 'file' } },
      options: [
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'once', name: 'Allow', kind: 'allow_once' },
        { optionId: 'no', name: 'Reject', kind: 'reject_once' },
      ],
    })
    log({ permission: answer.outcome })
    const allowed = answer.outcome?.outcome === 'selected' && answer.outcome.optionId === 'once'
    update(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId,
      status: allowed ? 'completed' : 'failed',
    })
    if (answer.outcome?.outcome === 'cancelled') return { stopReason: 'cancelled' }
  }
  update(sessionId, {
    sessionUpdate: 'available_commands_update',
    availableCommands: [{ name: 'compact', description: 'Compact the context' }],
  })
  update(sessionId, {
    sessionUpdate: 'plan',
    entries: [{ content: 'Answer', priority: 'high', status: 'in_progress' }],
  })
  update(sessionId, {
    sessionUpdate: 'agent_thought_chunk',
    content: { type: 'text', text: 'Thinking' },
  })
  update(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'Hi ' },
  })
  update(sessionId, {
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'there' },
  })
  update(sessionId, { sessionUpdate: 'usage_update', used: 5000, size: 100000 })
  return { stopReason: 'end_turn' }
}

const methods = {
  initialize: () => ({
    protocolVersion: 1,
    agentCapabilities: { loadSession },
    authMethods: [],
  }),
  'session/new': () => ({
    sessionId: 'ses_' + randomUUID().replaceAll('-', ''),
    modes: { currentModeId: 'default', availableModes: [{ id: 'default', name: 'Default' }] },
    configOptions: [
      { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'fake-1' },
    ],
  }),
  'session/load': (params) => {
    // The whole history comes back first; a client that journals it again doubles it.
    update(params.sessionId, {
      sessionUpdate: 'user_message_chunk',
      content: { type: 'text', text: 'old' },
    })
    update(params.sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'replayed' },
    })
    return {}
  },
  'session/set_config_option': () => ({ configOptions: [] }),
  'session/prompt': (params) => prompt(params.sessionId, params.prompt),
}

let buffered = ''
process.stdin.on('data', (chunk) => {
  buffered += chunk
  let at
  while ((at = buffered.indexOf('\n')) >= 0) {
    const line = buffered.slice(0, at)
    buffered = buffered.slice(at + 1)
    if (!line.trim()) continue
    const message = JSON.parse(line)
    if (message.method) log({ method: message.method, params: message.params })
    if (message.method === 'session/cancel') {
      cancel?.()
      continue
    }
    if (message.method && message.id !== undefined) {
      const handler = methods[message.method]
      if (!handler) {
        send({ id: message.id, error: { code: -32601, message: 'not found' } })
        continue
      }
      Promise.resolve(handler(message.params)).then((result) => send({ id: message.id, result }))
    } else if (message.id !== undefined && waiting.has(message.id)) {
      waiting.get(message.id)(message.result)
      waiting.delete(message.id)
    }
  }
})
process.stdin.on('end', () => process.exit(0))
// Something an agent prints that is not a frame.
process.stdout.write('fake agent ready\n')
