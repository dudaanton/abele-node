import { afterEach, expect, it, vi } from 'vitest'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { NodeClient, MemoryClientStore } from '@abele/node-client'

// IPC allocation must not depend on HOME. Fail before the old allocator can write
// into the actual user's home; CLI subprocesses below get an isolated HOME too.
vi.mock('node:os', async (importActual) => {
  const actual = await importActual<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => {
      throw new Error('provider_ipc_must_not_consult_home')
    },
  }
})

vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>()
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) }
})

const directories: string[] = []
const ipcDirectories: string[] = []
afterEach(async () => {
  vi.mocked(lstatSync).mockImplementation(fs.lstatSync)
  const { cleanupRunIpc } = await import('../packages/provider-claude/src/ipc.js').catch(() => ({
    cleanupRunIpc: undefined,
  }))
  for (const directory of ipcDirectories.splice(0)) cleanupRunIpc?.(directory)
  vi.unstubAllEnvs()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it('allocates isolated short private IPC directories without consulting or writing HOME', async () => {
  const { createRunIpc, cleanupRunIpc } = await import('../packages/provider-claude/src/ipc.js')
  const first = createRunIpc(),
    second = createRunIpc()
  ipcDirectories.push(first, second)
  expect(first).not.toBe(second)
  for (const directory of [first, second]) {
    expect(Buffer.byteLength(join(directory, 'p.sock'))).toBeLessThanOrEqual(100)
    expect(realpathSync(directory)).toBe(directory)
    expect(statSync(directory).isDirectory()).toBe(true)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(statSync(directory).uid).toBe(process.getuid!())
    cleanupRunIpc(directory)
    expect(existsSync(directory)).toBe(false)
    cleanupRunIpc(directory) // Confirmed cleanup is idempotent.
  }
})

it('falls back to a short temporary root when TMPDIR is overlong', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'abele-ipc-test-'))
  directories.push(sandbox)
  const longTemp = join(sandbox, 'long-temp-'.repeat(15))
  mkdirSync(longTemp)
  vi.stubEnv('TMPDIR', longTemp)
  vi.stubEnv('TMP', longTemp)
  vi.stubEnv('TEMP', longTemp)
  const { createRunIpc } = await import('../packages/provider-claude/src/ipc.js')
  const directory = createRunIpc()
  ipcDirectories.push(directory)
  expect(Buffer.byteLength(join(directory, 'p.sock'))).toBeLessThanOrEqual(100)
  expect(dirname(directory)).toBe(realpathSync('/tmp'))
  expect(readdirSync(longTemp)).toEqual([])
})

it('cleanup refuses unmanaged paths, wrong ownership, symlinks and insecure directories', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'abele-ipc-test-'))
  directories.push(sandbox)
  const { createRunIpc, cleanupRunIpc } = await import('../packages/provider-claude/src/ipc.js')
  const unmanaged = join(sandbox, 'abele-p-ABCDEF')
  mkdirSync(unmanaged, { mode: 0o700 })
  expect(() => cleanupRunIpc(unmanaged)).toThrow('unmanaged_ipc_directory')
  expect(existsSync(unmanaged)).toBe(true)
  const directory = createRunIpc()
  ipcDirectories.push(directory)
  vi.mocked(lstatSync).mockImplementation((path) => {
    const stat = fs.lstatSync(path)
    return String(path) === directory ? Object.assign(stat, { uid: process.getuid!() + 1 }) : stat
  })
  expect(() => cleanupRunIpc(directory)).toThrow('unsafe_ipc_directory')
  expect(existsSync(directory)).toBe(true)
  vi.mocked(lstatSync).mockImplementation(fs.lstatSync)
  chmodSync(directory, 0o755)
  expect(() => cleanupRunIpc(directory)).toThrow('unsafe_ipc_directory')
  expect(existsSync(directory)).toBe(true)
  chmodSync(directory, 0o700)
  rmdirSync(directory)
  symlinkSync(unmanaged, directory)
  try {
    expect(() => cleanupRunIpc(directory)).toThrow('unsafe_ipc_directory')
    expect(existsSync(unmanaged)).toBe(true)
  } finally {
    unlinkSync(directory)
  }
})

it('cleanup tolerates the other run owner removing the directory between checks', async () => {
  const { createRunIpc, cleanupRunIpc } = await import('../packages/provider-claude/src/ipc.js')
  const directory = createRunIpc()
  ipcDirectories.push(directory)
  let removed = false
  vi.mocked(lstatSync).mockImplementation((path) => {
    const stat = fs.lstatSync(path)
    if (String(path) === directory && !removed) {
      removed = true
      rmdirSync(directory)
    }
    return stat
  })
  expect(() => cleanupRunIpc(directory)).not.toThrow()
  expect(removed).toBe(true)
  expect(existsSync(directory)).toBe(false)
})

it('a fake-provider CLI run with long custom state never creates default-home IPC state', async () => {
  const sandbox = mkdtempSync(join(tmpdir(), 'abele-ipc-cli-'))
  directories.push(sandbox)
  const home = join(sandbox, 'home'),
    repo = join(sandbox, 'repo')
  const state = join(sandbox, 'long-state-'.repeat(15), 'state')
  mkdirSync(home, { mode: 0o700 })
  mkdirSync(repo)
  writeFileSync(join(repo, 'sample.txt'), 'fixture')
  const env = { ...process.env, HOME: home }
  const command = (executable: string, args: string[], cwd = repo) => {
    const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', timeout: 10000 })
    expect(result.status, result.stderr).toBe(0)
    return result.stdout
  }
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Fixture'],
    ['config', 'user.email', 'fixture@example.invalid'],
    ['add', '.'],
    ['commit', '-m', 'fixture'],
  ])
    command('/usr/bin/git', args)
  const cli = resolve('packages/node-daemon/dist/cli.js')
  const token = JSON.parse(
    command(process.execPath, [cli, 'token', 'create', 'fixture', '--state-dir', state])
  ) as { token: string }
  let daemon: ChildProcess | undefined, client: NodeClient | undefined
  const until = async <T>(check: () => T | Promise<T>): Promise<NonNullable<T>> => {
    for (let i = 0; i < 750; i++) {
      // Check every phase, including a failing allocation, not only successful completion.
      expect(readdirSync(home)).toEqual([])
      const value = await check()
      if (value) return value as NonNullable<T>
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('IPC fixture deadline')
  }
  let ipc: string | undefined
  try {
    daemon = spawn(
      process.execPath,
      [
        cli,
        'start',
        '--state-dir',
        state,
        '--port',
        '0',
        '--claude-path',
        process.env.ABELE_CLAUDE_PATH!,
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let output = '',
      errors = ''
    daemon.stdout!.on('data', (chunk) => {
      output += chunk
    })
    daemon.stderr!.on('data', (chunk) => {
      errors += chunk
    })
    const ready = await until(() => {
      if (daemon!.exitCode !== null) throw new Error(errors)
      const record = output.split('\n').find((line) => line.includes('"listening"'))
      return record ? (JSON.parse(record) as { port: number; node_id: string }) : undefined
    })
    client = new NodeClient(
      {
        url: `ws://127.0.0.1:${ready.port}/channel`,
        profile: 'local-token-v1',
        token: token.token,
        expected_node_id: ready.node_id,
      },
      new MemoryClientStore()
    )
    await client.connect()
    const project = await client.registerProject(repo, 'trusted')
    const reservation = await client.createWorkspace(project.project_id)
    await until(async () => (await client!.getJob(reservation.job_id)).state === 'succeeded')
    const workspace = await client.getWorkspace(reservation.workspace_id)
    const session = await client.createSession('IPC fixture', workspace.workspace_id, 'claude')
    await client.subscribe(session.session_id)
    await client.send(session.session_id, 'allow', 0)
    const prompt = await until(async () =>
      (await client!.prompts(session.session_id)).find((p) => p.state === 'pending')
    )
    const invocation = JSON.parse(
      readFileSync(join(workspace.path, 'invocations.jsonl'), 'utf8').trim()
    ) as { args: string[] }
    const config = invocation.args[invocation.args.indexOf('--mcp-config') + 1]!
    ipc = dirname(config)
    expect(Buffer.byteLength(join(ipc, 'p.sock'))).toBeLessThanOrEqual(100)
    expect(ipc.startsWith(home + '/')).toBe(false)
    expect(ipc.startsWith(state + '/')).toBe(false)
    expect(statSync(ipc).mode & 0o777).toBe(0o700)
    expect(statSync(join(ipc, 'p.sock')).mode & 0o777).toBe(0o600)
    await client.answerPrompt(prompt, 'allow')
    await until(async () =>
      (await client!.history(session.session_id)).some((e) => e.type === 'input.completed')
    )
    expect(existsSync(join(workspace.path, 'action.txt'))).toBe(true)
    expect(existsSync(ipc)).toBe(false)
    expect(readdirSync(home)).toEqual([])
  } finally {
    await client?.disconnect()
    if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
      const closed = new Promise<void>((resolve) => daemon!.once('exit', () => resolve()))
      daemon.kill('SIGTERM')
      await closed
    }
    if (ipc) expect(existsSync(ipc)).toBe(false)
  }
}, 30000)
