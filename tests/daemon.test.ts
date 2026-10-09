import { afterEach, expect, it } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import WebSocket from 'ws'
import { FileClientStore } from './fileStore.js'
import {
  NodeClient,
  MemoryClientStore,
  LocalChannelConnector,
} from '../packages/node-client/src/index.js'
import { FrameCodec } from '../packages/channel-protocol/src/index.js'
import {
  processScenarioDeadline,
  processStepDeadlineMs,
  waitForProcessCondition,
  withProcessDeadline,
} from '../scripts/process-test-budget.mjs'
const commandOptions = {
  encoding: 'utf8',
  timeout: processStepDeadlineMs,
  killSignal: 'SIGKILL',
} as const

mkdirSync('.scratch', { recursive: true })
const dirs: string[] = []
const children: ChildProcess[] = []
const clients: NodeClient[] = []
const cli = resolve('packages/node-daemon/dist/cli.js')
const eventually = (test: () => Promise<boolean>) =>
  waitForProcessCondition(test, 'CLI daemon convergence')
async function start(dir: string) {
  const child = spawn(process.execPath, [cli, 'start', '--state-dir', dir, '--port', '0'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  let text = ''
  let err = ''
  child.stderr!.on('data', (d) => {
    err += d
  })
  child.stdout!.on('data', (d) => {
    text += d
  })
  await eventually(async () => {
    if (child.exitCode !== null) throw new Error(err)
    return text.includes('"listening"')
  })
  const ready = JSON.parse(
    text
      .trim()
      .split('\n')
      .find((l) => l.includes('"listening"'))!
  ) as { port: number; node_id: string }
  return { child, ...ready }
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((r) => child.once('exit', () => r()))
  child.kill('SIGTERM')
  try {
    await withProcessDeadline(() => exited, 'CLI daemon cleanup')
  } catch (error) {
    child.kill('SIGKILL')
    await withProcessDeadline(() => exited, 'CLI daemon forced exit')
    throw error
  }
}
afterEach(async () => {
  for (const c of clients.splice(0)) await c.disconnect()
  for (const p of children.splice(0)) await stop(p)
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

it(
  'CLI diagnostics resolve a symlinked existing ancestor without creating stopped state',
  { timeout: processScenarioDeadline(5) },
  async () => {
    const dir = mkdtempSync(resolve('.scratch/canonical-state-'))
    dirs.push(dir)
    const parent = resolve(dir, 'physical')
    const alias = resolve(dir, 'alias')
    mkdirSync(parent)
    symlinkSync(parent, alias)
    const state = resolve(alias, 'not-created', 'state')
    const expected = resolve(realpathSync(parent), 'not-created', 'state')
    const status = () =>
      spawnSync(
        process.execPath,
        [cli, 'status', '--state-dir', state, '--tailscale-path', '/nonexistent/tailscale'],
        commandOptions
      )
    const stopped = status()
    expect(stopped.status, stopped.stderr).toBe(0)
    expect(JSON.parse(stopped.stdout)).toMatchObject({ state_dir: expected, running: false })
    expect(() => statSync(expected)).toThrow()
    const daemon = await start(state)
    const running = status()
    expect(running.status, running.stderr).toBe(0)
    expect(JSON.parse(running.stdout)).toMatchObject({ state_dir: expected, running: true })
    const doctor = spawnSync(
      process.execPath,
      [cli, 'doctor', '--state-dir', state, '--tailscale-path', '/nonexistent/tailscale'],
      commandOptions
    )
    expect(doctor.status, doctor.stderr).toBe(0)
    expect(JSON.parse(doctor.stdout)).toMatchObject({
      state_dir: expected,
      running: true,
      state_mode: '700',
    })
    await stop(daemon.child)
  }
)
it(
  'real CLI daemon: offline persisted send, prompt, concurrent clients, replay/live and restart converge',
  { timeout: processScenarioDeadline(8) },
  async () => {
    const dir = mkdtempSync(resolve('.scratch/e2e-'))
    dirs.push(dir)
    const makeToken = (label: string) => {
      const p = spawnSync(
        process.execPath,
        [cli, 'token', 'create', label, '--state-dir', dir],
        commandOptions
      )
      expect(p.status, p.stderr).toBe(0)
      return JSON.parse(p.stdout) as { token: string; installation_id: string }
    }
    const t1 = makeToken('one'),
      t2 = makeToken('two')
    let daemon = await start(dir)
    const target = (token: string) => ({
      url: `ws://127.0.0.1:${daemon.port}/channel`,
      token,
      profile: 'local-token-v1' as const,
      expected_node_id: daemon.node_id,
    })
    const store = new FileClientStore(resolve(dir, 'client-one.json'))
    let first = new NodeClient(target(t1.token), store)
    clients.push(first)
    const second = new NodeClient(target(t2.token), new MemoryClientStore())
    clients.push(second)
    await Promise.all([first.connect(), second.connect()])
    const session = await first.createSession('Acceptance')
    expect(await second.listSessions()).toContainEqual(session)
    await Promise.all([first.subscribe(session.session_id), second.subscribe(session.session_id)])
    await first.disconnect()
    const op = await first.send(session.session_id, 'offline', 0, [
      { kind: 'permission', ttl_ms: 60000 },
      { kind: 'echo' },
    ])
    first = new NodeClient(target(t1.token), new FileClientStore(store.path))
    clients.push(first)
    await first.connect()
    await first.subscribe(session.session_id)
    await eventually(async () =>
      (await first.prompts(session.session_id)).some((p) => p.state === 'pending')
    )
    const prompt = (await first.prompts(session.session_id)).find((p) => p.state === 'pending')!
    await Promise.all([first.answerPrompt(prompt, 'allow'), second.answerPrompt(prompt, 'deny')])
    await Promise.all([
      first.send(session.session_id, 'one', 0),
      second.send(session.session_id, 'two', 0),
    ])
    await eventually(
      async () =>
        (await first.history(session.session_id)).filter(
          (e) => e.type === 'input.completed' || e.type === 'input.failed'
        ).length === 3
    )
    expect(await first.operationResult(op.operation_id)).toBeDefined()
    const before = await first.history(session.session_id)
    await first.disconnect()
    await second.disconnect()
    await stop(daemon.child)
    daemon = await start(dir)
    first = new NodeClient(target(t1.token), new FileClientStore(store.path))
    const observer = new NodeClient(target(t2.token), new MemoryClientStore())
    clients.push(first, observer)
    await Promise.all([first.connect(), observer.connect()])
    await Promise.all([first.subscribe(session.session_id), observer.subscribe(session.session_id)])
    await eventually(
      async () => (await observer.history(session.session_id)).length === before.length
    )
    expect(await observer.history(session.session_id)).toEqual(before)
    expect(await first.history(session.session_id)).toEqual(before)
    expect(before.filter((e) => e.type === 'input.accepted')).toHaveLength(3)
    expect(
      new Set(before.filter((e) => e.type === 'input.accepted').map((e) => JSON.stringify(e.actor)))
        .size
    ).toBe(2)
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(resolve(dir, 'node.sqlite')).mode & 0o777).toBe(0o600)
    const duplicate = spawnSync(
      process.execPath,
      [cli, 'start', '--state-dir', dir, '--port', '0'],
      commandOptions
    )
    expect(duplicate.status).not.toBe(0)
    expect(duplicate.stderr).toContain('already_running')
  }
)

it(
  'a lost mutation response and a failed local receipt commit retry the same operation only once',
  { timeout: processScenarioDeadline(4) },
  async () => {
    const dir = mkdtempSync(resolve('.scratch/retry-'))
    dirs.push(dir)
    const t = JSON.parse(
      spawnSync(
        process.execPath,
        [cli, 'token', 'create', 'retry', '--state-dir', dir],
        commandOptions
      ).stdout
    ) as { token: string }
    const daemon = await start(dir),
      target = {
        url: `ws://127.0.0.1:${daemon.port}/channel`,
        token: t.token,
        profile: 'local-token-v1' as const,
      }
    const base = new LocalChannelConnector()
    let lose = false
    const connector = {
      connect: async (connection: typeof target) => {
        const channel = await base.connect(connection),
          original = channel.transport
        return {
          ...channel,
          transport: {
            send: original.send.bind(original),
            close: original.close.bind(original),
            receive: async function* () {
              for await (const bytes of original.receive()) {
                const frame = FrameCodec.decode(bytes)
                if (lose && frame.kind === 'response' && frame.operation_id) {
                  lose = false
                  await original.close('injected_response_loss')
                  return
                }
                yield bytes
              }
            },
          },
        }
      },
    }
    const store = new MemoryClientStore(),
      client = new NodeClient(target, store, connector)
    clients.push(client)
    await client.connect()
    const session = await client.createSession('retry')
    await client.subscribe(session.session_id)
    lose = true
    await expect(client.send(session.session_id, 'response lost', 0)).rejects.toThrow(
      'outcome_unknown'
    )
    const pending = await client.pending()
    expect(pending).toHaveLength(1)
    await client.connect()
    expect(await client.pending()).toHaveLength(0)
    expect(await client.operationResult(pending[0]!.operation_id)).toBeDefined()
    // Inject failure only when the durable receipt would remove the outbox.
    let failReceipt = true
    const wrapped = {
      transaction: async <T>(
        work: (s: import('../packages/node-client/src/index.js').ClientState) => T | Promise<T>
      ) =>
        store.transaction(async (s) => {
          const before = Object.keys(s.results).length
          const r = await work(s)
          if (failReceipt && Object.keys(s.results).length > before) {
            failReceipt = false
            throw new Error('receipt_storage_failure')
          }
          return r
        }),
    }
    await client.disconnect()
    const reloaded = new NodeClient(target, wrapped)
    clients.push(reloaded)
    await reloaded.connect()
    await expect(reloaded.send(session.session_id, 'receipt lost', 0)).rejects.toThrow(
      'receipt_storage_failure'
    )
    const again = await reloaded.pending()
    expect(again).toHaveLength(1)
    await reloaded.disconnect()
    await reloaded.connect()
    await reloaded.subscribe(session.session_id)
    await eventually(
      async () =>
        (await reloaded.history(session.session_id)).filter((e) => e.type === 'input.accepted')
          .length === 2
    )
    expect(
      (await reloaded.history(session.session_id)).filter((e) => e.type === 'input.accepted')
    ).toHaveLength(2)
  }
)

it(
  'wrong/revoked/cross-node tokens and hostile origins fail admission',
  { timeout: processScenarioDeadline(4) },
  async () => {
    const dir = mkdtempSync(resolve('.scratch/auth-'))
    dirs.push(dir)
    const t = JSON.parse(
      spawnSync(
        process.execPath,
        [cli, 'token', 'create', 'auth', '--state-dir', dir],
        commandOptions
      ).stdout
    ) as { token: string; installation_id: string }
    const daemon = await start(dir)
    const url = `ws://127.0.0.1:${daemon.port}/channel`
    const bad = new NodeClient(
      { url, profile: 'local-token-v1', token: '0'.repeat(64) },
      new MemoryClientStore()
    )
    clients.push(bad)
    await expect(bad.connect()).rejects.toThrow()
    const hostile = new WebSocket(url, { origin: 'https://evil.example' })
    hostile.on('error', () => {})
    await new Promise<void>((r) => hostile.on('close', () => r()))
    expect(hostile.readyState).toBe(WebSocket.CLOSED)
    const wrongHost = new WebSocket(url, { headers: { Host: '127.0.0.1:1' } })
    wrongHost.on('error', () => {})
    let admitted = false
    wrongHost.once('open', () => {
      admitted = true
      wrongHost.terminate()
    })
    await new Promise<void>((r) => wrongHost.once('close', () => r()))
    expect(admitted).toBe(false)
    const good = new NodeClient(
      { url, profile: 'local-token-v1', token: t.token },
      new MemoryClientStore()
    )
    clients.push(good)
    await good.connect()
    // Revocation through protected local CLI IPC, never a second database owner.
    const revoked = spawnSync(
      process.execPath,
      [cli, 'token', 'revoke', t.installation_id, '--state-dir', dir],
      commandOptions
    )
    expect(revoked.status, revoked.stderr).toBe(0)
    await expect(good.listSessions()).rejects.toThrow()
    const retry = new NodeClient(
      { url, profile: 'local-token-v1', token: t.token },
      new MemoryClientStore()
    )
    clients.push(retry)
    await expect(retry.connect()).rejects.toThrow()
    const raw = new WebSocket(url)
    raw.on('error', () => {})
    await new Promise<void>((r) => raw.once('open', () => r()))
    raw.send(FrameCodec.encode({ kind: 'auth', profile: 'local-token-v1', token: '0'.repeat(64) }))
    await new Promise<void>((r) => raw.on('close', () => r()))
  }
)
