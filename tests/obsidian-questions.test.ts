import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
import { MemoryClientStore, NodeClient } from '../packages/node-client/src/index.js'

const cleanup: (() => void)[] = []
afterEach(() => cleanup.splice(0).forEach((fn) => fn()))
function fixture() {
  const dir = mkdtempSync(resolve('.scratch/obsidian-questions-'))
  let core = new NodeCore(dir)
  const token = core.createToken('owner').token
  const actor = core.authority.authenticate(token)
  const other = core.authority.authenticate(core.createToken('other-owner').token)
  const session = core.request(
    actor,
    'session.create',
    { provider: 'fake', title: 'Questions' },
    'session'
  ) as any
  const request = (method: string, p: any) =>
    core.request(
      actor,
      'obsidian.tools.v1.' + method,
      p,
      undefined,
      new AbortController().signal
    ) as any
  request('configure', {
    session_id: session.session_id,
    vault_id: 'vault',
    agent_id: 'agent',
    revision: 'r1',
    tools: [{ name: 'questions', description: 'Ask', inputSchema: {}, mode: 'auto' }],
  })
  const advertise = () =>
    request('advertise', {
      client_id: 'desktop',
      vault_id: 'vault',
      platform: 'desktop',
      revisions: { agent: 'r1' },
    })
  advertise()
  const questions = [
    { question: 'Name?', options: [], type: 'input' },
    { question: 'One?', options: ['A', 'B'], type: 'single' },
    { question: 'Several?', options: ['A', 'B', 'C'], type: 'multi' },
  ]
  const call = core.obsidianTools.invoke(actor, session.session_id, 'run', 'call', 'questions', {
    questions,
  })
  request('poll', { client_id: 'desktop' })
  const ref = { invocation_id: call.invocation_id }
  const executor = { ...ref, client_id: 'desktop', revision: 'r1' }
  request('prepare', { ...executor, preview: {} })
  request('claim', executor)
  cleanup.push(() => {
    core.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const answer = (
    prompt: any,
    answers: any,
    choice = 'allow',
    who = actor,
    op: string = crypto.randomUUID()
  ) =>
    core.request(
      who,
      'prompt.answer',
      {
        session_id: prompt.session_id,
        prompt_id: prompt.prompt_id,
        run_id: prompt.run_id,
        revision: prompt.revision,
        action_digest: prompt.action_digest,
        choice,
        ...(answers === undefined ? {} : { answers }),
      },
      op
    ) as any
  return {
    get core() {
      return core
    },
    actor,
    other,
    ref,
    executor,
    request,
    questions,
    answer,
    restart() {
      core.close()
      core = new NodeCore(dir)
      advertise()
    },
  }
}

it('creates one invocation-bound questionnaire, survives restart and atomically delivers one owner answer', () => {
  const f = fixture()
  const prompt = f.request('questions.open', f.executor)
  expect(prompt).toMatchObject({
    kind: 'questionnaire',
    expires_at: Number.MAX_SAFE_INTEGER,
    state: 'pending',
    questions: f.questions,
  })
  expect(f.request('questions.open', f.executor).prompt_id).toBe(prompt.prompt_id)
  expect(
    f.core
      .read('catalog', 0)
      .some(
        (e) =>
          e.type === 'obsidian.tools.questionnaire' &&
          (e.data as any).prompt_id === prompt.prompt_id
      )
  ).toBe(true)
  f.core.tick(Date.now() + 3 * 86400000)
  expect(f.core.prompt(prompt.prompt_id).state).toBe('pending')
  f.restart()
  expect(f.request('questions.pending', { vault_id: 'vault' })[0].prompt_id).toBe(prompt.prompt_id)
  const answers = ['Owner', 'B', ['A', 'C']]
  expect(f.answer(prompt, answers, 'allow', f.other).answers).toEqual(answers)
  expect(f.answer(prompt, ['late', 'A', ['B']]).answers).toEqual(answers)
  expect(f.request('get', f.ref)).toMatchObject({
    state: 'succeeded',
    result: {
      answers,
      content: [
        { type: 'text', text: 'Q: Name?\nA: Owner\n\nQ: One?\nA: B\n\nQ: Several?\nA: A, C' },
      ],
    },
  })
  expect(f.request('questions.pending', { vault_id: 'vault' })).toEqual([])
  expect(f.core.prompt(prompt.prompt_id).delivered).toBe(true)
})

it('validates answers without consuming the prompt and refuses an unrelated executor', () => {
  const f = fixture()
  const prompt = f.request('questions.open', f.executor)
  expect(() => f.answer(prompt, ['missing'])).toThrow('invalid_params')
  expect(() => f.answer(prompt, ['name', ['A'], ['B']])).toThrow('invalid_params')
  expect(() => f.answer(prompt, ['name', 'B', ['A', 'A']])).toThrow('invalid_params')
  expect(f.core.prompt(prompt.prompt_id).state).toBe('pending')
  expect(() => f.request('questions.open', { ...f.executor, client_id: 'phone' })).toThrow(
    'wrong_executor'
  )
  expect(() => f.request('complete', { ...f.executor, state: 'succeeded', result: {} })).toThrow(
    'hosted_invocation'
  )
})

it.each(['deny', 'cancel'])(
  'settles questionnaire %s once and prevents a late answer',
  (choice) => {
    const f = fixture()
    const prompt = f.request('questions.open', f.executor)
    if (choice === 'deny') f.answer(prompt, undefined, 'deny')
    else f.request('cancel', f.ref)
    const final = f.request('get', f.ref)
    expect(final.result.content[0].text).toBe('User aborted the questionnaire.')
    expect(['succeeded', 'cancelled']).toContain(final.state)
    if (choice === 'cancel')
      expect(() => f.answer(prompt, ['late', 'A', ['B']])).toThrow('prompt_expired')
    else expect(f.answer(prompt, ['late', 'A', ['B']]).choice).toBe('deny')
    expect(f.request('get', f.ref)).toEqual(final)
  }
)

it('persists structured questionnaire answers through the public client API', async () => {
  const f = fixture()
  const prompt = f.request('questions.open', f.executor)
  const store = new MemoryClientStore()
  await store.transaction((s) => {
    s.node_id = f.core.node_id
    s.installation_id = f.actor.installation_id
  })
  const client = new NodeClient(
    { url: 'ws://127.0.0.1:7777/channel', token: 'a'.repeat(64), profile: 'local-token-v1' },
    store
  )
  const connected = vi.spyOn(client, 'connected', 'get').mockReturnValue(true)
  const flushed = vi.spyOn(client, 'flush').mockImplementation(async () => {
    await store.transaction((s) => {
      const entry = s.outbox[0]!
      expect(entry.method).toBe('prompt.answer')
      expect((entry.params as any).answers).toEqual(['Owner', 'B', ['A']])
      s.results[entry.operation_id] = {
        result: f.core.request(f.actor, entry.method, entry.params, entry.operation_id),
      }
      s.outbox = []
    })
  })
  try {
    expect((await client.answerQuestionnaire(prompt, ['Owner', 'B', ['A']])).delivered).toBe(true)
    expect(flushed).toHaveBeenCalledOnce()
  } finally {
    connected.mockRestore()
    flushed.mockRestore()
  }
})

it('delivers the durable answer through the already waiting provider bridge', async () => {
  const f = fixture()
  const bridge = f.core.obsidianTools.bridge(
    f.actor,
    (f.request('get', f.ref) as any).session_id,
    'run',
    () => true
  )
  try {
    const pending = bridge.call('obsidian_questions', { questions: f.questions }, undefined, 'call')
    const prompt = f.request('questions.open', f.executor)
    f.answer(prompt, ['Owner', 'B', ['A']])
    const result = await pending
    expect(bridge.publish({}, result)).toMatchObject({
      state: 'succeeded',
      result: { answers: ['Owner', 'B', ['A']] },
    })
  } finally {
    bridge.close()
  }
})

it('rolls back questionnaire resolution and tool completion together on a failed commit', () => {
  const f = fixture()
  const prompt = f.request('questions.open', f.executor)
  f.core.fault = (point) => {
    if (point === 'before_commit') throw new Error('commit failed')
  }
  expect(() => f.answer(prompt, ['Owner', 'B', ['A']], 'allow', f.actor, 'answer-once')).toThrow(
    'commit failed'
  )
  f.restart()
  expect(f.core.prompt(prompt.prompt_id).state).toBe('pending')
  expect(f.request('get', f.ref).state).toBe('executing')
  f.answer(prompt, ['Owner', 'B', ['A']], 'allow', f.actor, 'answer-once')
  expect(f.request('get', f.ref).state).toBe('succeeded')
  expect(
    f.core
      .read(prompt.session_id, 0)
      .filter((e) => e.type === 'prompt.resolved' && (e.data as any).prompt_id === prompt.prompt_id)
  ).toHaveLength(1)
})
