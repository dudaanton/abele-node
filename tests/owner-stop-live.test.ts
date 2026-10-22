import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeCore, GitRunner, type ProviderAdapter } from '@abele/node-core'
import type { LiveSession, LiveSessionSink } from '@abele/provider-contract'
import { SessionMessageTools } from '../packages/node-core/dist/session-messages.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const close of cleanups.splice(0)) await close()
})

async function fixture(provider: 'pi' | 'codex') {
  const dir = mkdtempSync(join(tmpdir(), 'owner-stop-'))
  // Scheduling test: no Git effects or operating-system process supervision.
  const git = join(dir, 'fake-git')
  writeFileSync(git, '#!/bin/sh\nexit 1\n')
  chmodSync(git, 0o700)
  const sinks: LiveSessionSink[] = []
  const dispatched: string[] = []
  let releaseStart: (() => void) | undefined
  let blockStart = false
  let quarantine = false
  const settings = {
    model: 'default',
    effort: 'low',
    account: 'default',
    permission_mode: 'bypassPermissions',
  }
  const adapter: ProviderAdapter = {
    available: true,
    liveAvailable: true,
    configuration: { permission_modes: ['manual', 'bypassPermissions'] },
    capabilities: () => ({ provider, available: true }),
    configurationForTurn: () => ({}),
    validateSettings: () => {},
    sessionDefaults: () => settings,
    startTurn: async () => {
      throw new Error('unexpected bounded turn')
    },
    reconcile: async () => {
      if (quarantine) throw new Error('cleanup failed')
    },
    startSession: async (_context, sink) => {
      sinks.push(sink)
      if (blockStart)
        await new Promise<void>((resolve) => {
          releaseStart = resolve
        })
      let finish!: (result: { reason?: string }) => void
      const done = new Promise<{ reason?: string }>((resolve) => {
        finish = resolve
      })
      const session: LiveSession = {
        done,
        send: (input) => {
          dispatched.push(input.input_id)
          sink.event({ type: 'live.input.delivered', data: { input_id: input.input_id } })
          sink.event({ type: 'live.turn.started', data: { trigger: 'input' } })
        },
        interrupt: async () => {},
        control: async () => ({}),
        stop: async (reason) => {
          finish({ reason: quarantine ? 'process_cleanup_unconfirmed' : reason })
        },
      }
      return session
    },
  }
  const core = new NodeCore(join(dir, 'state'), {
    [provider]: adapter,
    git: new GitRunner(1000, 1024, git),
  })
  const owner = core.authority.authenticate(core.createToken('owner').token)
  const manager = core.authority.authenticate(core.createToken('manager').token)
  const request = (method: string, params: unknown) =>
    core.request(owner, method, params, crypto.randomUUID()) as any
  cleanups.push(async () => {
    quarantine = false
    releaseStart?.()
    await core.execution.stop()
    await core.resources.stop()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  })
  let folders = 0
  const makeSession = async () => {
    const repo = join(dir, 'folder-' + folders++)
    mkdirSync(repo)
    const project = await request('project.register', { path: repo, trust: 'trusted' })
    const [workspace] = await request('workspace.list', { project_id: project.project_id })
    const target = { kind: 'workspace', workspace_id: workspace.workspace_id }
    await request('project.execution', { project_id: project.project_id, target, enabled: true })
    return (await request('session.create', { title: 'Child', provider, target }))
      .session_id as string
  }
  return {
    core,
    request,
    manager,
    makeSession,
    sinks,
    dispatched,
    block: () => {
      blockStart = true
    },
    release: () => {
      blockStart = false
      releaseStart?.()
    },
    quarantine: () => {
      quarantine = true
    },
  }
}

it.each(['pi', 'codex'] as const)(
  '%s persists Stop before asynchronous startup returns and dispatches no queued input',
  async (provider) => {
    const f = await fixture(provider)
    const id = await f.makeSession()
    f.block()
    f.request('session.send', { session_id: id, text: 'queued', observed_seq: 0 })
    const drain = f.core.execution.drain()
    // Runtime target resolution is asynchronous; wait for the controlled startup boundary.
    for (let i = 0; i < 100 && !f.sinks.length; i++)
      await new Promise((resolve) => setTimeout(resolve, 10))
    expect(f.sinks, JSON.stringify(f.core.read(id, 0))).toHaveLength(1)
    f.request('session.stop', { session_id: id })
    expect(f.request('session.state', { session_id: id })).toMatchObject({
      owner_stopped: true,
      stop_generation: 1,
      stop_reason: 'stopped_by_owner',
    })
    expect(
      f.core.acceptInput(f.manager, { session_id: id, text: 'manager resume', observed_seq: 0 })
    ).toMatchObject({ code: 'owner_restart_required' })
    f.release()
    await drain
    expect(f.dispatched).toEqual([])
    expect(f.request('session.state', { session_id: id }).owner_stopped).toBe(true)
  }
)

it.each(['pi', 'codex'] as const)(
  '%s fences live interrupt, compaction continuation and cleanup failure without blocking another session',
  async (provider) => {
    const f = await fixture(provider)
    const id = await f.makeSession()
    const input = f.request('session.compact', { session_id: id, continue: true })
    await f.core.execution.drain()
    expect(f.dispatched, JSON.stringify(f.core.read(id, 0))).toEqual([input.input_id])
    const run_id = f.request('session.state', { session_id: id }).run_id
    f.sinks[0]!.event({ type: 'live.status', data: { status: 'compacting' } })
    f.quarantine()
    f.request('session.interrupt', { session_id: id, run_id })
    // A terminal provider record arriving after Stop cannot clear intent or queue continuation.
    f.sinks[0]!.event({
      type: 'live.compact.boundary',
      data: { trigger: 'manual', pre_tokens: 10, post_tokens: 5 },
    })
    f.sinks[0]!.event({
      type: 'live.turn.completed',
      data: { input_ids: [input.input_id], outcome: 'success' },
    })
    await Promise.resolve()
    await f.core.execution.drain()
    expect(f.core.read(id, 0).filter((e) => e.type === 'input.accepted')).toHaveLength(1)
    expect(
      f.core.acceptInput(f.manager, { session_id: id, text: 'bypass resume', observed_seq: 0 })
    ).toMatchObject({ code: 'owner_restart_required' })
    // Interrupt preserves the idle process; hard Stop exercises cleanup quarantine.
    f.request('session.stop', { session_id: id })
    await Promise.resolve()
    await f.core.execution.drain()
    expect(() =>
      f.request('session.owner_restart', {
        session_id: id,
        text: 'owner',
        observed_seq: 0,
        stop_generation: 2,
      })
    ).toThrow('resource_busy')
    const other = await f.makeSession()
    const fresh = f.request('session.send', {
      session_id: other,
      text: 'unrelated',
      observed_seq: 0,
    })
    await f.core.execution.drain()
    expect(f.dispatched).toEqual([input.input_id, fresh.input_id])
  }
)

it('does not replay a controller input stopped while dispatch awaited a checkpoint', async () => {
  const f = await fixture('pi')
  const id = await f.makeSession()
  let release!: () => void
  let capturing!: () => void
  const captured = new Promise<void>((resolve) => {
    capturing = resolve
  })
  const checkpoint = new Promise<void>((resolve) => {
    release = resolve
  })
  const capture = vi.spyOn(f.core.chatCheckpoints, 'capture').mockImplementation(async () => {
    capturing()
    await checkpoint
  })
  f.request('session.send', { session_id: id, text: 'old input', observed_seq: 0 })
  const drain = f.core.execution.drain()
  try {
    await captured
    f.request('session.stop', { session_id: id })
  } finally {
    release()
  }
  await drain
  capture.mockRestore()
  await f.core.execution.drain()
  expect(f.dispatched).toEqual([])
  expect(
    f.core.db
      .prepare('SELECT state FROM inputs WHERE session_id=?')
      .all(id)
      .map((r) => r.state)
  ).not.toContain('queued')
  expect(
    f.request('session.owner_restart', {
      session_id: id,
      stop_generation: 1,
      text: 'fresh input',
      observed_seq: 0,
    })
  ).toHaveProperty('input_id')
  await f.core.execution.drain()
  expect(f.dispatched).toHaveLength(1)
})

it('does not dispatch an interrupted controller input after a legacy owner send clears the fence during its checkpoint', async () => {
  const f = await fixture('pi')
  const id = await f.makeSession()
  let release!: () => void
  let entered!: () => void
  const capturing = new Promise<void>((resolve) => {
    entered = resolve
  })
  const checkpoint = new Promise<void>((resolve) => {
    release = resolve
  })
  const capture = vi.spyOn(f.core.chatCheckpoints, 'capture').mockImplementation(async () => {
    entered()
    await checkpoint
  })
  f.core.transaction(() =>
    f.core.acceptInput(f.manager, {
      session_id: id,
      text: 'old controller input',
      observed_seq: 0,
      script: [{ kind: 'echo' }],
    })
  )
  const drain = f.core.execution.drain()
  let fresh: any
  try {
    await capturing
    const run_id = f.request('session.state', { session_id: id }).run_id
    f.request('session.interrupt', { session_id: id, run_id })
    fresh = f.request('session.send', {
      session_id: id,
      text: 'fresh owner input',
      observed_seq: 0,
    })
    expect(fresh).toHaveProperty('input_id')
  } finally {
    release()
  }
  await drain
  capture.mockRestore()
  await f.core.execution.drain()
  expect(f.dispatched).toEqual([fresh.input_id])
  expect(f.sinks).toHaveLength(1)
})

it.each(['pi', 'codex'] as const)(
  '%s retains the interrupted idle process for ordinary owner input while its manager tool stays fenced',
  async (provider) => {
    const f = await fixture(provider)
    const id = await f.makeSession()
    const manager = await f.makeSession()
    const first = f.request('session.send', { session_id: id, text: 'owner work', observed_seq: 0 })
    await f.core.execution.drain()
    const run_id = f.request('session.state', { session_id: id }).run_id
    f.request('session.interrupt', { session_id: id, run_id })
    f.sinks[0]!.event({
      type: 'live.turn.completed',
      data: { input_ids: [first.input_id], outcome: 'interrupted', subtype: 'cancelled' },
    })
    await Promise.resolve()
    await f.core.execution.drain()
    expect(f.request('session.state', { session_id: id }).process).toBe('idle')
    expect(
      f.core
        .read(id, 0)
        .filter((e) => e.type === 'turn.completed')
        .at(-1)!.data
    ).toMatchObject({ outcome: 'interrupted', subtype: 'cancelled' })
    const tools = new SessionMessageTools(
      f.core,
      f.core.claude.live,
      { session_id: manager, run_id: 'manager-run', principal: f.manager.installation_id },
      () => true
    )
    try {
      expect(
        await tools.call('node_session_send', { session_id: id, text: 'controller retry' })
      ).toMatchObject({ code: 'owner_restart_required' })
    } finally {
      tools.close()
    }
    const next = f.request('session.send', {
      session_id: id,
      text: 'ordinary owner restart',
      observed_seq: 0,
    })
    expect(next).toHaveProperty('input_id')
    await f.core.execution.drain()
    expect(f.dispatched).toEqual([first.input_id, next.input_id])
    expect(f.sinks).toHaveLength(1)
  }
)
