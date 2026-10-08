import { it, expect } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  cpSync,
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { NodeClient, MemoryClientStore } from '@abele/node-client'
import { identity } from '../packages/provider-claude/src/supervisor.js'
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until<T>(test: () => T | Promise<T>, ms = 15000): Promise<NonNullable<T>> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const value = await test()
    if (value) return value as NonNullable<T>
    await delay(20)
  }
  throw new Error('fixture deadline')
}
it('drives protected approvals, expiry, bridge loss, serialized queue, interrupt and abrupt daemon resume through node-client', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abele-claude-daemon-')),
    state = join(dir, 'state'),
    repo = join(dir, 'repo'),
    executable = join(dir, 'claude-fixture.mjs'),
    cli = resolve('packages/node-daemon/dist/cli.js')
  const children = new Set<ChildProcess>(),
    clients = new Set<NodeClient>()
  const command = (cwd: string, exe: string, args: string[]) => {
    const r = spawnSync(exe, args, { cwd, encoding: 'utf8', timeout: 10000 })
    expect(r.status, r.stderr).toBe(0)
    return r.stdout.trim()
  }
  const git = (...args: string[]) => command(repo, '/usr/bin/git', args)
  const start = async () => {
    const child = spawn(
      process.execPath,
      [
        cli,
        'start',
        '--state-dir',
        state,
        '--port',
        '0',
        '--claude-path',
        executable,
        '--claude-profile',
        'isolated',
        '--permission-ttl-ms',
        '700',
        '--claude-deadline-ms',
        '15000',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    children.add(child)
    let text = '',
      error = ''
    child.stdout!.on('data', (d) => (text += d))
    child.stderr!.on('data', (d) => (error += d))
    const info = await until(() => {
      if (child.exitCode !== null) throw new Error(error)
      const line = text.split('\n').find((l) => l.includes('"listening"'))
      return line ? (JSON.parse(line) as { port: number; node_id: string }) : null
    })
    return { child, ...info }
  }
  const stop = async (child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM') => {
    if (child.exitCode !== null || child.signalCode !== null) return
    const exit = new Promise((r) => child.once('exit', r))
    child.kill(signal)
    await exit
    children.delete(child)
  }
  const connect = async (
    daemon: { port: number; node_id: string },
    token: string,
    store: MemoryClientStore
  ) => {
    const c = new NodeClient(
      {
        url: `ws://127.0.0.1:${daemon.port}/channel`,
        profile: 'local-token-v1',
        token,
        expected_node_id: daemon.node_id,
      },
      store
    )
    clients.add(c)
    await c.connect()
    return c
  }
  const send = async (c: NodeClient, s: string, text: string) => {
    const op = await c.send(s, text, await c.cursor(s))
    const r = await c.operationResult(op.operation_id)
    return (r!.result as { input_id: string }).input_id
  }
  const completed = async (c: NodeClient, s: string, input_id: string, state = 'completed') =>
    until(async () => {
      const e = (await c.history(s)).find(
        (e) =>
          e.type === 'input.' + state && (e.data as { input_id?: string }).input_id === input_id
      )
      return e
    })
  const prompt = async (c: NodeClient, s: string) =>
    until(async () => (await c.prompts(s)).find((p) => p.state === 'pending'))
  try {
    mkdirSync(repo)
    git('init', '-b', 'main')
    git('config', 'user.name', 'Test')
    git('config', 'user.email', 'test@example.invalid')
    writeFileSync(join(repo, 'tracked.txt'), 'original')
    git('add', '.')
    git('commit', '-m', 'fixture')
    cpSync(resolve('tests/fixtures/claude.mjs'), executable)
    chmodSync(executable, 0o700)
    const auth = JSON.parse(
      command(dir, process.execPath, [cli, 'token', 'create', 'fixture', '--state-dir', state])
    ) as { token: string }
    let daemon = await start()
    const store = new MemoryClientStore()
    let a = await connect(daemon, auth.token, store),
      b = await connect(daemon, auth.token, new MemoryClientStore())
    expect(await a.describe()).toHaveProperty('providers')
    const doctor = JSON.parse(
      command(dir, process.execPath, [cli, 'doctor', '--state-dir', state])
    ) as { claude: { configuration: { profile: string; executable: string } } }
    expect(doctor.claude.configuration.profile).toBe('isolated')
    expect(doctor.claude.configuration.executable).toBe(realpathSync(executable))
    const project = await a.registerProject(repo, 'trusted')
    const jobs = await Promise.all([
      a.createWorkspace(project.project_id),
      a.createWorkspace(project.project_id),
    ])
    for (const job of jobs)
      await until(async () => (await a.getJob(job.job_id)).state === 'succeeded')
    const workspaces = await Promise.all(jobs.map((j) => a.getWorkspace(j.workspace_id)))
    const sessions = await Promise.all(
      workspaces.map((w) => a.createSession('Claude', w.workspace_id, 'claude'))
    )
    for (const s of sessions) await a.subscribe(s.session_id)
    const one = await send(a, sessions[0]!.session_id, 'allow'),
      two = await send(a, sessions[1]!.session_id, 'allow'),
      follow = await send(a, sessions[0]!.session_id, 'echo')
    const p1 = await prompt(a, sessions[0]!.session_id),
      p2 = await prompt(a, sessions[1]!.session_id)
    const invocation = JSON.parse(
      readFileSync(join(workspaces[0]!.path, 'invocations.jsonl'), 'utf8').trim()
    ) as { args: string[] }
    expect(invocation.args).not.toContain('--continue')
    expect(invocation.args[invocation.args.indexOf('--setting-sources') + 1]).toBe('')
    const config = invocation.args[invocation.args.indexOf('--mcp-config') + 1]!
    expect(statSync(config).mode & 0o777).toBe(0o600)
    expect(statSync(join(config, '..')).mode & 0o777).toBe(0o700)
    const allow = await a.answerPrompt(p1, 'allow')
    await a.answerPrompt(p2, 'deny')
    // The winner is immutable, but delivery is a separate committed transition.
    // Wait for that transition rather than racing a false -> true delivery flag.
    const delivered = await until(async () =>
      (await a.prompts(sessions[0]!.session_id)).find(
        (p) => p.prompt_id === p1.prompt_id && p.delivered
      )
    )
    expect(delivered).toEqual({ ...allow, delivered: true })
    expect(await b.answerPrompt(p1, 'deny')).toEqual(delivered)
    await Promise.all([
      completed(a, sessions[0]!.session_id, one),
      completed(a, sessions[1]!.session_id, two),
      completed(a, sessions[0]!.session_id, follow),
    ])
    expect(existsSync(join(workspaces[0]!.path, 'action.txt'))).toBe(true)
    expect(existsSync(join(workspaces[1]!.path, 'action.txt'))).toBe(false)
    expect((await a.prompts(sessions[0]!.session_id))[0]!.delivered).toBe(true)
    const history = await a.history(sessions[0]!.session_id)
    expect(
      history.filter(
        (e) =>
          e.type === 'prompt.delivered' &&
          (e.data as { prompt_id?: string }).prompt_id === p1.prompt_id
      )
    ).toHaveLength(1)
    expect(
      history.find(
        (e) => e.type === 'run.started' && (e.data as { input_id?: string }).input_id === follow
      )!.seq
    ).toBeGreaterThan(
      history.find(
        (e) => e.type === 'input.completed' && (e.data as { input_id?: string }).input_id === one
      )!.seq
    )
    const failure = await send(a, sessions[0]!.session_id, 'api-error')
    await completed(a, sessions[0]!.session_id, failure, 'failed')
    const failedRun = (await a.history(sessions[0]!.session_id)).find(
      (e) => e.type === 'run.started' && (e.data as { input_id?: string }).input_id === failure
    )!.data as { run_id: string }
    await until(async () =>
      (await a.history(sessions[0]!.session_id)).find(
        (e) =>
          e.type === 'claude.process.exit' &&
          (e.data as { run_id?: string; exit_code?: number }).run_id === failedRun.run_id &&
          (e.data as { exit_code?: number }).exit_code === 1
      )
    )
    const timeout = await send(a, sessions[1]!.session_id, 'allow')
    const expired = await prompt(a, sessions[1]!.session_id)
    await completed(a, sessions[1]!.session_id, timeout)
    expect(
      (await a.prompts(sessions[1]!.session_id)).find((p) => p.prompt_id === expired.prompt_id)
    ).toMatchObject({ state: 'expired', choice: 'deny', delivered: true })
    expect(existsSync(join(workspaces[1]!.path, 'action.txt'))).toBe(false)
    const lost = await send(a, sessions[1]!.session_id, 'allow'),
      loss = await prompt(a, sessions[1]!.session_id)
    process.kill(Number(readFileSync(join(workspaces[1]!.path, 'bridge.pid'), 'utf8')), 'SIGKILL')
    await completed(a, sessions[1]!.session_id, lost)
    expect(
      (await a.prompts(sessions[1]!.session_id)).find((p) => p.prompt_id === loss.prompt_id)
    ).toMatchObject({ state: 'invalidated', choice: 'deny', delivered: false })
    const hanging = await send(a, sessions[1]!.session_id, 'late-result')
    await until(() => existsSync(join(workspaces[1]!.path, 'descendant.pid')))
    const run = (await a.history(sessions[1]!.session_id)).find(
      (e) => e.type === 'run.started' && (e.data as { input_id?: string }).input_id === hanging
    )!.data as { run_id: string }
    await a.interrupt(sessions[1]!.session_id, run.run_id)
    await expect(a.detachSession(sessions[1]!.session_id)).rejects.toThrow(/resource_busy/)
    await completed(a, sessions[1]!.session_id, hanging, 'delivery_unknown')
    const queued = await send(a, sessions[1]!.session_id, 'echo')
    await completed(a, sessions[1]!.session_id, queued)
    expect(
      identity(Number(readFileSync(join(workspaces[1]!.path, 'descendant.pid'), 'utf8')))
    ).toBeUndefined()
    expect(
      (await a.history(sessions[1]!.session_id)).find(
        (e) => e.type === 'claude.result' && (e.data as { run_id?: string }).run_id === run.run_id
      )?.data
    ).toMatchObject({ late: true })
    const native = (await a.getSession(sessions[0]!.session_id)).native_session_id!
    const crashed = await send(a, sessions[0]!.session_id, 'hang')
    await until(() => existsSync(join(workspaces[0]!.path, 'descendant.pid')))
    const pid = Number(readFileSync(join(workspaces[0]!.path, 'descendant.pid'), 'utf8'))
    await a.disconnect()
    await b.disconnect()
    await stop(daemon.child, 'SIGKILL')
    await until(() => !identity(pid))
    daemon = await start()
    a = await connect(daemon, auth.token, store)
    await completed(a, sessions[0]!.session_id, crashed, 'delivery_unknown')
    const resumed = await send(a, sessions[0]!.session_id, 'echo')
    await completed(a, sessions[0]!.session_id, resumed)
    expect((await a.getSession(sessions[0]!.session_id)).native_session_id).toBe(native)
    const invocations = readFileSync(join(workspaces[0]!.path, 'invocations.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { resume: string | null; text: string })
    expect(invocations).toHaveLength(5)
    expect(invocations[0]!.resume).toBeNull()
    expect(invocations.slice(1).every((r) => r.resume === native)).toBe(true)
    expect(invocations.filter((r) => r.text === 'hang')).toHaveLength(1)
    const final = await a.history(sessions[1]!.session_id)
    expect(
      final.some(
        (e) => e.type === 'run.completed' && (e.data as { run_id?: string }).run_id === run.run_id
      )
    ).toBe(false)
    expect(git('status', '--porcelain')).toBe('')
  } finally {
    for (const c of clients) await c.disconnect().catch(() => {})
    for (const child of children) await stop(child)
    rmSync(dir, { recursive: true, force: true })
  }
}, 45000)
