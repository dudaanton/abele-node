import { expect, afterEach } from 'vitest'
import { processIt as it } from './process-test.js'
import { waitForProcessCondition } from '../scripts/process-test-budget.mjs'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readFileSync,
  cpSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { NodeCore, AcpProviderAdapter } from '@abele/node-core'
import { sessionUpdatesOf } from '@abele/node-protocol'

const until = <T>(test: () => T) => waitForProcessCondition(test, 'ACP agent session')
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function setup(env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'abele-acp-')),
    repo = join(dir, 'repo'),
    bin = join(dir, 'bin'),
    state = join(dir, 'state'),
    executable = join(bin, 'fake-acp')
  mkdirSync(bin)
  mkdirSync(state, { recursive: true, mode: 0o700 })
  cpSync(fileURLToPath(new URL('./fixtures/acp-agent.mjs', import.meta.url)), executable)
  chmodSync(executable, 0o700)
  writeFileSync(
    join(state, 'acp-agents.json'),
    JSON.stringify({ agents: [{ id: 'fake', name: 'Fake', command: executable, env }] })
  )
  mkdirSync(repo)
  const git = (...args: string[]) => {
    const r = spawnSync('/usr/bin/git', args, { cwd: repo, encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
  }
  git('init', '-b', 'main')
  git('config', 'user.name', 'Test')
  git('config', 'user.email', 'test@example.invalid')
  writeFileSync(join(repo, 'file'), 'original')
  git('add', '.')
  git('commit', '-m', 'fixture')
  // An empty PATH: the built-in agents are not installed here.
  const adapter = new AcpProviderAdapter({ stateDir: state, path: bin })
  const core = new NodeCore(state, { acp: adapter })
  const actor = core.authority.authenticate(core.createToken('test').token)
  const request = (method: string, p: unknown) =>
    core.request(actor, method, p, crypto.randomUUID()) as any
  const project = await request('project.register', { path: repo, trust: 'trusted' })
  const job = await request('workspace.create', { project_id: project.project_id })
  await core.resources.jobs.drain()
  const workspace = core.resources.workspaces.get(job.workspace_id)
  let draining: Promise<void> | undefined
  const pump = setInterval(() => {
    draining ??= core.claude.drain().finally(() => (draining = undefined))
  }, 10)
  cleanups.push(async () => {
    clearInterval(pump)
    await draining
    await core.claude.stop()
    await core.resources.stop()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const session = (settings?: Record<string, unknown>, agent = 'fake') =>
    request('session.create', {
      title: 'Agent',
      provider: 'acp',
      agent,
      workspace_id: job.workspace_id,
      ...(settings ? { settings } : {}),
    }).session_id as string
  const events = (session_id: string, type?: string) => {
    const all: any[] = []
    for (let after = 0; ;) {
      const page = core.read(session_id, after, 256)
      if (!page.length) break
      all.push(...page)
      after = page.at(-1)!.seq
    }
    return type ? all.filter((e) => e.type === type) : all
  }
  const send = (session_id: string, text: string) =>
    request('session.send', { session_id, text, observed_seq: 0 }).input_id as string
  const input = (input_id: string) =>
    core.db.prepare('SELECT state, run_id FROM inputs WHERE input_id=?').get(input_id) as {
      state: string
      run_id: string
    }
  const calls = () =>
    existsSync(join(workspace.path, 'acp-calls.jsonl'))
      ? readFileSync(join(workspace.path, 'acp-calls.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : []
  const answer = (session_id: string, choice: 'allow' | 'deny') => {
    const prompt = core.prompts(session_id).find((p) => p.state === 'pending')!
    request('prompt.answer', {
      session_id,
      prompt_id: prompt.prompt_id,
      run_id: prompt.run_id,
      revision: 1,
      action_digest: prompt.action_digest,
      choice,
    })
    return prompt
  }
  const updates = (session_id: string, kind?: string) =>
    events(session_id)
      .flatMap((e) => sessionUpdatesOf(e))
      .filter((u: any) => !kind || u.kind === kind) as any[]
  return { core, adapter, request, session, events, updates, send, input, calls, answer }
}

it('runs an ACP agent as one long-lived process and journals its updates in the shared vocabulary', async () => {
  const s = await setup()
  expect(s.adapter.capabilities().agents).toEqual([
    { id: 'gemini', name: 'Gemini CLI', available: false, diagnostic: 'acp_agent_not_installed' },
    { id: 'opencode', name: 'OpenCode', available: false, diagnostic: 'acp_agent_not_installed' },
    { id: 'fake', name: 'Fake', available: true, diagnostic: null },
  ])
  expect(() => s.session(undefined, 'gemini')).toThrow(/provider_unavailable/)
  const id = s.session()
  const first = s.send(id, 'hello')
  await until(() => s.input(first).state === 'completed')
  const second = s.send(id, 'again')
  await until(() => s.input(second).state === 'completed')
  expect(s.input(first).run_id).toBe(s.input(second).run_id)
  expect(new Set(s.calls().map((c) => c.pid)).size).toBe(1)
  const init = s.calls().find((c) => c.method === 'initialize')!.params
  expect(init.clientCapabilities).toEqual({
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
  })

  expect(s.events(id, 'turn.started')).toHaveLength(2)
  expect(s.events(id, 'turn.completed').map((e) => e.data.outcome)).toEqual(['success', 'success'])
  const messages = s.updates(id, 'agent_message')
  expect(messages.map((u) => u.text)).toEqual(['Hi there', 'Hi there'])
  const chunks = s.updates(id, 'agent_message_chunk')
  expect(chunks.map((u) => u.text)).toEqual(['Hi ', 'there', 'Hi ', 'there'])
  // A chunk and the whole message it belongs to carry one id; each message its own.
  expect(chunks[0].message_id).toBe(messages[0].message_id)
  expect(chunks[1].message_id).toBe(messages[0].message_id)
  expect(messages[0].message_id).not.toBe(messages[1].message_id)
  expect(s.updates(id, 'agent_thought').map((u) => u.text)).toEqual(['Thinking', 'Thinking'])
  expect(s.updates(id, 'plan')[0].entries).toEqual([
    { content: 'Answer', priority: 'high', status: 'in_progress' },
  ])
  expect(s.request('session.commands', { session_id: id }).commands).toEqual([
    { name: 'compact', description: 'Compact the context', input_hint: null },
  ])
  expect(s.updates(id, 'current_mode_update')[0].mode_id).toBe('default')
  expect(s.updates(id, 'config_option_update')[0].options).toEqual([
    { id: 'model', name: 'Model', category: 'model', current_value: 'fake-1' },
  ])
  // The meter comes once per report, from the node's context event.
  expect(s.updates(id, 'usage_update')).toEqual([
    { kind: 'usage_update', used_tokens: 5000, max_tokens: 100000, percentage: 5 },
    { kind: 'usage_update', used_tokens: 5000, max_tokens: 100000, percentage: 5 },
  ])
  // Every record the node mapped says so, for clients that map old journals themselves; the
  // agent's usage report maps to nothing (the node's context event carries it).
  for (const e of s.events(id, 'acp.update'))
    expect(e.data.mapped === true).toBe(e.data.update.sessionUpdate !== 'usage_update')
  expect(s.events(id, 'session.context').at(-1)!.data).toMatchObject({
    total_tokens: 5000,
    max_tokens: 100000,
    percentage: 5,
    model: 'fake-1',
  })
  // Lifecycle records are read by the node, not journaled.
  expect(s.events(id).some((e) => e.type.startsWith('live.'))).toBe(false)
  const session = s.core.session(id)
  expect(session.agent).toBe('fake')
  expect(session.native_session_id).toMatch(/^ses_/)
  expect(s.request('session.state', { session_id: id })).toMatchObject({
    live: true,
    process: 'idle',
  })
})

it('asks the owner before a tool runs, answers once, and never gives an "always" answer', async () => {
  const s = await setup()
  const id = s.session()
  const allowed = s.send(id, 'tool')
  await until(() => s.core.prompts(id).some((p) => p.state === 'pending'))
  const prompt = s.answer(id, 'allow')
  expect(prompt).toMatchObject({
    tool_use_id: 'call_1',
    tool_name: 'edit',
    title: 'Edit file',
    options: ['Allow', 'Reject'],
    input: { path: 'file' },
  })
  await until(() => s.input(allowed).state === 'completed')
  const denied = s.send(id, 'tool')
  await until(() => s.core.prompts(id).some((p) => p.state === 'pending'))
  s.answer(id, 'deny')
  await until(() => s.input(denied).state === 'completed')
  expect(
    s
      .calls()
      .filter((c) => c.permission)
      .map((c) => c.permission)
  ).toEqual([
    { outcome: 'selected', optionId: 'once' },
    { outcome: 'selected', optionId: 'no' },
  ])
  expect(s.updates(id, 'tool_call_update').map((u) => [u.tool_call_id, u.status])).toEqual([
    ['call_1', 'completed'],
    ['call_2', 'failed'],
  ])
  expect(s.events(id, 'acp.permission').map((e) => [e.data.decision, e.data.by])).toEqual([
    ['allowed', 'owner'],
    ['rejected', 'owner'],
  ])
  expect(s.updates(id, 'notice').map((u) => [u.level, u.code, u.text])).toEqual([
    ['info', 'permission_allowed', 'Allowed by the owner: Edit file'],
    ['warning', 'permission_rejected', 'Rejected by the owner: Edit file'],
  ])
  expect(s.events(id, 'prompt.delivered')).toHaveLength(1)
})

it('in bypass mode allows single actions itself and journals each one', async () => {
  const s = await setup()
  const id = s.session({ permission_mode: 'bypassPermissions' })
  const asked = s.send(id, 'tool')
  await until(() => s.input(asked).state === 'completed')
  expect(s.core.prompts(id)).toHaveLength(0)
  expect(s.updates(id, 'tool_call')[0]).toEqual({
    kind: 'tool_call',
    tool_call_id: 'call_1',
    title: 'Edit file',
    tool_kind: 'edit',
    status: 'pending',
    locations: [{ path: 'file', line: null }],
    raw_input: { path: 'file' },
  })
  expect(s.updates(id, 'notice')[0]).toEqual({
    kind: 'notice',
    level: 'info',
    text: 'Allowed by the session mode: Edit file',
    code: 'permission_allowed',
  })
  expect(s.calls().find((c) => c.permission).permission.optionId).toBe('once')
  expect(() => s.session({ permission_mode: 'acceptEdits' })).toThrow(/invalid_params/)
})

it('interrupts a turn and keeps the process; a stop ends it and the next message loads the session again', async () => {
  const s = await setup()
  const id = s.session()
  const slow = s.send(id, 'wait')
  await until(() => s.input(slow).state === 'delivered')
  const run_id = s.input(slow).run_id
  expect(s.request('session.interrupt', { session_id: id, run_id })).toMatchObject({
    state: 'interrupting',
  })
  await until(() => s.input(slow).state === 'interrupted')
  expect(s.events(id, 'turn.completed')[0]!.data).toMatchObject({
    outcome: 'interrupted',
    subtype: 'cancelled',
  })
  const after = s.send(id, 'after')
  await until(() => s.input(after).state === 'completed')
  expect(new Set(s.calls().map((c) => c.pid)).size).toBe(1)

  const hung = s.send(id, 'wait')
  await until(() => s.input(hung).state === 'delivered')
  expect(s.request('session.stop', { session_id: id })).toMatchObject({ state: 'stopping' })
  await until(() => s.events(id, 'session.process').some((e) => e.data.state === 'exited'))
  expect(s.events(id, 'session.process').find((e) => e.data.state === 'exited')!.data.reason).toBe(
    'stopped_by_owner'
  )
  expect(s.input(hung).state).toBe('interrupted')
  const native = s.core.session(id).native_session_id
  const resumed = s.send(id, 'resumed')
  await until(() => s.input(resumed).state === 'completed')
  expect(new Set(s.calls().map((c) => c.pid)).size).toBe(2)
  const load = s.calls().find((c) => c.method === 'session/load')!
  expect(load.params.sessionId).toBe(native)
  expect(s.calls().filter((c) => c.method === 'session/new')).toHaveLength(1)
  // What the agent replays on load is already in the journal.
  expect(s.updates(id, 'agent_message_chunk').some((u) => u.text === 'replayed')).toBe(false)
})

it('starts a new agent session, and says so, when the agent cannot load the earlier one', async () => {
  const s = await setup({ ACP_FAKE_NO_LOAD: '1' })
  const id = s.session()
  const first = s.send(id, 'hello')
  await until(() => s.input(first).state === 'completed')
  const before = s.core.session(id).native_session_id
  s.request('session.stop', { session_id: id })
  await until(() => s.request('session.state', { session_id: id }).process === 'none')
  const second = s.send(id, 'hello')
  await until(() => s.input(second).state === 'completed')
  expect(s.calls().filter((c) => c.method === 'session/new')).toHaveLength(2)
  expect(s.core.session(id).native_session_id).not.toBe(before)
  expect(s.updates(id, 'notice').at(-1)).toMatchObject({
    level: 'warning',
    code: 'acp_resume_unsupported',
  })
})
