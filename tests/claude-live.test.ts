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
import { NodeCore, ClaudeProviderAdapter, type LiveOptions } from '@abele/node-core'
import type { ClaudeOptions } from '@abele/provider-claude'

const until = <T>(test: () => T) => waitForProcessCondition(test, 'long-lived Claude session')
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function setup(options: ClaudeOptions = {}, live: LiveOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'abele-live-')),
    repo = join(dir, 'repo'),
    executable = join(dir, 'claude-live.mjs')
  cpSync(fileURLToPath(new URL('./fixtures/claude-live.mjs', import.meta.url)), executable)
  chmodSync(executable, 0o700)
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
  const adapter = new ClaudeProviderAdapter({ executable, profile: 'isolated', ...options })
  const core = new NodeCore(join(dir, 'state'), { claude: adapter, live })
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
  const cleanup = async () => {
    clearInterval(pump)
    await draining
    await core.claude.stop()
    await core.resources.stop()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
  cleanups.push(cleanup)
  const session = (settings?: Record<string, unknown>) =>
    request('session.create', {
      title: 'Owner',
      provider: 'claude',
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
  const invocations = () =>
    existsSync(join(workspace.path, 'invocations.jsonl'))
      ? readFileSync(join(workspace.path, 'invocations.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l) as { args: string[]; config_dir: string | null; pid: number })
      : []
  const replies = (session_id: string) =>
    events(session_id, 'claude.message.final')
      .filter((e) => e.data.role === 'assistant')
      .map((e) => e.data.content.map((b: any) => b.text).join(''))
  return {
    dir,
    core,
    adapter,
    request,
    session,
    events,
    send,
    input,
    invocations,
    replies,
    workspace,
  }
}

it('keeps one process across turns and journals turns, inputs and the context meter', async () => {
  const s = await setup()
  const id = s.session()
  const first = s.send(id, 'hello')
  await until(() => s.input(first).state === 'completed')
  const second = s.send(id, 'again')
  await until(() => s.input(second).state === 'completed')
  expect(s.invocations()).toHaveLength(1)
  const args = s.invocations()[0]!.args
  expect(args).toEqual(
    expect.arrayContaining([
      '--input-format',
      'stream-json',
      '--replay-user-messages',
      '--permission-prompt-tool',
      'stdio',
      '--mcp-config',
    ])
  )
  expect(args).not.toContain('--max-budget-usd')
  // Bypass is not reachable unless the operator opted in.
  expect(args).not.toContain('--allow-dangerously-skip-permissions')
  expect(() =>
    s.request('session.configure', {
      session_id: id,
      settings: { permission_mode: 'bypassPermissions' },
    })
  ).toThrow(/invalid_params/)
  expect(s.adapter.configuration.permission_modes).not.toContain('bypassPermissions')
  expect(s.replies(id)).toEqual(['reply:hello', 'reply:again'])
  const completed = s.events(id, 'turn.completed')
  expect(completed.map((e) => e.data.input_ids)).toEqual([[first], [second]])
  expect(completed.every((e) => e.data.outcome === 'success')).toBe(true)
  expect(s.events(id, 'turn.started').map((e) => e.data.trigger)).toEqual(['input', 'input'])
  expect(s.input(first).run_id).toBe(s.input(second).run_id)
  await until(() => s.events(id, 'session.context').length >= 2)
  const context = s.events(id, 'session.context').at(-1)!.data
  expect(context).toMatchObject({ max_tokens: 1000000, total_tokens: 1200 })
  expect(JSON.stringify(context)).not.toContain('/not/for/the/journal')
  const state = s.request('session.state', { session_id: id })
  expect(state).toMatchObject({ live: true, process: 'idle', context: { total_tokens: 1200 } })
  expect(s.core.session(id).native_session_id).toBe('22222222-2222-4222-8222-222222222222')
})

it('lets a background task outlive its turn and start the next turn by itself', async () => {
  const s = await setup()
  const id = s.session()
  const input = s.send(id, 'background 400 alpha')
  await until(() => s.input(input).state === 'completed')
  expect(s.request('session.state', { session_id: id }).background_tasks).toEqual([
    { task_id: 'task-alpha', task_type: 'local_bash', description: 'Background alpha' },
  ])
  await until(() => s.events(id, 'turn.completed').length === 2)
  const second = s.events(id, 'turn.completed')[1]!.data
  expect(second).toMatchObject({ input_ids: [], outcome: 'success' })
  expect(s.events(id, 'turn.started')[1]!.data.trigger).toBe('task')
  expect(s.replies(id).at(-1)).toBe('BG-NOTIFIED alpha')
  expect(s.events(id, 'session.tasks').map((e) => e.data.tasks.length)).toEqual([1, 0])
  expect(s.events(id, 'claude.task').map((e) => e.data.subtype)).toEqual([
    'task_started',
    'task_updated',
    'task_notification',
  ])
  expect(s.invocations()).toHaveLength(1)
})

it('writes a message sent during a turn into the running process, as the CLI takes it', async () => {
  const s = await setup()
  const id = s.session()
  const slow = s.send(id, 'slow')
  await until(
    () => s.events(id, 'turn.started').length === 1 && s.input(slow).state === 'delivered'
  )
  const later = s.send(id, 'later')
  await until(() => s.input(later).state === 'completed')
  expect(s.input(slow).state).toBe('completed')
  expect(s.events(id, 'turn.completed').map((e) => e.data.input_ids)).toEqual([[slow, later]])
  expect(s.replies(id).at(-1)).toBe('INJECTED later')
})

it('interrupts a turn without ending the process, and a hard stop ends it and cancels the queue', async () => {
  const s = await setup()
  const id = s.session()
  const slow = s.send(id, 'slow')
  await until(() => s.input(slow).state === 'delivered')
  const run_id = s.input(slow).run_id
  expect(s.request('session.interrupt', { session_id: id, run_id })).toEqual({
    run_id,
    state: 'interrupting',
  })
  await until(() => s.input(slow).state === 'interrupted')
  expect(s.events(id, 'turn.completed')[0]!.data.outcome).toBe('interrupted')
  expect(s.events(id, 'turn.interrupt_requested')).toHaveLength(1)
  const after = s.send(id, 'after')
  await until(() => s.input(after).state === 'completed')
  expect(s.invocations()).toHaveLength(1)

  const hung = s.send(id, 'slow')
  await until(() => s.input(hung).state === 'delivered')
  expect(s.request('session.stop', { session_id: id })).toMatchObject({ state: 'stopping' })
  await until(() => s.events(id, 'session.process').some((e) => e.data.state === 'exited'))
  const exited = s.events(id, 'session.process').find((e) => e.data.state === 'exited')!.data
  expect(exited.reason).toBe('stopped_by_owner')
  expect(s.input(hung).state).toBe('interrupted')
  expect(s.request('session.state', { session_id: id }).process).toBe('none')
  const resumed = s.send(id, 'resumed')
  await until(() => s.input(resumed).state === 'completed')
  expect(s.invocations()).toHaveLength(2)
  const args = s.invocations()[1]!.args
  expect(args[args.indexOf('--resume') + 1]).toBe('22222222-2222-4222-8222-222222222222')
  expect(args).toContain('--mcp-config')
})

it('asks the owner over stdio with the session lifetime, and bypass mode switches without a restart', async () => {
  const s = await setup({ sessionPermissionTtlMs: 20 * 60000, allowBypass: true })
  const id = s.session()
  const asked = s.send(id, 'tool')
  await until(() => s.core.prompts(id).some((p) => p.state === 'pending'))
  const prompt = s.core.prompts(id).find((p) => p.state === 'pending')!
  expect(prompt.tool_name).toBe('Bash')
  expect(prompt.expires_at - Date.now()).toBeGreaterThan(19 * 60000)
  s.request('prompt.answer', {
    session_id: id,
    prompt_id: prompt.prompt_id,
    run_id: prompt.run_id,
    revision: 1,
    action_digest: prompt.action_digest,
    choice: 'allow',
  })
  await until(() => s.input(asked).state === 'completed')
  expect(s.replies(id).at(-1)).toBe('allowed')
  expect(existsSync(join(s.workspace.path, 'allowed.txt'))).toBe(true)
  expect(s.events(id, 'prompt.delivered')[0]!.data.evidence).toBe('stdio_control_response')
  expect(s.invocations()[0]!.args).toContain('--allow-dangerously-skip-permissions')

  s.request('session.configure', {
    session_id: id,
    settings: { permission_mode: 'bypassPermissions' },
  })
  await until(() =>
    s.events(id, 'claude.status').some((e) => e.data.permission_mode === 'bypassPermissions')
  )
  const free = s.send(id, 'tool')
  await until(() => s.input(free).state === 'completed')
  expect(s.core.prompts(id)).toHaveLength(1)
  expect(s.invocations()).toHaveLength(1)
  expect(s.events(id, 'session.updated').at(-1)!.data.settings).toEqual({
    permission_mode: 'bypassPermissions',
  })
  expect(s.request('session.state', { session_id: id }).process_settings.permission_mode).toBe(
    'bypassPermissions'
  )
  // A mode the process refuses does not leave the old one in force.
  s.request('session.configure', { session_id: id, settings: { permission_mode: 'dontAsk' } })
  await until(() => s.request('session.state', { session_id: id }).process === 'none')
  expect(s.events(id, 'session.process').at(-1)!.data.reason).toBe('settings_not_applied')
})

it('applies model live, restarts for effort and account when idle, and carries the transcript', async () => {
  const s0 = mkdtempSync(join(tmpdir(), 'abele-live-accounts-'))
  const first = join(s0, 'first'),
    second = join(s0, 'second')
  const s = await setup({ accounts: { first, second } })
  cleanups.push(async () => rmSync(s0, { recursive: true, force: true }))
  const id = s.session({ model: 'sonnet', effort: 'max', account: 'first' })
  expect(() =>
    s.request('session.configure', { session_id: id, settings: { account: 'missing' } })
  ).toThrow(/invalid_params/)
  const who = s.send(id, 'whoami')
  await until(() => s.input(who).state === 'completed')
  expect(JSON.parse(s.replies(id).at(-1)!)).toMatchObject({
    model: 'sonnet',
    effort: 'max',
    mode: 'manual',
    config_dir: first,
  })
  s.request('session.configure', { session_id: id, settings: { model: 'opus' } })
  const who2 = s.send(id, 'whoami')
  await until(() => s.input(who2).state === 'completed')
  expect(JSON.parse(s.replies(id).at(-1)!).model).toBe('opus')
  expect(s.invocations()).toHaveLength(1)

  const transcript = join(first, 'projects', 'slug', '22222222-2222-4222-8222-222222222222.jsonl')
  mkdirSync(join(first, 'projects', 'slug'), { recursive: true })
  writeFileSync(transcript, '{"fixture":true}\n')
  s.request('session.configure', {
    session_id: id,
    settings: { effort: 'low', account: 'second' },
  })
  await until(() => s.request('session.state', { session_id: id }).process === 'none')
  expect(s.events(id, 'session.process').at(-1)!.data.reason).toBe('settings_changed')
  const who3 = s.send(id, 'whoami')
  await until(() => s.input(who3).state === 'completed')
  expect(JSON.parse(s.replies(id).at(-1)!)).toMatchObject({
    model: 'opus',
    effort: 'low',
    config_dir: second,
  })
  expect(
    readFileSync(
      join(second, 'projects', 'slug', '22222222-2222-4222-8222-222222222222.jsonl'),
      'utf8'
    )
  ).toBe('{"fixture":true}\n')
  expect(s.invocations()[1]!.args).toContain('--resume')
})

it('compacts on request, journals boundary and summary, and continues afterwards when asked', async () => {
  const s = await setup()
  const id = s.session()
  const warm = s.send(id, 'hello')
  await until(() => s.input(warm).state === 'completed')
  const { input_id } = s.request('session.compact', { session_id: id, focus: 'keep the plan' })
  await until(() => s.input(input_id).state === 'completed')
  expect(s.events(id, 'turn.started').map((e) => e.data.trigger)).toContain('compact')
  expect(s.events(id, 'compaction.started')).toHaveLength(1)
  expect(s.events(id, 'compaction.completed')[0]!.data).toMatchObject({
    result: 'success',
    trigger: 'manual',
    pre_tokens: 5000,
    post_tokens: 300,
  })
  expect(s.events(id, 'compaction.summary')[0]!.data.text).toContain('keep the plan')
  await until(() => s.replies(id).at(-1) === 'reply:продолжай')
  const continuation = s.events(id, 'input.accepted').at(-1)!.data
  expect(continuation).toMatchObject({ text: 'продолжай', continuation: true })

  const quiet = s.request('session.compact', { session_id: id, continue: false }).input_id
  await until(() => s.input(quiet).state === 'completed')
  await until(() => s.events(id, 'session.context').length >= 5)
  expect(s.replies(id).filter((r) => r === 'reply:продолжай')).toHaveLength(1)
  expect(s.events(id, 'input.accepted')).toHaveLength(4)
})

it('resumes with the same native session after the process dies, and marks the lost input unknown', async () => {
  const s = await setup({}, { retryMs: 50 })
  const id = s.session()
  const crash = s.send(id, 'crash')
  await until(() => s.input(crash).state === 'delivery_unknown')
  expect(s.events(id, 'session.process').at(-1)!.data).toMatchObject({ state: 'exited' })
  const next = s.send(id, 'next')
  await until(() => s.input(next).state === 'completed')
  const args = s.invocations()[1]!.args
  expect(args[args.indexOf('--resume') + 1]).toBe('22222222-2222-4222-8222-222222222222')
})

it('ends an idle process only when nothing runs in it and nobody watches it', async () => {
  const s = await setup({}, { idleMs: 150 })
  const id = s.session()
  const watching = s.core.watch(id)
  const bg = s.send(id, 'background 800 beta')
  await until(() => s.input(bg).state === 'completed')
  watching()
  // The background task keeps it alive until its own turn has finished.
  await new Promise((r) => setTimeout(r, 400))
  expect(s.request('session.state', { session_id: id }).process).not.toBe('none')
  await until(() => s.events(id, 'turn.completed').length === 2)
  await until(() => s.request('session.state', { session_id: id }).process === 'none')
  expect(s.events(id, 'session.process').at(-1)!.data.reason).toBe('idle')
  expect(s.events(id, 'session.process').at(-1)!.data.lost_tasks).toBeUndefined()
})

it('keeps delegated work and a CLI without long-lived input on one process per message', async () => {
  const s = await setup({ live: false })
  const id = s.session()
  expect(s.request('session.state', { session_id: id })).toMatchObject({
    live: false,
    process: 'none',
  })
  expect(() => s.request('session.compact', { session_id: id })).toThrow(/unsupported_method/)
  expect(() =>
    s.request('session.create', {
      title: 'x',
      provider: 'claude',
      workspace_id: s.core.session(id).workspace_id,
      settings: { model: 'opus' },
    })
  ).toThrow(/invalid_params/)
})
