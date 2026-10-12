import { afterEach, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

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
    `const fs=require('node:fs');const file=${JSON.stringify(configFile)};const args=process.argv.slice(2);const action=args[args.indexOf('--service-action')+1];const c=JSON.parse(fs.readFileSync(file));fs.appendFileSync(${JSON.stringify(join(home, 'actions'))},action+'\\n');c.service=action==='enable'?1:0;fs.writeFileSync(file,JSON.stringify(c));`
  )
  return {
    entry: join(runtime, 'packages/node-daemon/dist/cli.js'),
    home,
    state,
    config,
    configFile,
  }
}

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
it('start in a service installation invokes enable and never creates a foreground daemon', () => {
  const f = fixture()
  writeFileSync(f.configFile, JSON.stringify({ ...f.config, service: 1 }))
  const result = run(f.entry, f.state, 'start')
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('background service')
  expect(result.stdout).not.toContain('listening')
  expect(readFileSync(join(f.home, 'actions'), 'utf8')).toBe('enable\n')
})
it.each([['start'], ['service', 'enable'], ['service', 'status'], ['install']])(
  'recovers a pending transition before CLI ownership checks: %j',
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
    expect(JSON.parse(readFileSync(f.configFile, 'utf8')).version).toBe(f.config.version)
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
