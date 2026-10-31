import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { LiveSessionSink, LiveSession } from '@abele/provider-contract'
import { NodeCore, GitRunner, type ProviderAdapter } from '../packages/node-core/src/index.js'
import { LiveEventPayloads } from '../packages/node-protocol/src/live.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function fixture(idleMs?: number) {
  let events!: LiveSessionSink
  let inputId = ''
  let starts = 0
  const stops: string[] = []
  const dir = mkdtempSync(resolve('.scratch/live-process-exit-'))
  let finish!: (result: { reason: string; failure_reason?: string }) => void
  const adapter: ProviderAdapter = {
    available: true,
    liveAvailable: true,
    configuration: {},
    capabilities: () => ({ provider: 'codex', available: true }),
    configurationForTurn: () => ({}),
    validateSettings() {},
    sessionDefaults: () => ({
      model: 'default',
      effort: 'low',
      account: 'default',
      permission_mode: 'manual',
    }),
    reconcile: async () => {},
    startTurn: async () => {
      throw new Error('unexpected bounded turn')
    },
    startSession: async (_context, sink) => {
      events = sink
      starts++
      const done = new Promise<{ reason: string; failure_reason?: string }>((resolve) => {
        finish = resolve
      })
      const session: LiveSession = {
        done,
        send: (input) => {
          inputId = input.input_id
          sink.event({ type: 'live.input.delivered', data: { input_id: input.input_id } })
          sink.event({ type: 'live.turn.started', data: { trigger: 'input' } })
        },
        interrupt: async () => {},
        control: async () => ({}),
        stop: async (reason) => {
          stops.push(reason ?? 'stopped')
          finish({ reason: reason ?? 'stopped' })
        },
      }
      return session
    },
  }
  const core = new NodeCore(join(dir, 'state'), {
    codex: adapter,
    live: { idleMs },
    git: new GitRunner(1000, 1024, '/usr/bin/false'),
  })
  cleanups.push(async () => {
    await core.execution.stop()
    await core.resources.stop()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  const request = (method: string, params: unknown): any =>
    core.request(actor, method, params, randomUUID())
  const folder = join(dir, 'folder')
  mkdirSync(folder)
  const project = await request('project.register', { path: folder, trust: 'trusted' })
  const [workspace] = await request('workspace.list', { project_id: project.project_id })
  const target = { kind: 'workspace', workspace_id: workspace.workspace_id }
  await request('project.execution', { project_id: project.project_id, target, enabled: true })
  const session = await request('session.create', { title: 'fixture', provider: 'codex', target })
  request('session.send', { session_id: session.session_id, text: 'hold', observed_seq: 0 })
  await core.execution.drain()
  expect(core.read(session.session_id, 0).some((e) => e.type === 'turn.started')).toBe(true)
  const completed = () =>
    core.read(session.session_id, 0).find((e) => e.type === 'turn.completed')?.data
  return {
    core,
    folder,
    stops,
    starts: () => starts,
    event: (event: Parameters<LiveSessionSink['event']>[0]) => events.event(event),
    complete: () =>
      events.event({
        type: 'live.turn.completed',
        data: { outcome: 'success', input_ids: [inputId] },
      }),
    request,
    session,
    completed,
    finish: (result: Parameters<typeof finish>[0]) => finish(result),
  }
}

it('reports node-side termination on turn.completed while preserving the interrupted vocabulary', async () => {
  const f = await fixture()
  const reason = 'codex_process_inventory_unavailable:process_probe_unavailable'
  f.finish({ reason })
  await Promise.resolve()
  expect(f.completed()).toMatchObject({
    outcome: 'interrupted',
    subtype: 'process_exited',
    terminal_reason: reason,
  })
  expect(() => LiveEventPayloads['turn.completed'].parse(f.completed())).not.toThrow()
  expect(f.core.ownerStopRefusal(f.session.session_id)).toBeNull()
})

it('identifies an owner stop explicitly on the terminal turn event', async () => {
  const f = await fixture()
  await f.request('session.stop', { session_id: f.session.session_id })
  await Promise.resolve()
  await Promise.resolve()
  expect(f.completed()).toMatchObject({
    outcome: 'interrupted',
    terminal_reason: 'stopped_by_owner',
  })
})

it('preserves the original node failure on the turn when cleanup must remain quarantined', async () => {
  const f = await fixture()
  const reason = 'codex_process_inventory_unavailable:process_inventory_unavailable'
  f.finish({ reason: 'process_cleanup_unconfirmed', failure_reason: reason })
  await Promise.resolve()
  expect(f.completed()).toMatchObject({ outcome: 'interrupted', terminal_reason: reason })
  const processes = f.core
    .read(f.session.session_id, 0)
    .filter((e) => e.type === 'session.process')
    .map((e) => LiveEventPayloads['session.process'].parse(e.data))
  expect(processes.find((e) => e.state === 'exited')).toMatchObject({
    reason: 'process_cleanup_unconfirmed',
  })
})

it('ends a finished process after five idle minutes even while the chat is watched, and restarts on input', async () => {
  const f = await fixture()
  const unwatch = f.core.watch(f.session.session_id)
  try {
    f.complete()
    const completedAt = Date.now()
    const clock = vi.spyOn(Date, 'now').mockReturnValue(completedAt + 299_000)
    await f.core.execution.drain()
    expect(f.stops).toEqual([])
    clock.mockReturnValue(completedAt + 301_000)
    await f.core.execution.drain()
    await Promise.resolve()
    expect(f.stops).toEqual(['idle'])
    await f.request('session.send', {
      session_id: f.session.session_id,
      text: 'again',
      observed_seq: f.core.read(f.session.session_id, 0).at(-1)!.seq,
    })
    await f.core.execution.drain()
    expect(f.starts()).toBe(2)
  } finally {
    unwatch()
  }
})

it('closes a finished provider whose workspace folder was removed, even with idle expiry disabled', async () => {
  const f = await fixture(0)
  f.complete()
  rmSync(f.folder, { recursive: true })
  await f.core.execution.drain()
  await Promise.resolve()
  expect(f.stops).toEqual(['workspace_missing'])
})

it('does not reap an ongoing turn when its folder disappears or the idle grace expires', async () => {
  const f = await fixture(1)
  rmSync(f.folder, { recursive: true })
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
  await f.core.execution.drain()
  expect(f.stops).toEqual([])
})

it.each(['queue', 'prompt', 'tasks', 'cron', 'wake', 'compaction', 'quarantine'])(
  'preserves %s work beyond the idle grace',
  async (kind) => {
    const f = await fixture(1)
    f.complete()
    if (kind === 'queue')
      await f.request('session.send', {
        session_id: f.session.session_id,
        text: 'next',
        observed_seq: f.core.head(f.session.session_id),
      })
    if (kind === 'prompt')
      f.core.db
        .prepare('INSERT INTO prompts VALUES (?, ?, ?, ?)')
        .run('prompt', f.session.session_id, 'run', JSON.stringify({ state: 'pending' }))
    if (kind === 'tasks') f.event({ type: 'claude.tasks', data: { tasks: [{ task_id: 'task' }] } })
    if (kind === 'cron') f.event({ type: 'claude.tool.call', data: { name: 'CronCreate' } })
    if (kind === 'wake')
      f.event({
        type: 'claude.tool.call',
        data: { name: 'ScheduleWakeup', input: { delaySeconds: 3600 } },
      })
    if (kind === 'compaction') f.event({ type: 'pi.compact.started', data: {} })
    if (kind === 'quarantine') {
      f.finish({ reason: 'process_cleanup_unconfirmed' })
      await Promise.resolve()
    }
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000)
    await f.core.execution.drain()
    expect(f.stops).toEqual([])
  }
)
