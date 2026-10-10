import { expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { NodeCore, CodexProviderAdapter, type ProviderAdapter } from '@abele/node-core'
import { startCodexTurn } from '../packages/provider-codex/src/worker.js'
import { discoverCodex } from '../packages/provider-codex/src/discovery.js'
import { RpcPeer } from '../packages/provider-codex/src/rpc.js'
import { systemProcessProbe, type ProcessProbe } from '@abele/provider-claude'

async function fixture(mode: string, test: (f: any) => Promise<void>) {
  const dir = mkdtempSync(resolve('.scratch/codex-core-')),
    home = join(dir, 'home'),
    repo = join(dir, 'repo'),
    state = join(dir, 'state')
  mkdirSync(home)
  mkdirSync(repo)
  writeFileSync(join(home, 'fixture.json'), JSON.stringify({ mode }))
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
  const executable = discoverCodex({
    executable: resolve('tests/fixtures/codex.mjs'),
    fixture: true,
  })
  let beforeEvent: ((event: any) => void) | undefined, probe: ProcessProbe | undefined
  const adapter: ProviderAdapter = {
    available: true,
    configuration: {
      model: mode === 'user-model' ? null : 'fixture-small',
      permission_ttl_ms: 1000,
    },
    capabilities: () => ({ provider: 'codex', available: true }),
    configurationForTurn: () => ({}),
    reconcile: (p) => new CodexProviderAdapter({ stateDir: state }).reconcile(p),
    startTurn: (turn, sink) =>
      startCodexTurn(
        {
          executable,
          paths: { home, state, workspace: turn.cwd, sibling: dirname(turn.cwd) },
          model: mode === 'user-model' ? undefined : 'fixture-small',
          deadlineMs: 3000,
          probe,
          turn,
        },
        {
          ...sink,
          event: (e) => {
            beforeEvent?.(e)
            sink.event(e)
          },
        }
      ),
  }
  let core = new NodeCore(state, { codex: adapter })
  const token = core.createToken('owner'),
    actor = core.authority.authenticate(token.token)
  const request = (method: string, params: any) =>
    core.request(actor, method, params, randomUUID()) as any
  const wait = async (condition: () => boolean) => {
    for (let i = 0; i < 400 && !condition(); i++) await new Promise((r) => setTimeout(r, 10))
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
    const send = (text: string) =>
      request('session.send', {
        session_id: session.session_id,
        text,
        observed_seq: core.head(session.session_id),
      })
    const states = () =>
      core.db
        .prepare('SELECT state FROM inputs WHERE session_id=? ORDER BY ordinal')
        .all(session.session_id)
        .map((r) => r.state)
    await test({
      get core() {
        return core
      },
      request,
      send,
      states,
      session,
      home,
      job,
      project,
      token,
      wait,
      executable,
      processProbe: (value: ProcessProbe) => {
        probe = value
      },
      beforeEvent: (callback: (event: any) => void) => {
        beforeEvent = callback
      },
      hardRestart: async () => {
        await core.resources.stop()
        core.close()
        core = new NodeCore(state, { codex: adapter })
        await core.execution.reconcile()
      },
      restart: async () => {
        await core.execution.stop()
        await core.resources.stop()
        core.close()
        core = new NodeCore(state, { codex: adapter })
        await core.execution.reconcile()
      },
    })
  } finally {
    await core.execution.stop()
    await core.resources.stop()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
it('durably records and resumes Codex own model without requiring a configured override', async () => {
  await fixture('user-model', async (f) => {
    f.send('first')
    await f.core.execution.drain()
    await f.wait(() => f.states()[0] === 'completed')
    const binding = f.core.db
      .prepare('SELECT * FROM codex_thread_bindings WHERE session_id=?')
      .get(f.session.session_id)
    expect(binding.model).toBe('fixture-user-default')
    await f.restart()
    f.send('resume')
    await f.core.execution.drain()
    await f.wait(() => f.states()[1] === 'completed')
    const turns = readFileSync(join(f.home, 'turn-log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(turns.map((t) => t.threadId)).toEqual([binding.thread_id, binding.thread_id])
    expect(turns.every((t) => !Object.hasOwn(t, 'model'))).toBe(true)
  })
})
it('reports terminal cleanup failure as a session error and automatically releases the queued followup after retry', async () => {
  await fixture('success', async (f) => {
    let terminal = false,
      failures = 0
    f.beforeEvent((e: any) => {
      if (e.type === 'codex.turn.completed') terminal = true
    })
    f.processProbe({
      identity: (pid: number) => systemProcessProbe.identity(pid),
      groupMembers: (leader: any) => {
        if (terminal && failures++ === 0) throw new Error('injected_cleanup_failure')
        return systemProcessProbe.groupMembers(leader)
      },
    })
    f.send('first')
    f.send('queued followup')
    await f.core.execution.drain()
    await f.wait(() => f.states()[0] === 'completed')
    const error = f.core.read(f.session.session_id, 0).find((e: any) => e.type === 'session.error')
    expect(error?.data).toMatchObject({
      code: 'process_cleanup_unconfirmed',
      retrying: true,
      attempt: 1,
    })
    await f.core.execution.drain()
    await f.wait(() => f.states()[1] === 'completed')
    expect(f.states()).toEqual(['completed', 'completed'])
    expect(
      f.core.db.prepare("SELECT count(*) n FROM provider_runs WHERE state='active'").get().n
    ).toBe(0)
  })
})
it('rechecks execution authority at binding immediately before dispatch, not only on the drain timer', async () => {
  await fixture('success', async (f) => {
    f.beforeEvent((e: any) => {
      if (e.type === 'codex.session.bound') f.core.revokeToken(f.token.installation_id)
    })
    f.send('must not dispatch')
    await f.core.execution.drain()
    await f.wait(() => ['completed', 'delivery_unknown'].includes(f.states()[0]))
    expect(f.states()).toEqual(['delivery_unknown'])
    expect(existsSync(join(f.home, 'turn-log.jsonl'))).toBe(false)
    expect(
      f.core.db
        .prepare('SELECT * FROM codex_thread_bindings WHERE session_id=?')
        .get(f.session.session_id)
    ).toBeUndefined()
  })
})
it('reconciles a durable orphan before any resumed dispatch after daemon restart', async () => {
  await fixture('normal', async (f) => {
    let evidence: any[] = []
    const peer = await RpcPeer.start({
      executable: f.executable,
      cwd: f.home,
      home: f.home,
      processes: (p) => {
        evidence = p
      },
    })
    try {
      await peer.request('initialize', {})
      await peer.initialized()
      const sent = f.send('uncertain'),
        run_id = randomUUID()
      f.core.db
        .prepare("UPDATE inputs SET state='dispatching',run_id=? WHERE input_id=?")
        .run(run_id, sent.input_id)
      f.core.db
        .prepare(
          "INSERT INTO provider_runs(run_id,session_id,state,processes) VALUES(?,?,'active',?)"
        )
        .run(run_id, f.session.session_id, JSON.stringify(evidence))
      await f.hardRestart()
      expect(f.states()).toEqual(['delivery_unknown'])
      expect(
        f.core.db.prepare('SELECT state FROM provider_runs WHERE run_id=?').get(run_id).state
      ).toBe('unknown')
      expect(() => process.kill(evidence[0].pid, 0)).toThrow()
      await f.core.execution.drain()
      expect(existsSync(join(f.home, 'turn-log.jsonl'))).toBe(false)
    } finally {
      await peer.close()
    }
  })
})
it.each(['success', 'crash-before-binding', 'crash-after-binding', 'crash-after-dispatch'])(
  'durably binds before dispatch and preserves unknown outcomes after %s and restart',
  async (mode) => {
    await fixture(mode, async (f) => {
      f.send('first')
      await f.core.execution.drain()
      await f.wait(() => ['completed', 'delivery_unknown'].includes(f.states()[0]))
      expect(f.states()).toEqual([mode === 'success' ? 'completed' : 'delivery_unknown'])
      const binding = f.core.db
        .prepare('SELECT * FROM codex_thread_bindings WHERE session_id=?')
        .get(f.session.session_id)
      if (mode === 'crash-before-binding') expect(binding).toBeUndefined()
      else expect(binding.thread_id).toBe(f.core.session(f.session.session_id).native_session_id)
      const events = f.core.read(f.session.session_id, 0)
      if (mode === 'success' || mode === 'crash-after-dispatch')
        expect(events.find((e: any) => e.type === 'session.updated').seq).toBeLessThan(
          events.find((e: any) => e.type === 'codex.input.accepted').seq
        )
      await f.restart()
      expect(f.states()).toEqual([mode === 'success' ? 'completed' : 'delivery_unknown'])
      await f.core.execution.drain()
      expect(f.states()).toHaveLength(1)
      if (existsSync(join(f.home, 'turn-log.jsonl')))
        expect(
          readFileSync(join(f.home, 'turn-log.jsonl'), 'utf8').trim().split('\n')
        ).toHaveLength(1)
    })
  }
)
it.each(['allow', 'deny', 'expire', 'crash'])(
  'durably dispatches an approval once on %s; never replays consumption',
  async (choice) => {
    await fixture(choice === 'crash' ? 'approval-crash' : 'approval', async (f) => {
      f.send('permission')
      await f.core.execution.drain()
      await f.wait(() => f.core.prompts(f.session.session_id).length === 1)
      const prompt = f.core.prompts(f.session.session_id)[0]
      const workspace = f.core.resources.workspaces.get(f.job.workspace_id)
      expect(existsSync(join(workspace.path, 'approved-effect.txt'))).toBe(false)
      if (choice === 'expire') f.core.tick(prompt.expires_at + 1)
      else
        f.request('prompt.answer', {
          session_id: prompt.session_id,
          prompt_id: prompt.prompt_id,
          run_id: prompt.run_id,
          revision: 1,
          action_digest: prompt.action_digest,
          choice: choice === 'deny' ? 'deny' : 'allow',
        })
      await f.wait(() => ['completed', 'delivery_unknown'].includes(f.states()[0]))
      expect(f.states()[0]).toBe(choice === 'crash' ? 'delivery_unknown' : 'completed')
      expect(existsSync(join(workspace.path, 'approved-effect.txt'))).toBe(
        choice === 'allow' || choice === 'crash'
      )
      expect(
        f.core.read(f.session.session_id, 0).find((e: any) => e.type === 'prompt.delivered').data
          .evidence
      ).toBe('codex_rpc_dispatch_authorized')
      const responses = readFileSync(join(f.home, 'approval-responses.jsonl'), 'utf8')
        .trim()
        .split('\n')
      expect(responses).toHaveLength(1)
      await f.restart()
      await f.core.execution.drain()
      expect(
        readFileSync(join(f.home, 'approval-responses.jsonl'), 'utf8').trim().split('\n')
      ).toHaveLength(1)
    })
  }
)
it('interrupts a running Codex turn when its execution authority is revoked', async () => {
  await fixture('hang', async (f) => {
    f.send('wait')
    await f.core.execution.drain()
    await f.wait(() => f.states()[0] === 'delivered')
    f.core.revokeToken(f.token.installation_id)
    await f.core.execution.drain()
    expect(f.states()[0]).toBe('delivery_unknown')
    expect(
      f.core.db.prepare("SELECT count(*) n FROM provider_runs WHERE state='active'").get().n
    ).toBe(0)
  })
})
it('uses node-owned isolated child workspaces and explicit Codex grants, returning final text to the mailbox', async () => {
  await fixture('success', async (f) => {
    const grant = f.request('delegation.grant.create', {
      parent_id: 'plugin-chat',
      project_ids: [f.project.project_id],
      providers: ['codex'],
    })
    const child = await f.request('delegation.create', {
      grant_id: grant.grant_id,
      delegation_key: 'child',
      project_id: f.project.project_id,
      title: 'Child',
      provider: 'codex',
      text: 'child request',
    })
    await f.core.resources.jobs.drain()
    await f.core.execution.drain()
    await f.wait(
      () =>
        f.core.db.prepare('SELECT state FROM inputs WHERE session_id=?').get(child.session_id)
          .state === 'completed'
    )
    f.core.tick()
    const mailbox = f.core.read(child.mailbox_stream_id, 0)
    expect(mailbox.find((e: any) => e.type === 'delegation.result').data.text).toBe('fake response')
    expect(f.core.resources.workspaces.get(child.workspace_id).path).not.toBe(
      f.core.resources.workspaces.get(f.job.workspace_id).path
    )
  })
})
it('resumes the recorded binding after restart, queues explicit followups and reaps an interrupted turn', async () => {
  await fixture('success', async (f) => {
    f.send('first')
    await f.core.execution.drain()
    await f.wait(() => f.states()[0] === 'completed')
    await f.restart()
    const id = f.core.session(f.session.session_id).native_session_id
    writeFileSync(join(f.home, 'fixture.json'), JSON.stringify({ mode: 'hang' }))
    f.send('second')
    await f.core.execution.drain()
    await f.wait(() => f.states()[1] === 'delivered')
    const run = f.core.db
      .prepare("SELECT run_id FROM inputs WHERE session_id=? AND state='delivered'")
      .get(f.session.session_id)
    f.request('session.interrupt', { session_id: f.session.session_id, run_id: run.run_id })
    await f.core.execution.drain()
    expect(f.states()).toEqual(['completed', 'delivery_unknown'])
    expect(
      f.core.db.prepare("SELECT count(*) n FROM provider_runs WHERE state='active'").get().n
    ).toBe(0)
    const turns = readFileSync(join(f.home, 'turn-log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((s) => JSON.parse(s))
    expect(turns.map((t) => t.threadId)).toEqual([id, id])
    expect(turns.map((t) => t.input[0].text)).toEqual(['first', 'second'])
  })
})
it('refuses a new thread after an unknown unbound dispatch instead of guessing latest context', async () => {
  await fixture('crash-before-binding', async (f) => {
    f.send('unknown')
    await f.core.execution.drain()
    await f.wait(() => f.states()[0] === 'delivery_unknown')
    await f.restart()
    writeFileSync(join(f.home, 'fixture.json'), JSON.stringify({ mode: 'success' }))
    f.send('followup')
    await f.core.execution.drain()
    await f.wait(() => f.states()[1] === 'delivery_unknown')
    expect(
      Object.keys(JSON.parse(readFileSync(join(f.home, 'threads.json'), 'utf8')))
    ).toHaveLength(1)
    expect(existsSync(join(f.home, 'turn-log.jsonl'))).toBe(false)
    expect(
      f.core
        .read(f.session.session_id, 0)
        .some((e: any) => e.data.reason === 'codex_native_binding_missing')
    ).toBe(true)
  })
})
