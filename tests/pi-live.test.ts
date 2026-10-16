import { expect, afterEach } from 'vitest'
import { processIt as it } from './process-test.js'
import { waitForProcessCondition } from '../scripts/process-test-budget.mjs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { NodeCore, type LiveOptions } from '@abele/node-core'
import { PiProviderAdapter, type PiOptions } from '@abele/provider-pi'

// Long-lived pi owner sessions over a host double, with a node that can restart in between.
const until = <T>(test: () => T) => waitForProcessCondition(test, 'long-lived pi session')
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const hostModule = fileURLToPath(new URL('./fixtures/pi-live-host.mjs', import.meta.url))
const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})
async function setup(options: Partial<PiOptions> = {}, live: LiveOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'abele-pi-live-')),
    repo = join(dir, 'repo'),
    state = join(dir, 'state')
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
  const adapter = () =>
    new PiProviderAdapter({ stateDir: state, profile: 'isolated', hostModule, ...options })
  let core = new NodeCore(state, { pi: adapter(), live })
  const token = core.createToken('test').token
  const request = (method: string, p: unknown) =>
    core.request(core.authority.authenticate(token), method, p, crypto.randomUUID()) as any
  const project = await request('project.register', { path: repo, trust: 'trusted' })
  const job = await request('workspace.create', { project_id: project.project_id })
  await core.resources.jobs.drain()
  const workspace = core.resources.workspaces.get(job.workspace_id).path
  let draining: Promise<void> | undefined
  let pump: ReturnType<typeof setInterval> | undefined
  const run = () =>
    (pump = setInterval(() => {
      draining ??= core.claude.drain().finally(() => (draining = undefined))
    }, 10))
  run()
  const halt = async (keepLive: boolean) => {
    clearInterval(pump)
    await draining
    await core.claude.stop({ keepLive })
    await core.resources.stop()
    core.close()
  }
  const restart = async (between?: () => unknown) => {
    await halt(true)
    await between?.()
    core = new NodeCore(state, { pi: adapter(), live })
    await core.resources.ready
    await core.claude.reconcile()
    run()
  }
  cleanups.push(async () => {
    await halt(false)
    rmSync(dir, { recursive: true, force: true })
  })
  const session = (settings?: Record<string, unknown>) =>
    request('session.create', {
      title: 'Owner',
      provider: 'pi',
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
  const invocations = () => {
    const file = join(workspace, 'pi-live-invocations.jsonl')
    return existsSync(file)
      ? readFileSync(file, 'utf8')
          .trim()
          .split('\n')
          .map((l) => JSON.parse(l))
      : []
  }
  const replies = (session_id: string) =>
    events(session_id, 'pi.message.final').map((e) =>
      e.data.message.content.map((b: any) => b.text).join('')
    )
  return {
    get core() {
      return core
    },
    request,
    session,
    events,
    send,
    input,
    invocations,
    replies,
    restart,
  }
}

it('keeps one pi process across turns and journals turns, inputs, context and commands', async () => {
  const s = await setup()
  const id = s.session()
  const first = s.send(id, 'hello')
  await until(() => s.input(first).state === 'completed')
  const second = s.send(id, 'again')
  await until(() => s.input(second).state === 'completed')
  expect(s.invocations()).toHaveLength(1)
  expect(s.invocations()[0]).toMatchObject({
    resumed: null,
    live: { effort: 'medium', permission_mode: 'manual' },
    tools: ['lsp', 'node_sessions', 'node_session_send'],
  })
  expect(s.replies(id)).toEqual(['reply:hello', 'reply:again'])
  expect(s.events(id, 'turn.completed').map((e) => [e.data.input_ids, e.data.outcome])).toEqual([
    [[first], 'success'],
    [[second], 'success'],
  ])
  expect(s.events(id, 'turn.started').map((e) => e.data.trigger)).toEqual(['input', 'input'])
  expect(s.input(first).run_id).toBe(s.input(second).run_id)
  expect(s.events(id, 'session.context').at(-1)!.data).toMatchObject({
    total_tokens: 1200,
    max_tokens: 200000,
  })
  // The shared "/" list, and the transcript in the shared vocabulary.
  expect(
    s.request('session.commands', { session_id: id }).commands.map((c: any) => c.name)
  ).toEqual(['compact', 'review'])
  const updates = s.events(id, 'session.update').map((e) => e.data.update)
  expect(updates.filter((u) => u.kind === 'agent_message').map((u) => u.text)).toEqual([
    'reply:hello',
    'reply:again',
  ])
  expect(updates.filter((u) => u.kind === 'usage_update')).toEqual([])
  expect(s.events(id, 'pi.message.final').every((e) => e.data.mapped === true)).toBe(true)
  expect(s.core.session(id).native_session_file).toMatch(/\.jsonl$/)
  expect(s.request('session.state', { session_id: id })).toMatchObject({
    live: true,
    process: 'idle',
  })
  // Bypass is not reachable unless the operator opted in.
  expect(() =>
    s.request('session.configure', {
      session_id: id,
      settings: { permission_mode: 'bypassPermissions' },
    })
  ).toThrow(/invalid_params/)
})

it('takes a message written during a turn into that turn', async () => {
  const s = await setup()
  const id = s.session()
  const slow = s.send(id, 'slow')
  await until(() => s.input(slow).state === 'delivered')
  const later = s.send(id, 'later')
  await until(() => s.input(later).state === 'completed')
  expect(s.input(slow).state).toBe('completed')
  expect(s.events(id, 'turn.completed').map((e) => e.data.input_ids)).toEqual([[slow, later]])
  expect(s.replies(id).at(-1)).toBe('INJECTED later')
})

it('interrupts a turn without ending the process, and a hard stop resumes the same native file', async () => {
  const s = await setup()
  const id = s.session()
  const slow = s.send(id, 'slow')
  await until(() => s.input(slow).state === 'delivered')
  const run_id = s.input(slow).run_id
  s.request('session.interrupt', { session_id: id, run_id })
  await until(() => s.input(slow).state === 'interrupted')
  expect(s.events(id, 'turn.completed')[0]!.data.outcome).toBe('interrupted')
  const after = s.send(id, 'after')
  await until(() => s.input(after).state === 'completed')
  expect(s.invocations()).toHaveLength(1)
  const file = s.core.session(id).native_session_file

  s.request('session.stop', { session_id: id })
  await until(() => s.request('session.state', { session_id: id }).process === 'none')
  expect(alive(s.invocations()[0].pid)).toBe(false)
  const resumed = s.send(id, 'resumed')
  await until(() => s.input(resumed).state === 'completed')
  expect(s.invocations()).toHaveLength(2)
  expect(s.invocations()[1].resumed).toBe(file)
})

it('asks the owner for a tool, and bypass switches the running session without a restart', async () => {
  const s = await setup({ allowBypass: true })
  const id = s.session()
  const asked = s.send(id, 'tool')
  await until(() => s.core.prompts(id).some((p) => p.state === 'pending'))
  const prompt = s.core.prompts(id).find((p) => p.state === 'pending')!
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
  s.request('session.configure', {
    session_id: id,
    settings: { permission_mode: 'bypassPermissions' },
  })
  await until(
    () =>
      s.request('session.state', { session_id: id }).process_settings?.permission_mode ===
      'bypassPermissions'
  )
  const free = s.send(id, 'tool')
  await until(() => s.input(free).state === 'completed')
  expect(s.replies(id).at(-1)).toBe('allowed')
  expect(s.core.prompts(id)).toHaveLength(1)
  expect(s.invocations()).toHaveLength(1)
})

it('compacts on request, journals boundary and summary, and continues afterwards', async () => {
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
  expect(s.events(id, 'compaction.summary')[0]!.data.text).toBe('summary: keep the plan')
  expect(
    s
      .events(id, 'session.update')
      .map((e) => e.data.update)
      .filter((u) => u.kind.startsWith('compaction_'))
      .map((u) => u.state ?? u.kind)
  ).toEqual(['started', 'compaction_summary'])
  await until(() => s.replies(id).at(-1) === 'reply:продолжай')
})

it('keeps a running pi turn through a node restart and journals what it wrote meanwhile, once', async () => {
  const s = await setup()
  const id = s.session()
  const paused = s.send(id, 'pause 700')
  await until(() => s.replies(id).includes('before-pause'))
  const run_id = s.input(paused).run_id
  const worker = s.invocations()[0].pid
  await s.restart(async () => {
    await sleep(900)
    expect(alive(worker)).toBe(true)
  })
  await until(() => s.input(paused).state === 'completed')
  expect(s.replies(id)).toEqual(['before-pause', 'after-pause'])
  expect(s.events(id, 'turn.completed')).toHaveLength(1)
  expect(
    s.events(id, 'session.process').map((e) => [e.data.state, e.data.reattached ?? false])
  ).toEqual([
    ['starting', false],
    ['running', false],
    ['running', true],
  ])
  const next = s.send(id, 'again')
  await until(() => s.input(next).state === 'completed')
  expect(s.input(next).run_id).toBe(run_id)
  expect(s.invocations()).toHaveLength(1)
})

it('asks an open pi question again after a node restart', async () => {
  const s = await setup()
  const id = s.session()
  const asked = s.send(id, 'tool')
  await until(() => s.core.prompts(id).some((p) => p.state === 'pending'))
  await s.restart()
  await until(() => s.core.prompts(id).filter((p) => p.state === 'pending').length === 1)
  const prompt = s.core.prompts(id).find((p) => p.state === 'pending')!
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
})
