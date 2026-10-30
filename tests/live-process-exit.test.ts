import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { LiveSession } from '@abele/provider-contract'
import { NodeCore, GitRunner, type ProviderAdapter } from '../packages/node-core/src/index.js'
import { LiveEventPayloads } from '../packages/node-protocol/src/live.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})
async function fixture() {
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
      const done = new Promise<{ reason: string; failure_reason?: string }>((resolve) => {
        finish = resolve
      })
      const session: LiveSession = {
        done,
        send: (input) => {
          sink.event({ type: 'live.input.delivered', data: { input_id: input.input_id } })
          sink.event({ type: 'live.turn.started', data: { trigger: 'input' } })
        },
        interrupt: async () => {},
        control: async () => ({}),
        stop: async (reason) => {
          finish({ reason: reason ?? 'stopped' })
        },
      }
      return session
    },
  }
  const core = new NodeCore(join(dir, 'state'), {
    codex: adapter,
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
