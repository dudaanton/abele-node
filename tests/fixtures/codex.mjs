#!/usr/bin/env node
// Deterministic app-server double. No credentials, executable discovery or inference.
import { createInterface } from 'node:readline'
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { randomUUID } from 'node:crypto'
const args = process.argv.slice(2)
if (args.includes('--version')) {
  console.log('codex-cli 0.160.1')
  process.exit(0)
}
if (args.includes('--help')) {
  console.log('app-server --listen stdio:// generate-ts')
  process.exit(0)
}
if (args.includes('generate-ts')) {
  const kind = args.includes('--experimental') ? 'experimental' : 'stable'
  const data = JSON.parse(
    gunzipSync(readFileSync(new URL('./codex-0.160.1-schemas.json.gz', import.meta.url)))
  )[kind]
  const out = args[args.indexOf('--out') + 1]
  for (const [name, content] of Object.entries(data)) {
    mkdirSync(dirname(join(out, name)), { recursive: true })
    writeFileSync(join(out, name), content)
  }
  process.exit(0)
}
if (!args.includes('app-server') || !args.includes('stdio://')) process.exit(64)
const home = process.env.CODEX_HOME,
  config = { mcp_servers: {}, plugins: {} }
for (let i = 0; i < args.length; i++)
  if (args[i] === '-c') {
    const override = args[++i],
      at = override.indexOf('=')
    const keys = override
      .slice(0, at)
      .match(/"(?:[^"\\]|\\.)*"|[^.]+/g)
      .map((k) => (k.startsWith('"') ? JSON.parse(k) : k))
    let target = config
    for (const key of keys.slice(0, -1)) target = target[key] ??= {}
    const value = override.slice(at + 1)
    if (value.startsWith('{ ')) {
      const table = {}
      for (const match of value.matchAll(/("(?:[^"\\]|\\.)*") = ("(?:[^"\\]|\\.)*"|true|false)/g))
        table[JSON.parse(match[1])] = JSON.parse(match[2])
      target[keys.at(-1)] = table
    } else target[keys.at(-1)] = JSON.parse(value)
  }
let mode = 'normal'
try {
  mode = JSON.parse(readFileSync(join(home, 'fixture.json'), 'utf8')).mode
} catch {}
const send = (record) => process.stdout.write(JSON.stringify(record) + '\n')
const reply = (id, result) => send({ id, result })
const notify = (method, params) => send({ method, params })
let thread,
  turn,
  waiting = false
const complete = (status = 'completed', text = 'fake response') => {
  if (text)
    notify('item/completed', {
      threadId: thread.id,
      turnId: turn.id,
      item: { id: 'message', type: 'agentMessage', text },
    })
  notify('turn/completed', { threadId: thread.id, turn: { ...turn, status, error: null } })
}
for await (const line of createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line),
    p = msg.params
  if (!msg.method) {
    if (msg.id === 'native-approval' && waiting) {
      waiting = false
      if (!['accept', 'decline', 'cancel'].includes(msg.result?.decision)) process.exit(70)
      appendFileSync(join(home, 'approval-responses.jsonl'), JSON.stringify(msg) + '\n', {
        mode: 0o600,
      })
      if (msg.result.decision === 'accept')
        writeFileSync(join(thread.cwd, 'approved-effect.txt'), 'approved single action', {
          mode: 0o600,
        })
      if (mode === 'approval-crash') process.exit(17)
      complete('completed', msg.result.decision === 'accept' ? 'accepted' : 'declined')
    }
    continue
  }
  if (msg.method === 'initialize')
    reply(msg.id, {
      userAgent: 'codex/0.160.1',
      codexHome: home,
      platformFamily: 'unix',
      platformOs: 'fixture',
    })
  else if (msg.method === 'initialized') {
    if (mode === 'duplicate-response') reply(1, { token: 'never retain' })
    if (mode === 'invalid-utf8') process.stdout.write(Buffer.from([0xff, 10]))
    if (mode === 'truncated') {
      process.stdout.write('{')
      process.exit(0)
    }
    if (mode === 'duplicate-request') {
      send({ id: 'request', method: 'unsupported', params: {} })
      setTimeout(() => send({ id: 'request', method: 'unsupported', params: {} }), 50)
    }
  } else if (msg.method === 'config/read') {
    if (mode === 'timeout') continue
    if (mode === 'crash') process.exit(17)
    reply(msg.id, { config, layers: [] })
  } else if (msg.method === 'configRequirements/read')
    reply(msg.id, { requirements: { allowRemoteControl: false } })
  else if (msg.method === 'account/read')
    reply(msg.id, { account: { type: 'chatgpt' }, requiresOpenaiAuth: true })
  else if (msg.method === 'model/list')
    reply(msg.id, {
      data: [
        {
          id: 'fixture-small',
          model: 'fixture-small',
          hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: 'low' }],
        },
      ],
      nextCursor: null,
    })
  else if (msg.method === 'thread/start' || msg.method === 'thread/resume') {
    if (
      p.path ||
      p.history ||
      p.permissions !== 'abele' ||
      p.approvalPolicy !== 'on-request' ||
      p.approvalsReviewer !== 'user'
    )
      process.exit(70)
    let saved = {}
    try {
      saved = JSON.parse(readFileSync(join(home, 'threads.json'), 'utf8'))
    } catch {}
    if (msg.method === 'thread/resume') {
      if (!saved[p.threadId]) {
        send({ id: msg.id, error: { code: -32000 } })
        continue
      }
      thread = saved[p.threadId]
    } else {
      if (p.ephemeral !== false) process.exit(70)
      thread = { id: `thread-${randomUUID()}`, cwd: p.cwd }
      saved[thread.id] = thread
      writeFileSync(join(home, 'threads.json'), JSON.stringify(saved), { mode: 0o600 })
    }
    if (mode === 'crash-before-binding') process.exit(17)
    if (msg.method === 'thread/resume')
      notify('thread/status/changed', { threadId: thread.id, status: { type: 'idle' } })
    reply(msg.id, {
      thread,
      model: mode === 'model-fallback' ? 'other' : p.model,
      modelProvider: 'openai',
      cwd: p.cwd,
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user',
      activePermissionProfile: { id: 'abele', extends: null },
      runtimeWorkspaceRoots: [p.cwd],
    })
  } else if (msg.method === 'turn/start') {
    const temp = config.shell_environment_policy?.set?.TMPDIR
    if (
      typeof temp !== 'string' ||
      !statSync(temp).isDirectory() ||
      !readFileSync(join(temp, '.gitignore'), 'utf8').includes('*')
    )
      process.exit(70)
    if (
      !thread ||
      p.threadId !== thread.id ||
      p.permissions !== 'abele' ||
      p.effort !== 'low' ||
      p.model !== 'fixture-small'
    )
      process.exit(70)
    if (mode === 'crash-after-binding') process.exit(17)
    appendFileSync(join(home, 'turn-log.jsonl'), JSON.stringify(p) + '\n', { mode: 0o600 })
    turn = { id: `turn-${randomUUID()}`, status: 'inProgress' }
    reply(msg.id, { turn })
    notify('turn/started', { threadId: thread.id, turn })
    if (mode === 'crash-after-dispatch') process.exit(17)
    if (mode === 'hang') continue
    if (mode === 'approval' || mode === 'approval-crash') {
      notify('item/started', {
        threadId: thread.id,
        turnId: turn.id,
        item: {
          id: 'command',
          type: 'commandExecution',
          command: 'printf harmless',
          cwd: thread.cwd,
          status: 'inProgress',
        },
      })
      waiting = true
      send({
        id: 'native-approval',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: thread.id,
          turnId: turn.id,
          itemId: 'command',
          kind: 'command',
          environmentId: null,
          command: 'printf harmless',
          cwd: thread.cwd,
        },
      })
      continue
    }
    complete()
  } else if (msg.method === 'turn/interrupt') {
    reply(msg.id, {})
    if (turn) complete('interrupted', '')
  } else send({ id: msg.id, error: { code: -32601, message: 'Unsupported fixture method' } })
}
