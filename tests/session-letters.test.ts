import { afterEach, expect } from 'vitest'
import { processIt as it } from './process-test.js'
import { until } from './live-harness.js'
import { mkdtempSync, mkdirSync, cpSync, chmodSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore, ClaudeProviderAdapter } from '@abele/node-core'
import type { LiveSession } from '@abele/provider-contract'
import { validateParams } from '../packages/node-protocol/src/schemas.js'
import { MemoryClientStore, NodeClient } from '../packages/node-client/src/index.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

async function setup(live = true) {
  const dir = mkdtempSync(resolve('.scratch/letters-'))
  const folder = join(dir, 'folder'),
    state = join(dir, 'state'),
    executable = join(dir, 'fake-claude')
  mkdirSync(folder)
  cpSync(new URL('./fixtures/claude-live.mjs', import.meta.url), executable)
  chmodSync(executable, 0o700)
  const create = () => {
    const adapter = new ClaudeProviderAdapter({ executable, profile: 'isolated' })
    if (!live) Object.defineProperty(adapter, 'liveAvailable', { value: false })
    adapter.startTurn = async (context, sink) => {
      sink.event({
        type: 'claude.message.final',
        data: {
          message_id: 'one-shot',
          role: 'assistant',
          content: [{ type: 'text', text: context.text }],
        },
      })
      return { done: Promise.resolve({ result: { subtype: 'success' } }), async interrupt() {} }
    }
    // A provider that deliberately combines inputs received during a turn.
    // No process or model is started; the node must enforce the letter barrier.
    adapter.startSession = async (_context, sink) => {
      let ids: string[] = [],
        timer: ReturnType<typeof setTimeout>
      let finish!: (result: {}) => void
      const done = new Promise<{}>((resolve) => {
        finish = resolve
      })
      return {
        done,
        send(input) {
          ids.push(input.input_id)
          sink.event({ type: 'claude.input.delivered', data: { input_id: input.input_id } })
          if (ids.length > 1) return
          sink.event({ type: 'claude.turn.started', data: { trigger: 'input' } })
          sink.event({
            type: 'claude.message.final',
            data: {
              message_id: 'commentary',
              role: 'assistant',
              content: [{ type: 'text', text: 'Earlier commentary' }],
            },
          })
          const text = String(input.content)
          timer = setTimeout(
            () => {
              sink.event({
                type: 'claude.message.final',
                data: {
                  message_id: input.input_id,
                  role: 'assistant',
                  content: [
                    { type: 'text', text: text.startsWith('pause') ? 'after-pause' : text },
                  ],
                },
              })
              sink.event({
                type: 'claude.message.final',
                data: {
                  message_id: 'child',
                  parent_tool_use_id: 'tool',
                  role: 'assistant',
                  content: [{ type: 'text', text: 'Child output' }],
                },
              })
              const input_ids = ids
              ids = []
              sink.event({ type: 'claude.turn.completed', data: { input_ids, outcome: 'success' } })
            },
            text.startsWith('pause') ? 200 : 40
          )
        },
        async stop() {
          clearTimeout(timer)
          finish({})
        },
        async interrupt() {},
        async control() {
          return {}
        },
      } satisfies LiveSession
    }
    return new NodeCore(state, { claude: adapter })
  }
  let core = create()
  const token = core.createToken('test').token
  const request = (method: string, params: unknown) =>
    core.request(core.authority.authenticate(token), method, params, crypto.randomUUID()) as any
  const project = await request('project.register', { path: folder, trust: 'trusted' })
  const workspace = (await request('workspace.list', { project_id: project.project_id }))[0]
  const target = { kind: 'workspace', workspace_id: workspace.workspace_id }
  await request('project.execution', { project_id: project.project_id, target, enabled: true })
  let draining: Promise<void> | undefined
  let pump: ReturnType<typeof setInterval>
  const run = () => {
    pump = setInterval(() => {
      draining ??= core.claude.drain().finally(() => {
        draining = undefined
      })
    }, 10)
  }
  const halt = async () => {
    clearInterval(pump)
    await draining
    await core.claude.stop()
    await core.resources.stop()
    core.close()
  }
  run()
  cleanups.push(async () => {
    await halt()
    rmSync(dir, { recursive: true, force: true })
  })
  const events = (id: string, type?: string): any[] => {
    const all = []
    for (let after = 0; ;) {
      const page = core.read(id, after, 256)
      if (!page.length) break
      all.push(...page)
      after = page.at(-1)!.seq
    }
    return type ? all.filter((e) => e.type === type) : all
  }
  return {
    get core() {
      return core
    },
    request,
    events,
    session: async () =>
      (await request('session.create', { provider: 'claude', target })).session_id as string,
    send: (session_id: string, text: string) =>
      request('session.send', { session_id, text, observed_seq: 0 }).input_id as string,
    input: (id: string) =>
      core.db.prepare('SELECT state FROM inputs WHERE input_id=?').get(id) as { state: string },
    restart: async () => {
      await halt()
      core = create()
      run()
    },
  }
}

it('journals sender references and isolates letters from queued turns', async () => {
  const s = await setup()
  const session_id = await s.session()
  const sender = { id: 'opaque-chat', title: 'Sending chat' }
  const first = s.send(session_id, 'pause 200')
  await until(() => s.events(session_id, 'turn.started').length === 1)
  const letter = s.request('session.send', {
    session_id,
    text: 'letter',
    observed_seq: 0,
    sender,
  }).input_id
  const second = s.request('session.send', {
    session_id,
    text: 'second letter',
    observed_seq: 0,
    sender,
  }).input_id
  const ordinary = s.send(session_id, 'ordinary')
  await until(() => s.input(ordinary).state === 'completed')
  expect(
    s.events(session_id, 'input.accepted').find((e) => e.data.input_id === letter)?.data.sender
  ).toEqual(sender)
  for (const input_id of [first, letter, second, ordinary]) {
    const completed = s
      .events(session_id, 'turn.completed')
      .find((e) => e.data.input_ids.includes(input_id))!
    expect(completed.data.input_ids).toEqual([input_id])
    const reply = s.events(session_id, 'input.reply').find((e) => e.data.input_id === input_id)!
    expect(reply.data.turn_id).toBe(completed.data.turn_id)
    expect(reply.data.final_reply).toEqual({
      message_id: expect.any(String),
      event_seqs: expect.arrayContaining([expect.any(Number)]),
    })
    const updates = reply.data.final_reply.event_seqs.map((seq: number) =>
      s.events(session_id).find((e) => e.seq === seq)
    )
    expect(
      updates.every(
        (e: any) =>
          e.type === 'session.update' &&
          e.data.turn_id === completed.data.turn_id &&
          e.data.update.kind === 'agent_message'
      )
    ).toBe(true)
    expect(updates.map((e: any) => e.data.update.text).join('')).toContain(
      input_id === first
        ? 'after-pause'
        : input_id === letter
          ? 'letter'
          : input_id === second
            ? 'second letter'
            : 'ordinary'
    )
  }
  const before = s.events(session_id, 'turn.completed')
  const replies = s.events(session_id, 'input.reply')
  await s.restart()
  expect(s.events(session_id, 'turn.completed')).toEqual(before)
  expect(s.events(session_id, 'input.reply')).toEqual(replies)
  expect(s.core.capabilities().capabilities.session_letters_v1.status).toBe('supported')
})

it('isolates letters queued before provider startup and keeps ordinary input batching', async () => {
  const s = await setup()
  const session_id = await s.session()
  const sender = { id: 'chat', title: 'Chat' }
  const letters = ['first', 'second'].map(
    (text) => s.request('session.send', { session_id, text, observed_seq: 0, sender }).input_id
  )
  await until(() => s.input(letters[1]).state === 'completed')
  expect(s.events(session_id, 'turn.completed').map((e) => e.data.input_ids)).toEqual(
    letters.map((id) => [id])
  )
  const first = s.send(session_id, 'pause 200')
  await until(() => s.events(session_id, 'turn.started').length === 3)
  const second = s.send(session_id, 'ordinary')
  await until(() => s.input(second).state === 'completed')
  expect(s.events(session_id, 'turn.completed').at(-1)!.data.input_ids).toEqual([first, second])
})

it('maps replies for one-process-per-message providers too', async () => {
  const s = await setup(false)
  const session_id = await s.session()
  const input_id = s.request('session.send', {
    session_id,
    text: 'single reply',
    observed_seq: 0,
    sender: { id: 'chat', title: 'Chat' },
  }).input_id
  await until(() => s.events(session_id, 'input.reply').length === 1)
  const reply = s.events(session_id, 'input.reply')[0].data
  expect(reply).toMatchObject({
    input_id,
    turn_id: reply.run_id,
    outcome: 'success',
    final_reply: { message_id: 'one-shot' },
  })
  expect(
    s.events(session_id).find((e) => e.seq === reply.final_reply.event_seqs[0])!.data.update.text
  ).toBe('single reply')
})

it('bounds sender metadata and retains legacy sends', () => {
  const p = { session_id: 'session', text: 'hello', observed_seq: 0 }
  expect(() => validateParams('session.send', p)).not.toThrow()
  expect(() =>
    validateParams('session.send', { ...p, sender: { id: 'id', title: 'Chat' } })
  ).not.toThrow()
  for (const sender of [
    { id: '', title: 'Chat' },
    { id: 'x'.repeat(257), title: 'Chat' },
    { id: 'id', title: 'x'.repeat(257) },
    { id: 'id', title: 'Chat', permissions: 'owner' },
  ])
    expect(() => validateParams('session.send', { ...p, sender })).toThrow()
})

it('retains sender metadata and operation identity in the client outbox', async () => {
  const store = new MemoryClientStore()
  await store.transaction((s) => {
    s.node_id = 'node'
  })
  const target = {
    url: 'ws://127.0.0.1:7777/channel',
    profile: 'local-token-v1' as const,
    token: 'a'.repeat(64),
  }
  const client = new NodeClient(target, store)
  const sender = { id: 'opaque', title: 'Source' }
  await client.send('session', 'letter', 0, undefined, undefined, 'retained', sender)
  const reloaded = new NodeClient(target, store)
  expect((await reloaded.pending())[0]).toMatchObject({
    operation_id: 'retained',
    params: { sender },
  })
})

it('maps the deterministic fake provider reply', async () => {
  const s = await setup()
  const session_id = (await s.request('session.create', { provider: 'fake' })).session_id
  const input_id = s.send(session_id, 'fake answer')
  s.core.tick()
  const reply = s.events(session_id, 'input.reply')[0].data
  expect(reply).toMatchObject({ input_id, turn_id: reply.run_id, outcome: 'success' })
  expect(
    s.events(session_id).find((e) => e.seq === reply.final_reply.event_seqs[0])!.data.text
  ).toBe('fake answer')
})
