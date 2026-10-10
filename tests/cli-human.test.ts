import { afterEach, expect, it } from 'vitest'
import { spawnSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { humanOutput, humanError } from '../packages/node-daemon/src/output.js'

const available = { available: true, provider_version: '2.1.291' }
const unavailable = {
  available: false,
  diagnostic: 'Executable missing. Run sh install.sh --claude-path /path/to/claude and restart.',
}
const status = {
  running: true,
  version: '0.3.2',
  port: 7777,
  node_id: 'node-one',
  claude: available,
  pi: { available: true, provider_version: '0.87.0' },
  paired: null,
  projects: 2,
  workspaces: 3,
}
it.each([
  ['running local', status],
  [
    'stopped unavailable',
    {
      ...status,
      running: false,
      node_id: undefined,
      claude: unavailable,
      pi: { available: false, diagnostic: 'Install and build pinned SDK 0.87.0.' },
      projects: 0,
      workspaces: 0,
    },
  ],
  [
    'paired remote',
    {
      ...status,
      paired: { endpoint: 'wss://node.example:8443/channel' },
      tailscale: { node_mapping: true },
    },
  ],
  ['unreadable counts', { ...status, projects: null, workspaces: null }],
])('human status: %s', (_, value) => {
  expect(humanOutput(['status'], value)).toMatchSnapshot()
})
it.each([true, false])('doctor checklist: healthy=%s', (healthy) => {
  expect(
    humanOutput(['doctor'], {
      node: 'v22.23.2',
      sqlite: 'node:sqlite, WAL, foreign_keys=ON, synchronous=FULL',
      state_dir: '/state',
      state_mode: healthy ? '700' : '755',
      running: healthy,
      runtime: { version: '0.3.2' },
      launch_agent: healthy,
      claude: healthy ? available : unavailable,
      pi: healthy
        ? { available: true, provider_version: '0.87.0' }
        : {
            available: false,
            diagnostic: 'Install and build pinned SDK 0.87.0 with audited brace-expansion 5.0.12',
          },
      paired: { endpoint: 'wss://node.example:8443/channel' },
      tailscale: Object.fromEntries(
        [
          'present',
          'logged_in',
          'magicdns',
          'https',
          'endpoint_matches',
          'node_mapping',
          'local_token_unmapped',
          'policy_verified',
        ].map((key) => [key, healthy])
      ),
      encrypted_at_rest: false,
    })
  ).toMatchSnapshot()
})
it.each([
  [['start'], { port: 7777, node_id: 'node-one', paired_port: 8888 }],
  [['stop'], { stopping: 42, service_unloaded: true }],
  [['stop'], { stopping: null, service_unloaded: null }],
  [['install'], { installed: '/agents/node.plist', runtime: '/runtime' }],
  [['token', 'create'], { installation_id: 'install-one', token: 'secret-once' }],
  [
    ['token', 'list'],
    [
      { installation_id: 'install-one', label: 'desktop', revoked: 0 },
      { installation_id: 'install-two', label: 'old', revoked: 1 },
    ],
  ],
  [['token', 'list'], []],
  [['token', 'revoke'], { revoked: 'install-one' }],
  [
    ['pair', 'invite'],
    {
      endpoint: 'wss://node.example/channel',
      node_id: 'node-one',
      node_fingerprint: 'fingerprint',
      invite_id: 'invite-one',
      secret: 'secret',
      expires_at: 1800000000000,
    },
  ],
  [['pair', 'list'], []],
  [
    ['pair', 'confirm'],
    { installation_id: 'install-one', state: 'confirmed', device_fingerprint: 'fingerprint' },
  ],
  [['pair', 'revoke'], { revoked: 'install-one' }],
  [['pair', 'rotate'], { node_key: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } }],
  [['serve', 'enable'], { action: 'enable', completed: true }],
  [['serve', 'disable'], { action: 'disable', completed: true }],
] as [string[], unknown][])('human command %j', (args, value) => {
  expect(humanOutput(args, value)).toMatchSnapshot()
})
it('errors are one sentence with a code', () => {
  expect(humanError(new Error('already_running'))).toMatchSnapshot()
  expect(humanError(new Error('bad\nconfiguration'))).toBe(
    'Could not complete the command: bad configuration. (command_failed)'
  )
})

mkdirSync('.scratch', { recursive: true })
const dirs: string[] = []
let child: ChildProcess | undefined
const cli = resolve('packages/node-daemon/dist/cli.js')
function fixture() {
  const dir = mkdtempSync(resolve('.scratch/cli-human-'))
  dirs.push(dir)
  return dir
}
function command(state: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    [
      cli,
      ...args,
      '--state-dir',
      state,
      '--claude-path',
      '/nonexistent/claude',
      '--tailscale-path',
      '/nonexistent/tailscale',
    ],
    { encoding: 'utf8' }
  )
}
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exit = new Promise<void>((done) => child!.once('exit', () => done()))
    child.kill('SIGTERM')
    await exit
  }
  child = undefined
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
it('stopped status is human by default, read-only, and JSON retains its exact keys', () => {
  const state = join(fixture(), 'absent')
  const human = command(state, 'status')
  expect(human.status, human.stderr).toBe(0)
  expect(human.stdout).toContain('AbeleNode: not running')
  expect(human.stdout).toContain('Projects: 0; workspaces: 0')
  expect(human.stdout).toContain('Claude: unavailable')
  expect(human.stdout).toContain('Port: 7777')
  expect(existsSync(state)).toBe(false)
  const json = command(state, 'status', '--json')
  expect(json.status, json.stderr).toBe(0)
  const report = JSON.parse(json.stdout)
  expect(Object.keys(report).sort()).toEqual(['claude', 'running', 'state_dir', 'tailscale'])
  expect(report).toMatchObject({
    running: false,
    state_dir: state,
    claude: { provider: 'claude', available: false },
    tailscale: { present: false },
  })
  const doctor = JSON.parse(command(state, 'doctor', '--json').stdout)
  expect(Object.keys(doctor).sort()).toEqual([
    'claude',
    'codex',
    'encrypted_at_rest',
    'launch_agent',
    'node',
    'paired',
    'pi',
    'profile',
    'running',
    'runtime',
    'sqlite',
    'state_dir',
    'state_mode',
    'tailscale',
  ])
  expect(doctor).toMatchObject({
    running: false,
    runtime: null,
    paired: null,
    state_mode: null,
    encrypted_at_rest: false,
    profile: 'local-token-v1 (loopback only)',
  })
})
it('human status reads persisted identity and registered project/workspace counts', () => {
  const state = fixture(),
    db = new DatabaseSync(join(state, 'node.sqlite'))
  db.exec(
    "CREATE TABLE meta(key TEXT, value TEXT); INSERT INTO meta VALUES('node_id','persisted-node'); CREATE TABLE projects(registered INTEGER); INSERT INTO projects VALUES(1),(0); CREATE TABLE workspaces(id TEXT, state TEXT); INSERT INTO workspaces VALUES('one','ready'),('two','ready'),('old','removed');"
  )
  db.close()
  const result = command(state, 'status')
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('Node ID: persisted-node')
  expect(result.stdout).toContain('Projects: 1; workspaces: 2')
})
it('token JSON schemas and human enrollment/revocation retain semantics', () => {
  const state = fixture()
  const created = command(state, 'token', 'create', 'desktop', '--json')
  expect(created.status, created.stderr).toBe(0)
  const token = JSON.parse(created.stdout)
  expect(Object.keys(token).sort()).toEqual(['installation_id', 'token'])
  expect(token.token).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.parse(command(state, 'token', 'list', '--json').stdout)).toEqual([
    { installation_id: token.installation_id, label: 'desktop', revoked: 0 },
  ])
  expect(command(state, 'token', 'list').stdout).toContain(
    `${token.installation_id} — desktop (active)`
  )
  expect(
    JSON.parse(command(state, 'token', 'revoke', token.installation_id, '--json').stdout)
  ).toEqual({ revoked: token.installation_id })
  expect(command(state, 'token', 'list').stdout).toContain('(revoked)')
  const human = command(state, 'token', 'create', 'second')
  expect(human.status, human.stderr).toBe(0)
  expect(human.stdout).toMatch(/Installation token: [a-f0-9]{64}\nClick Add node\./)
  expect(human.stdout).toContain('Shown once')
  expect(human.stdout).toContain('Abele Settings → Nodes')
  expect(human.stdout).not.toContain('Installation ID:')
})
it('token next steps match the plugin fields and configured local port', () => {
  const result = command(fixture(), 'token', 'create', 'desktop', '--port', '7799')
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('Label: any name you like')
  expect(result.stdout).toContain('URL: http://127.0.0.1:7799')
  expect(result.stdout).toMatch(/Installation token: [a-f0-9]{64}/)
  expect(result.stdout).toContain('Add node')
  expect(result.stdout).not.toMatch(/Paste the installation ID|ws:\/\/|node_id/)
})
it('argument errors use human codes while --json preserves legacy errors and version', () => {
  const state = fixture()
  expect(command(state, 'status', '--port', 'bad').stderr).toBe(
    'Could not complete the command: invalid port. (invalid_port)\n'
  )
  expect(command(state, 'status', '--port', 'bad', '--json').stderr).toBe('invalid_port\n')
  expect(command(state, 'status', '--port', 'bad').status).toBe(1)
  const version = JSON.parse(readFileSync('package.json', 'utf8')).version
  expect(command(state, 'version', '--json').stdout).toBe(version + '\n')
  expect(command(state, '--json', '--version').stdout).toBe(version + '\n')
})
it.each([false, true])(
  'foreground startup JSON=%s and live JSON keeps its old schema',
  async (json) => {
    const state = fixture()
    child = spawn(
      process.execPath,
      [
        cli,
        ...(json ? ['--json'] : []),
        'start',
        '--state-dir',
        state,
        '--port',
        '0',
        '--claude-path',
        '/nonexistent/claude',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stdout = '',
      stderr = ''
    child.stdout!.on('data', (data) => (stdout += data))
    child.stderr!.on('data', (data) => (stderr += data))
    for (let i = 0; i < 200 && !stdout.includes(json ? 'listening' : 'AbeleNode running'); i++) {
      if (child.exitCode !== null) throw new Error(stderr)
      await new Promise((done) => setTimeout(done, 20))
    }
    if (json) {
      const listening = JSON.parse(stdout)
      expect(Object.keys(listening).sort()).toEqual(['node_id', 'pid', 'port', 'type'])
      expect(listening).toMatchObject({ type: 'listening', pid: child.pid })
      expect(listening.port).toBeGreaterThan(0)
    } else expect(stdout).toMatch(/^AbeleNode running on port \d+; node ID [a-f0-9-]+\.\n$/)
    const result = command(state, 'status', '--json')
    expect(result.status, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(Object.keys(report).sort()).toEqual([
      'claude',
      'codex',
      'control_socket',
      'node_id',
      'pi',
      'pid',
      'port',
      'running',
      'runtime',
      'state_dir',
      'tailscale',
    ])
    expect(report).toMatchObject({
      running: true,
      codex: { provider: 'codex', available: false },
      runtime: { version: JSON.parse(readFileSync('package.json', 'utf8')).version },
    })
    expect(command(state, 'status').stdout).toContain(`Port: ${report.port}`)
    // No --port here: enrollment must discover the live ephemeral port.
    const token = command(state, 'token', 'create', 'live')
    expect(token.status, token.stderr).toBe(0)
    expect(token.stdout).toContain(`URL: http://127.0.0.1:${report.port}`)
    expect(command(state, 'status').stdout).toContain('Projects: 0; workspaces: 0')
  }
)

it('unreadable state reports unknown counts without modifying the database', () => {
  const state = fixture(),
    db = new DatabaseSync(join(state, 'node.sqlite'))
  db.exec('CREATE TABLE unexpected(value TEXT)')
  db.close()
  const before = readFileSync(join(state, 'node.sqlite'))
  const result = command(state, 'status')
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('Projects: unknown; workspaces: unknown')
  expect(result.stdout).toContain('Node ID: unknown')
  expect(readFileSync(join(state, 'node.sqlite'))).toEqual(before)
})

it.each([false, true])(
  'does not treat application encryption=%s as disk encryption evidence',
  (encrypted) => {
    const output = humanOutput(['doctor'], { encrypted_at_rest: encrypted })
    expect(output).toContain(
      'UNKNOWN Disk encryption: could not be determined; check FileVault or your operating system’s disk-encryption settings'
    )
    expect(output).not.toContain('PROBLEM Encryption at rest')
    expect(output).not.toContain('enable disk encryption')
  }
)
it('doctor keeps storage internals in JSON and gives actionable default diagnostics', () => {
  const state = join(fixture(), 'absent')
  const human = command(state, 'doctor')
  expect(human.status, human.stderr).toBe(0)
  expect(human.stdout).toContain('OK Local storage: available')
  for (const internal of ['node:sqlite', 'WAL', 'foreign_keys', 'synchronous'])
    expect(human.stdout).not.toContain(internal)
  expect(human.stdout).toContain('UNKNOWN Disk encryption: could not be determined')
  const json = command(state, 'doctor', '--json')
  expect(json.status, json.stderr).toBe(0)
  expect(JSON.parse(json.stdout)).toMatchObject({
    sqlite: 'node:sqlite, WAL, foreign_keys=ON, synchronous=FULL',
    encrypted_at_rest: false,
  })
})
it('doctor gives a repair when local storage is unavailable', () => {
  expect(humanOutput(['doctor'], { sqlite: null })).toContain(
    'PROBLEM Local storage: unavailable; fix: reinstall AbeleNode with Node.js 22 or newer'
  )
})

it.each([
  [
    'launch_agent_stop_unconfirmed',
    'Could not confirm that the AbeleNode service and its daemon stopped',
  ],
  ['launch_agent_load_unconfirmed', 'Could not confirm that the AbeleNode service loaded'],
  ['launch_agent_start_unconfirmed', 'Could not confirm that the AbeleNode service started'],
  ['launch_agent_state_unconfirmed', 'Could not confirm the AbeleNode service state'],
] as const)('explains %s clearly while retaining its code', (code, explanation) => {
  for (const suffix of ['', ': diagnostic output\nrecorded pid still present']) {
    expect(humanError(new Error(code + suffix))).toBe(`${explanation}. (${code})`)
  }
})
