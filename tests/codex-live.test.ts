import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { DebuggerToolBridge } from '@abele/provider-contract'
import { discoverCodex } from '../packages/provider-codex/src/discovery.js'
import { startCodexLiveSession } from '../packages/provider-codex/src/live.js'
import {
  commandList,
  skillInput,
  contextUsage,
} from '../packages/provider-codex/src/live-events.js'

const wait = async (check: () => boolean, ms = 5000) => {
  const until = Date.now() + ms
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}
function setup(mode = 'live') {
  const dir = mkdtempSync(resolve('.scratch/codex-live-')),
    home = join(dir, 'home'),
    workspace = join(dir, 'workspace')
  mkdirSync(home)
  mkdirSync(workspace)
  writeFileSync(join(home, 'fixture.json'), JSON.stringify({ mode }))
  const executable = discoverCodex({
    executable: resolve('tests/fixtures/codex.mjs'),
    fixture: true,
  })
  const events: { type: string; data: Record<string, any> }[] = []
  const sink = {
    debugger: undefined as DebuggerToolBridge | undefined,
    event: (e: any) => events.push(e),
    processes: () => {},
    permission: async () => ({ choice: 'deny' as const, delivered: () => true }),
  }
  const open = (extra: Record<string, unknown> = {}) =>
    startCodexLiveSession(
      {
        executable,
        paths: { home, workspace, sibling: dir, state: dir },
        context: {
          session_id: randomUUID(),
          run_id: randomUUID(),
          cwd: workspace,
          settings: {
            model: 'default',
            effort: 'low',
            account: 'default',
            permission_mode: 'manual',
          },
          permission_ttl_ms: 60000,
          ...extra,
        },
      },
      sink
    )
  const of = (type: string) => events.filter((e) => e.type === type)
  const log = (name: string) =>
    readFileSync(join(home, name), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
  return {
    dir,
    sink,
    home,
    events,
    open,
    of,
    log,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

it('registers and answers an Obsidian dynamic tool through the fake app-server', async () => {
  const t = setup('obsidian-tools')
  const calls: any[] = []
  t.sink.debugger = {
    tools: [{ name: 'obsidian_create', description: 'Create', inputSchema: { type: 'object' } }],
    async call(...args) {
      calls.push(args)
      return { state: 'succeeded', result: { text: 'created' } }
    },
    publish: (_a, r) => r,
    close() {},
  }
  let live: Awaited<ReturnType<typeof t.open>> | undefined
  try {
    live = await t.open()
    live.send({ input_id: 'one', content: 'create a note' })
    await wait(() => t.of('live.turn.completed').length > 0)
    expect(calls).toHaveLength(1)
    expect(calls[0]![0]).toBe('obsidian_create')
    expect(calls[0]![3]).toMatch(/^codex:/)
    expect(t.log('tool-responses.jsonl')[0].result).toMatchObject({ success: true })
  } finally {
    await live?.stop()
    t.cleanup()
  }
})

it('keeps one app-server across turns, steers input into a running turn and has no turn deadline', async () => {
  const t = setup()
  try {
    const live = await t.open()
    const bound = t.of('codex.session.bound')[0]!.data
    live.send({ input_id: 'a', content: 'first' })
    await wait(() => t.of('live.turn.completed').length === 1)
    expect(t.of('live.turn.completed')[0]!.data).toMatchObject({
      outcome: 'success',
      input_ids: ['a'],
    })
    expect(t.of('codex.message.final').at(-1)!.data.text).toBe('heard: first')
    // Context meter from Codex's own token usage.
    expect(t.of('live.context').at(-1)!.data).toMatchObject({
      total_tokens: 2500,
      max_tokens: 10000,
      percentage: 25,
    })
    // A held turn takes the next message as steering, then completes with both inputs.
    live.send({ input_id: 'b', content: 'hold this' })
    await wait(() => t.of('live.turn.started').length === 2)
    live.send({ input_id: 'c', content: 'and this' })
    await wait(() => t.of('live.turn.completed').length === 2)
    expect(t.of('live.turn.completed')[1]!.data).toMatchObject({
      outcome: 'success',
      input_ids: ['b', 'c'],
    })
    expect(t.of('live.input.delivered').map((e) => e.data.input_id)).toEqual(['a', 'b', 'c'])
    expect(t.log('steer-log.jsonl')).toHaveLength(1)
    // Every turn ran on the bound thread of the one process.
    expect(t.log('turn-log.jsonl').map((p) => p.threadId)).toEqual([
      bound.native_session_id,
      bound.native_session_id,
    ])
    await live.stop('test')
    expect((await live.done).reason).toBe('test')
  } finally {
    t.cleanup()
  }
})

it('stops a turn mid-way and keeps the process for the next message', async () => {
  const t = setup()
  try {
    const live = await t.open()
    live.send({ input_id: 'a', content: 'hold' })
    await wait(() => t.of('live.turn.started').length === 1)
    await live.interrupt()
    await wait(() => t.of('live.turn.completed').length === 1)
    expect(t.of('live.turn.completed')[0]!.data).toMatchObject({
      outcome: 'interrupted',
      input_ids: ['a'],
    })
    live.send({ input_id: 'b', content: 'after' })
    await wait(() => t.of('live.turn.completed').length === 2)
    expect(t.of('live.turn.completed')[1]!.data.outcome).toBe('success')
    await live.stop()
  } finally {
    t.cleanup()
  }
})

it('compacts on /compact, runs skills from the command list and resumes the thread in a new process', async () => {
  const t = setup()
  try {
    const live = await t.open()
    const commands = t.of('codex.commands')[0]!.data.commands
    expect(commands.map((c: any) => c.name)).toEqual(['compact', 'fixture-skill'])
    live.send({ input_id: 'a', content: '/compact' })
    await wait(() => t.of('live.turn.completed').length === 1)
    expect(t.of('live.status')[0]!.data.status).toBe('compacting')
    expect(t.of('live.compact.boundary')).toHaveLength(1)
    expect(t.of('live.compact.boundary')[0]!.data.trigger).toBe('manual')
    expect(t.of('live.turn.started')[0]!.data.trigger).toBe('compact')
    live.send({ input_id: 'b', content: '/fixture-skill tidy up' })
    await wait(() => t.of('live.turn.completed').length === 2)
    expect(t.of('codex.message.final').at(-1)!.data.text).toBe(
      'heard: [skill fixture-skill] + tidy up'
    )
    const bound = t.of('codex.session.bound')[0]!.data
    await live.stop('node_stopping')
    // After a node restart the session continues on the same thread.
    const again = await t.open({
      native_session_id: bound.native_session_id,
      native_binding: {
        workspace_path: bound.workspace_path,
        policy_fingerprint: bound.policy_fingerprint,
        model: bound.model,
      },
    })
    again.send({ input_id: 'c', content: 'back' })
    await wait(() => t.of('live.turn.completed').length === 3)
    expect(t.of('codex.session.bound')[1]!.data.native_session_id).toBe(bound.native_session_id)
    expect(t.log('turn-log.jsonl').at(-1).threadId).toBe(bound.native_session_id)
    await again.stop()
  } finally {
    t.cleanup()
  }
})

it('launches with the node home and telemetry, analytics, remote and history off', async () => {
  const t = setup()
  try {
    const live = await t.open()
    const launch = JSON.parse(readFileSync(join(t.home, 'launch.json'), 'utf8'))
    const c = launch.config
    expect(c.analytics.enabled).toBe(false)
    expect(c.feedback.enabled).toBe(false)
    expect(c.otel).toMatchObject({
      exporter: 'none',
      trace_exporter: 'none',
      metrics_exporter: 'none',
      log_user_prompt: false,
      log_agent_responses: false,
    })
    expect(c.history.persistence).toBe('none')
    expect(c.check_for_update_on_startup).toBe(false)
    expect(c.web_search).toBe('disabled')
    for (const feature of ['apps', 'plugins', 'remote_plugin', 'memories', 'multi_agent'])
      expect(c.features[feature]).toBe(false)
    expect(c.permissions.abele.network.enabled).toBe(false)
    await live.stop()
  } finally {
    t.cleanup()
  }
})

it('refuses a recorded thread under another binding', async () => {
  const t = setup()
  try {
    await expect(
      t.open({
        native_session_id: 'thread-x',
        native_binding: { workspace_path: '/elsewhere', policy_fingerprint: 'f', model: 'm' },
      })
    ).rejects.toThrow('codex_native_binding_mismatch')
  } finally {
    t.cleanup()
  }
})

it('maps skills, commands and usage without trusting unexpected values', () => {
  const skills = [{ name: 'tidy', description: 'Tidy', path: '/s/SKILL.md' }]
  expect(skillInput('/tidy now', skills)).toEqual([
    { type: 'skill', name: 'tidy', path: '/s/SKILL.md' },
    { type: 'text', text: 'now', text_elements: [] },
  ])
  expect(skillInput('/other', skills)).toBeUndefined()
  expect(skillInput('plain', skills)).toBeUndefined()
  expect(commandList([{ name: '-bad', path: '/x' }, ...skills]).map((c) => c.name)).toEqual([
    'compact',
    'tidy',
  ])
  expect(contextUsage({ last: { totalTokens: -1 } }, null)).toBeUndefined()
  expect(contextUsage({ last: { totalTokens: 10 }, modelContextWindow: null }, 'm')).toMatchObject({
    total_tokens: 10,
    max_tokens: null,
    percentage: null,
    model: 'm',
  })
})
