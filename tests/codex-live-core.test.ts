import { expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { NodeCore, CodexProviderAdapter, type ProviderAdapter } from '@abele/node-core'
import { discoverCodex } from '../packages/provider-codex/src/discovery.js'
import { startCodexLiveSession } from '../packages/provider-codex/src/live.js'

it('runs an owner Codex chat as one live process: steering, stop, compaction, resume after restart', async () => {
  const dir = mkdtempSync(resolve('.scratch/codex-live-core-')),
    home = join(dir, 'home'),
    repo = join(dir, 'repo'),
    state = join(dir, 'state')
  mkdirSync(home)
  mkdirSync(repo)
  writeFileSync(join(home, 'fixture.json'), JSON.stringify({ mode: 'live' }))
  const git = (...args: string[]) =>
    expect(spawnSync('/usr/bin/git', args, { cwd: repo, encoding: 'utf8' }).status).toBe(0)
  git('init', '-b', 'main')
  git(
    '-c',
    'user.name=T',
    '-c',
    'user.email=t@example.invalid',
    'commit',
    '--allow-empty',
    '-m',
    'f'
  )
  const executable = discoverCodex({
    executable: resolve('tests/fixtures/codex.mjs'),
    fixture: true,
  })
  const settings = {
    model: 'default',
    effort: 'low',
    account: 'default',
    permission_mode: 'manual',
  }
  let started = 0
  const adapter: ProviderAdapter = {
    available: true,
    liveAvailable: true,
    configuration: { model: null, permission_ttl_ms: 1000 },
    capabilities: () => ({ provider: 'codex', available: true }),
    configurationForTurn: () => ({}),
    reconcile: (p) => new CodexProviderAdapter({ stateDir: state }).reconcile(p),
    startTurn: () => Promise.reject(new Error('owner chats are live')),
    sessionDefaults: () => settings,
    validateSettings: () => {},
    startSession: (context, sink) => {
      started++
      return startCodexLiveSession(
        {
          executable,
          paths: { home, state, workspace: context.cwd, sibling: dirname(context.cwd) },
          context,
        },
        sink
      )
    },
  }
  let core = new NodeCore(state, { codex: adapter })
  const token = core.createToken('owner'),
    actor = () => core.authority.authenticate(token.token)
  const request = (method: string, params: any) =>
    core.request(actor(), method, params, randomUUID()) as any
  const wait = async (condition: () => boolean) => {
    for (let i = 0; i < 500 && !condition(); i++) await new Promise((r) => setTimeout(r, 10))
    expect(condition()).toBe(true)
  }
  try {
    const project = await request('project.register', { path: repo, trust: 'trusted' })
    const job = await request('workspace.create', { project_id: project.project_id })
    await core.resources.jobs.drain()
    const session = request('session.create', {
      title: 'codex',
      provider: 'codex',
      workspace_id: job.workspace_id,
    })
    const id = session.session_id
    const send = (text: string) =>
      request('session.send', { session_id: id, text, observed_seq: core.head(id) })
    const states = () =>
      core.db
        .prepare('SELECT state FROM inputs WHERE session_id=? ORDER BY ordinal')
        .all(id)
        .map((r: any) => r.state)
    const journal = (type: string): any[] => core.read(id, 0).filter((e: any) => e.type === type)

    send('hold on')
    await core.execution.drain()
    await wait(() => journal('turn.started').length === 1)
    expect(request('session.state', { session_id: id })).toMatchObject({
      live: true,
      process: 'running',
    })
    // Written while it works: steered into the running turn.
    send('one more thing')
    await core.execution.drain()
    await wait(() => states().join() === 'completed,completed')
    expect(journal('turn.completed').at(-1).data.input_ids).toHaveLength(2)
    expect(journal('session.context').at(-1).data.percentage).toBe(25)
    expect(journal('codex.commands')).toHaveLength(1)
    // Codex records reach the shared transcript vocabulary and the per-session command list.
    const kinds = new Set(journal('session.update').map((e) => e.data.update.kind))
    expect(kinds).toContain('agent_message')
    expect(kinds).toContain('available_commands_update')
    expect(
      request('session.commands', { session_id: id }).commands.map((c: any) => c.name)
    ).toEqual(['compact', 'fixture-skill'])
    expect(started).toBe(1)

    // Stop mid-turn keeps the process.
    send('hold again')
    await core.execution.drain()
    await wait(() => journal('turn.started').length === 2)
    const run_id = request('session.state', { session_id: id }).run_id
    request('session.interrupt', { session_id: id, run_id })
    await wait(() => states()[2] === 'interrupted')

    // Compaction from the node's own method, then the continuation it queues.
    request('session.compact', { session_id: id, continue: false })
    await core.execution.drain()
    await wait(() => journal('compaction.completed').length === 1)
    expect(journal('compaction.started')).toHaveLength(1)
    expect(started).toBe(1)

    // A node restart: the next message resumes the same thread in a new process.
    const thread = core.session(id).native_session_id
    expect(thread).toBeTruthy()
    await core.execution.stop()
    await core.resources.stop()
    core.close()
    core = new NodeCore(state, { codex: adapter })
    await core.execution.reconcile()
    send('after restart')
    await core.execution.drain()
    await wait(() => states().at(-1) === 'completed')
    expect(started).toBe(2)
    const turns = readFileSync(join(home, 'turn-log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l))
    expect(new Set(turns.map((t) => t.threadId))).toEqual(new Set([thread]))
  } finally {
    await core.execution.stop()
    await core.resources.stop()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
