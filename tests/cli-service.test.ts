import { afterEach, expect, it } from 'vitest'
import { spawnSync, spawn } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  readlinkSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { humanOutput } from '../packages/node-daemon/src/output.js'

const cli = resolve('packages/node-daemon/dist/cli.js')
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function run(entry: string, state: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    [
      entry,
      ...args,
      '--state-dir',
      state,
      '--claude-path',
      '/nonexistent/claude',
      '--tailscale-path',
      '/nonexistent/tailscale',
      '--no-codex',
    ],
    { encoding: 'utf8', timeout: 10000 }
  )
}
function fixture() {
  mkdirSync('.scratch', { recursive: true })
  const home = realpathSync(mkdtempSync(resolve('.scratch/service-cli-')))
  dirs.push(home)
  const root = join(home, 'share/abele-node'),
    version = JSON.parse(readFileSync('package.json', 'utf8')).version
  const runtime = join(root, version),
    state = join(home, 'state')
  mkdirSync(join(runtime, 'packages/node-daemon'), { recursive: true })
  mkdirSync(state)
  cpSync('packages/node-daemon/dist', join(runtime, 'packages/node-daemon/dist'), {
    recursive: true,
  })
  cpSync('package.json', join(runtime, 'package.json'))
  symlinkSync(resolve('node_modules'), join(runtime, 'node_modules'))
  symlinkSync(version, join(root, 'current'))
  writeFileSync(join(root, '.installer-owned'), '')
  const s = statSync(state, { bigint: true })
  const config = {
    version,
    prefix: home,
    state,
    state_identity: s.dev + ':' + s.ino,
    claude: '/nonexistent/claude',
    service: 0,
  }
  const configFile = join(root, 'config.json')
  writeFileSync(configFile, JSON.stringify(config))
  // Fake the transactional installer boundary, never call a live service manager.
  writeFileSync(
    join(runtime, 'install.sh'),
    `#!/bin/sh\nexec '${process.execPath}' '${join(runtime, 'fake-installer.cjs')}' "$@"\n`
  )
  writeFileSync(
    join(runtime, 'fake-installer.cjs'),
    `const fs=require('node:fs');const file=${JSON.stringify(configFile)};const args=process.argv.slice(2);const action=args[args.indexOf('--service-action')+1];const c=JSON.parse(fs.readFileSync(file));fs.appendFileSync(${JSON.stringify(join(home, 'actions'))},action+'\\n');fs.appendFileSync(${JSON.stringify(join(home, 'installer-args'))},JSON.stringify(args)+'\\n');if(action!=='adopt-debugger')c.service=action==='enable'?1:0;if(args.includes('--debugger')||action==='adopt-debugger')c.debugger_enabled=true;if(args.includes('--no-debugger'))c.debugger_enabled=false;if(args.includes('--paired-config'))c.paired_config=args[args.indexOf('--paired-config')+1];if(args.includes('--no-paired-config'))c.paired_config='';fs.writeFileSync(file,JSON.stringify(c));`
  )
  return {
    entry: join(runtime, 'packages/node-daemon/dist/cli.js'),
    home,
    state,
    config,
    configFile,
  }
}

it.each(['status', 'service'])('%s explains that no service is installed', (command) => {
  const f = fixture()
  const result = run(
    f.entry,
    f.state,
    command,
    ...(command === 'service' ? ['status'] : []),
    '--json'
  )
  expect(result.status, result.stderr).toBe(0)
  const report = JSON.parse(result.stdout)
  const service = command === 'status' ? report.service : report
  expect(service.ownership).toBe('none')
  expect(service.ownership_help).toBe('No installed service; run abele-node service enable first.')
})

it('sets service flags through the installer and rejects invalid values before mutation', () => {
  const f = fixture()
  writeFileSync(f.configFile, JSON.stringify({ ...f.config, service: 1 }))
  const bad = run(f.entry, f.state, 'service', 'flags', 'set', '--permission-ttl-ms', '0')
  expect(bad.status).not.toBe(0)
  const result = run(f.entry, f.state, 'service', 'flags', 'set', '--pi-max-tokens', '12345')
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).not.toMatch(/^\s*\{/)
  const calls = readFileSync(join(f.home, 'installer-args'), 'utf8').trim().split('\n')
  expect(calls).toHaveLength(1)
  expect(JSON.parse(calls[0]!)).toContain('{"--pi-max-tokens":"12345"}')
})
it('routes explicit bypass opt-in and opt-out through the fingerprinted installer boundary', () => {
  const f = fixture()
  writeFileSync(f.configFile, JSON.stringify({ ...f.config, service: 1 }))
  for (const mode of ['on', 'off']) {
    const result = run(f.entry, f.state, 'service', 'flags', 'set', '--allow-bypass', mode)
    expect(result.status, result.stderr).toBe(0)
  }
  const calls = readFileSync(join(f.home, 'installer-args'), 'utf8').trim().split('\n')
  expect(calls).toHaveLength(2)
  expect(JSON.parse(calls[0]!)).toContain('{"--allow-bypass":"on"}')
  expect(JSON.parse(calls[1]!)).toContain('{"--allow-bypass":"off"}')
  expect(run(f.entry, f.state, 'service', 'flags', 'set', '--allow-bypass', 'yes').status).not.toBe(
    0
  )
  expect(readFileSync(join(f.home, 'installer-args'), 'utf8').trim().split('\n')).toHaveLength(2)
})

it('shows service arguments as plain text by default and JSON only on request', () => {
  const f = fixture(),
    file = join(f.home, 'service.plist')
  const args = ['/node', '/runtime/cli.js', 'start', '--pi-max-tokens', '32768']
  writeFileSync(
    file,
    process.platform === 'darwin'
      ? '<key>ProgramArguments</key><array>' +
          args.map((a) => `<string>${a}</string>`).join('') +
          '</array>'
      : 'ExecStart=' + args.map((a) => JSON.stringify(a)).join(' ')
  )
  writeFileSync(f.configFile, JSON.stringify({ ...f.config, service: 1, service_file: file }))
  const plain = run(f.entry, f.state, 'service', 'flags', 'show')
  expect(plain.status, plain.stderr).toBe(0)
  expect(plain.stdout).toBe(
    'Permission TTL: 60000 ms\nPi deadline: 1800000 ms\nPi max tokens: 32768\nDebugger: off\nAllow bypass: off\n'
  )
  const json = run(f.entry, f.state, 'service', 'flags', 'show', '--json')
  expect(JSON.parse(json.stdout)).toEqual({ flags: ['--pi-max-tokens', '32768'] })
})

it.each(['status', 'doctor', 'service'])(
  '%s explains modified service ownership in human text',
  (command) => {
    const service = {
      enabled: true,
      ownership: 'modified',
      ownership_help: 'Restore the original service and use abele-node service flags set.',
    }
    const text = humanOutput([command], command === 'service' ? service : { service })
    expect(text).toContain('modified')
    expect(text).toContain('abele-node service flags set')
    expect(text).not.toMatch(/^\s*\{/)
  }
)

it.each([
  ['--help'],
  ['help'],
  ['start', '--help'],
  ['help', 'start'],
  ['service', 'enable', '--help'],
  ['help', 'service'],
  ['update', '--help'],
])('help %j exits zero without starting anything', (...args) => {
  const f = fixture(),
    result = run(f.entry, f.state, ...args)
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('Usage:')
  expect(result.stdout).toContain('service enable')
  expect(result.stderr).toBe('')
  expect(readFileSync(f.configFile, 'utf8')).toBe(JSON.stringify(f.config))
})
it.each([
  'start',
  'status',
  'doctor',
  'stop',
  'install',
  'service',
  'update',
  'pair',
  'token',
  'debugger',
  'version',
])('rejects unknown flags for %s before effects', (command) => {
  const f = fixture(),
    result = run(f.entry, f.state, command, '--background')
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Unknown option: --background')
  expect(result.stderr).toContain('service enable')
  expect(readFileSync(f.configFile, 'utf8')).toBe(JSON.stringify(f.config))
})
it('service commands are human by default, JSON on request, and preserve recorded state', () => {
  const f = fixture()
  const status = run(f.entry, f.state, 'service', 'status')
  expect(status.status, status.stderr).toBe(0)
  expect(status.stdout).toContain('Mode: foreground')
  expect(run(f.entry, f.state, 'service', 'enable').stdout).toContain('background service')
  const json = run(f.entry, f.state, 'service', 'status', '--json')
  expect(JSON.parse(json.stdout)).toMatchObject({
    enabled: true,
    mode: 'service',
    managed: true,
    state_dir: f.state,
  })
  expect(run(f.entry, f.state, 'service', 'disable').stdout).toContain('foreground')
  expect(JSON.parse(readFileSync(f.configFile, 'utf8'))).toMatchObject({
    service: 0,
    state: f.state,
    state_identity: f.config.state_identity,
  })
})
it('service debugger commands use the installer boundary and default to plain text', () => {
  const f = fixture()
  const on = run(f.entry, f.state, 'service', 'debugger', 'on')
  expect(on.status, on.stderr).toBe(0)
  expect(on.stdout).toContain('Mode: background service')
  expect(on.stdout).toContain('Debugger: on')
  expect(installerArgs(f.home)[0]).toContain('--debugger')
  const off = run(f.entry, f.state, 'service', 'debugger', 'off', '--json')
  expect(off.status, off.stderr).toBe(0)
  expect(JSON.parse(off.stdout)).toMatchObject({ managed: true, debugger_enabled: false })
  expect(installerArgs(f.home)[1]).toContain('--no-debugger')
  const adopt = run(f.entry, f.state, 'service', 'debugger', 'adopt')
  expect(adopt.status, adopt.stderr).toBe(0)
  expect(installerArgs(f.home)[2]).toContain('adopt-debugger')
  expect(run(f.entry, f.state, 'service', 'debugger', 'maybe').status).toBe(1)
  expect(installerArgs(f.home)).toHaveLength(3)
})
it('start in a service installation invokes enable and never creates a foreground daemon', () => {
  const f = fixture()
  writeFileSync(f.configFile, JSON.stringify({ ...f.config, service: 1 }))
  const result = run(f.entry, f.state, 'start')
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('background service')
  expect(result.stdout).not.toContain('listening')
  expect(readFileSync(join(f.home, 'actions'), 'utf8')).toBe('enable\n')
})
it('announces foreground mode before slow provider preparation', async () => {
  const f = fixture(),
    runtime = resolve(f.entry, '../../../..')
  const preload = join(runtime, 'slow-start.mjs')
  writeFileSync(
    preload,
    `import { CodexProviderAdapter } from '@abele/node-core';
    CodexProviderAdapter.prototype.prepare = async () => { await new Promise(r => setTimeout(r, 60000)) }`
  )
  const child = spawn(
    process.execPath,
    [
      '--import',
      preload,
      f.entry,
      'start',
      '--state-dir',
      f.state,
      '--claude-path',
      '/nonexistent/claude',
      '--codex-path',
      '/nonexistent/codex',
      '--port',
      '0',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let output = ''
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  try {
    for (let i = 0; i < 50 && !output.includes('foreground'); i++)
      await new Promise((r) => setTimeout(r, 20))
    expect(output).toContain('foreground')
    expect(output).toContain('Ctrl-C')
    expect(output).toContain('abele-node service enable')
  } finally {
    const closed = new Promise<void>((done) => child.once('close', () => done()))
    child.kill('SIGTERM')
    await closed
  }
})
function activeTransition(f: ReturnType<typeof fixture>) {
  const runtime = resolve(f.entry, '../../../..'),
    root = resolve(runtime, '..')
  // ps is denied in the Mac test sandbox. Supply only process-group inspection;
  // retain the real recovery guard and lock handling.
  writeFileSync(
    join(runtime, 'service-transition.mjs'),
    `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const originalSpawnSync = childProcess.spawnSync;
    childProcess.spawnSync = (command, args, options) => command === '/bin/ps'
      ? { status: 0, stdout: args.includes('pgid=') ? String(process.pid) : '${process.pid} ${process.pid} S', stderr: '' }
      : originalSpawnSync(command, args, options);
    syncBuiltinESMExports();
  ` + readFileSync('scripts/service-transition.mjs', 'utf8')
  )
  // The recovery guard refuses a live owner even without a journal. No real
  // installer, daemon or service manager is involved in this reproduction.
  symlinkSync(`service-group:${process.pid}`, join(root, '.install-lock'))
  return root
}
it('service status observes an active transition without recovering or changing it', () => {
  const f = fixture(),
    root = activeTransition(f)
  const before = readFileSync(f.configFile, 'utf8')
  const result = run(f.entry, f.state, 'service', 'status')
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('Mode: foreground')
  expect(result.stdout).toContain('transition pending')
  expect(result.stderr).toBe('')
  expect(readlinkSync(join(root, '.install-lock'))).toBe(`service-group:${process.pid}`)
  expect(readFileSync(f.configFile, 'utf8')).toBe(before)
  const json = run(f.entry, f.state, 'service', 'status', '--json')
  expect(json.status, json.stderr).toBe(0)
  expect(JSON.parse(json.stdout)).toMatchObject({ mode: 'foreground', transition_pending: true })
})
it.each([false, true])('expected recovery refusals have no raw stack (JSON=%s)', (json) => {
  const f = fixture()
  activeTransition(f)
  const result = run(f.entry, f.state, 'start', ...(json ? ['--json'] : []))
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Another service transition is active')
  expect(result.stderr).not.toContain('service-transition.mjs:')
  expect(result.stderr).not.toMatch(/\bat (?:\w|file:)|asyncRunEntryPointWithESMLoader/)
})
it.each([['start'], ['service', 'enable'], ['service', 'status'], ['install']])(
  'recovers before mutation, but reports pending state without recovery for status: %j',
  (...args) => {
    const f = fixture(),
      runtime = resolve(f.entry, '../../../..')
    const original = JSON.stringify({ ...f.config, service: 1 })
    writeFileSync(f.configFile, JSON.stringify({ ...f.config, version: 'broken' }))
    const root = resolve(runtime, '..'),
      pending = join(root, '.service-transition')
    mkdirSync(pending)
    writeFileSync(
      join(runtime, 'service-transition.mjs'),
      `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(f.configFile)},${JSON.stringify(original)});fs.rmSync(${JSON.stringify(pending)},{recursive:true});`
    )
    const result = run(f.entry, f.state, ...args)
    expect(result.status, result.stderr).toBe(0)
    if (args[0] === 'service' && args[1] === 'status') {
      expect(result.stdout).toContain('Mode: unknown')
      expect(result.stdout).toContain('Configuration problem:')
      expect(result.stdout).toContain('transition pending')
      expect(JSON.parse(readFileSync(f.configFile, 'utf8')).version).toBe('broken')
      expect(statSync(pending).isDirectory()).toBe(true)
    } else expect(JSON.parse(readFileSync(f.configFile, 'utf8')).version).toBe(f.config.version)
  }
)

it('legacy install announces its alias for installer deployments', () => {
  const f = fixture(),
    result = run(f.entry, f.state, 'install')
  expect(result.status, result.stderr).toBe(0)
  expect(result.stderr).toContain('deprecated')
  expect(result.stderr).toContain('service enable')
  expect(readFileSync(join(f.home, 'actions'), 'utf8')).toBe('enable\n')
})
it('service status detects modified ownership and transitions refuse a replaced state', () => {
  const f = fixture(),
    file = join(f.home, 'service-file')
  writeFileSync(file, 'owned')
  writeFileSync(
    f.configFile,
    JSON.stringify({
      ...f.config,
      service: 1,
      service_file: file,
      service_sha256: createHash('sha256').update('owned').digest('hex'),
    })
  )
  expect(JSON.parse(run(f.entry, f.state, 'service', 'status', '--json').stdout).ownership).toBe(
    'recorded'
  )
  writeFileSync(file, 'modified')
  expect(JSON.parse(run(f.entry, f.state, 'service', 'status', '--json').stdout).ownership).toBe(
    'modified'
  )
  // A forged identity must not authorize the installer boundary.
  const changed = { ...f.config, state_identity: '0:0' }
  writeFileSync(f.configFile, JSON.stringify(changed))
  const result = run(f.entry, f.state, 'service', 'enable')
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('identity changed')
})
it('a forged prefix cannot redirect a service change to another installation', () => {
  const f = fixture()
  writeFileSync(f.configFile, JSON.stringify({ ...f.config, prefix: join(f.home, 'foreign') }))
  const result = run(f.entry, f.state, 'service', 'enable')
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('prefix')
})
it('service admission accepts migrated marker and legacy boot-local device identities', () => {
  const f = fixture(),
    s = statSync(f.state, { bigint: true })
  writeFileSync(
    f.configFile,
    JSON.stringify({ ...f.config, state_identity: `${s.dev + 1n}:${s.ino}` })
  )
  expect(run(f.entry, f.state, 'service', 'enable').status).toBe(0)
  const token = 'a'.repeat(64),
    marker = join(f.state, '.abele-state-identity')
  writeFileSync(marker, token)
  writeFileSync(
    f.configFile,
    JSON.stringify({ ...f.config, state_identity: `marker:${s.ino}:${token}` })
  )
  expect(run(f.entry, f.state, 'service', 'enable').status).toBe(0)
  writeFileSync(marker, 'b'.repeat(64))
  expect(run(f.entry, f.state, 'service', 'disable').stderr).toContain('identity changed')
})

it('source deployments have an explicit foreground status and safe enable refusal', () => {
  const f = fixture()
  expect(JSON.parse(run(cli, f.state, 'service', 'status', '--json').stdout)).toMatchObject({
    mode: 'foreground',
    managed: false,
    enabled: false,
  })
  const result = run(cli, f.state, 'service', 'enable')
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('one-command installer')
})

const pairedEndpoint = 'wss://node.example.ts.net:8444/channel'
function pairedFile(
  home: string,
  body: unknown = { endpoint: pairedEndpoint, origins: ['app://obsidian.md'] }
) {
  const directory = join(home, 'remote')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  chmodSync(directory, 0o700)
  const file = join(directory, 'paired.json')
  writeFileSync(file, JSON.stringify(body), { mode: 0o600 })
  chmodSync(file, 0o600)
  return file
}
function installerArgs(home: string): string[][] {
  try {
    return readFileSync(join(home, 'installer-args'), 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
  } catch {
    return []
  }
}
it('service enable records a validated, protected paired configuration and status shows only its endpoint', () => {
  const f = fixture(),
    file = pairedFile(f.home)
  const enable = run(f.entry, f.state, 'service', 'enable', '--paired-config', file)
  expect(enable.status, enable.stderr).toBe(0)
  const passed = installerArgs(f.home)[0]!
  expect(passed.slice(passed.indexOf('--service-action'))).toEqual([
    '--service-action',
    'enable',
    '--paired-config',
    file,
  ])
  expect(JSON.parse(readFileSync(f.configFile, 'utf8')).paired_config).toBe(file)
  const json = JSON.parse(run(f.entry, f.state, 'service', 'status', '--json').stdout)
  expect(json.paired_listener).toEqual({
    config: file,
    endpoint: 'node.example.ts.net:8444',
    problem: null,
  })
  const human = run(f.entry, f.state, 'service', 'status').stdout
  expect(human).toContain('Remote access: paired listener at node.example.ts.net:8444')
  expect(human).not.toContain('app://obsidian.md')
  // Operator commands read the recorded file without repeating the flag.
  expect(run(f.entry, f.state, 'status').stdout).toContain(`Paired/remote: ${pairedEndpoint}`)
  const routes = run(f.entry, f.state, 'pair', 'routes', '--json')
  expect(routes.status, routes.stderr).toBe(0)
  expect(JSON.parse(routes.stdout).endpoint).toBe(pairedEndpoint)
  // A plain enable keeps it; --no-paired-config removes it.
  expect(run(f.entry, f.state, 'service', 'enable').status).toBe(0)
  expect(installerArgs(f.home)[1]).not.toContain('--paired-config')
  expect(JSON.parse(readFileSync(f.configFile, 'utf8')).paired_config).toBe(file)
  expect(run(f.entry, f.state, 'service', 'enable', '--no-paired-config').status).toBe(0)
  expect(installerArgs(f.home)[2]).toContain('--no-paired-config')
  expect(
    JSON.parse(run(f.entry, f.state, 'service', 'status', '--json').stdout).paired_listener
  ).toBe(null)
  expect(run(f.entry, f.state, 'service', 'status').stdout).toContain(
    'Remote access: no paired listener configured'
  )
})
it('service enable records the physical path of a configuration reached through a symlinked directory', () => {
  const f = fixture(),
    file = pairedFile(f.home),
    alias = join(f.home, 'alias')
  symlinkSync(join(f.home, 'remote'), alias)
  const result = run(
    f.entry,
    f.state,
    'service',
    'enable',
    '--paired-config',
    join(alias, 'paired.json')
  )
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(readFileSync(f.configFile, 'utf8')).paired_config).toBe(file)
})
it.each([
  ['missing', (file: string) => rmSync(file), 'not found'],
  ['group-readable', (file: string) => chmodSync(file, 0o640), 'chmod 600'],
  ['world-writable', (file: string) => chmodSync(file, 0o602), 'chmod 600'],
  [
    'in a group-writable directory',
    (file: string) => chmodSync(resolve(file, '..'), 0o770),
    'chmod go-w',
  ],
  [
    'a symlink',
    (file: string) => {
      const target = file + '.real'
      writeFileSync(target, readFileSync(file), { mode: 0o600 })
      rmSync(file)
      symlinkSync(target, file)
    },
    'symlink',
  ],
  ['not JSON', (file: string) => writeFileSync(file, '{'), 'not valid JSON'],
  [
    'invalid for the paired listener',
    (file: string) =>
      writeFileSync(file, JSON.stringify({ endpoint: 'wss://example.com/channel' })),
    'invalid (endpoint)',
  ],
  [
    'carrying unknown fields',
    (file: string) => writeFileSync(file, JSON.stringify({ endpoint: pairedEndpoint, token: 'x' })),
    'invalid',
  ],
])(
  'service enable refuses a paired configuration that is %s and changes nothing',
  (_, spoil, message) => {
    const f = fixture(),
      file = pairedFile(f.home)
    spoil(file)
    const before = readFileSync(f.configFile, 'utf8')
    const result = run(f.entry, f.state, 'service', 'enable', '--paired-config', file)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(message)
    expect(result.stderr).toContain('othing changed')
    expect(installerArgs(f.home)).toEqual([])
    expect(readFileSync(f.configFile, 'utf8')).toBe(before)
    chmodSync(join(f.home, 'remote'), 0o700)
  }
)
it('paired configuration flags are refused outside service enable and together', () => {
  const f = fixture(),
    file = pairedFile(f.home)
  for (const args of [
    ['service', 'disable', '--paired-config', file],
    ['service', 'disable', '--no-paired-config'],
    ['service', 'status', '--paired-config', file],
    ['service', 'enable', '--paired-config', file, '--no-paired-config'],
  ]) {
    const result = run(f.entry, f.state, ...args)
    expect(result.status, args.join(' ')).toBe(1)
  }
  expect(installerArgs(f.home)).toEqual([])
})
it('a recorded paired configuration that became unusable is reported, never blocks its removal', () => {
  const f = fixture(),
    file = pairedFile(f.home)
  writeFileSync(f.configFile, JSON.stringify({ ...f.config, paired_config: file }))
  chmodSync(file, 0o644)
  const status = JSON.parse(run(f.entry, f.state, 'service', 'status', '--json').stdout)
  expect(status.paired_listener.endpoint).toBe(null)
  expect(status.paired_listener.problem).toContain('chmod 600')
  expect(run(f.entry, f.state, 'service', 'status').stdout).toContain('is unusable')
  expect(run(f.entry, f.state, 'status', '--json').status).toBe(0)
  // Pairing must not run on a configuration that is no longer protected.
  const pair = run(f.entry, f.state, 'pair', 'routes', '--json')
  expect(pair.status).toBe(1)
  expect(pair.stderr).toContain('chmod 600')
  const removal = run(f.entry, f.state, 'service', 'enable', '--no-paired-config')
  expect(removal.status, removal.stderr).toBe(0)
  expect(JSON.parse(readFileSync(f.configFile, 'utf8')).paired_config).toBe('')
})
