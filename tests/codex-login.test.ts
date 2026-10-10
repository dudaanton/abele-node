import { afterEach, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { resolveCodexHome, prepareCodexHome } from '../packages/provider-codex/src/home.js'
import { doctorCodex } from '../packages/provider-codex/src/doctor.js'
import { discoverCodex } from '../packages/provider-codex/src/discovery.js'
import { startCodexTurn } from '../packages/provider-codex/src/worker.js'
import { humanOutput } from '../packages/node-daemon/src/output.js'

// Never inspect administrator files or use a real executable/account.
vi.mock('../packages/provider-codex/src/discovery.js', async (original) => ({
  ...(await original<any>()),
  requireManagedFile: vi.fn(),
}))
afterEach(() => vi.unstubAllEnvs())
const fixture = resolve('tests/fixtures/codex.mjs')

it('selects the daemon user home by default, CODEX_HOME next, and explicit isolated home first', () => {
  expect(resolveCodexHome(undefined, {}, '/fake/user')).toEqual({
    home: '/fake/user/.codex',
    mode: 'inherited',
  })
  expect(resolveCodexHome(undefined, { CODEX_HOME: '/fake/login' }, '/fake/user')).toEqual({
    home: '/fake/login',
    mode: 'inherited',
  })
  expect(
    resolveCodexHome(undefined, { CODEX_HOME: '/fake/login', ABELE_CODEX_HOME: '/fake/node' })
  ).toEqual({
    home: '/fake/node',
    mode: 'isolated',
  })
  expect(resolveCodexHome('/fake/flag', { ABELE_CODEX_HOME: '/fake/env' })).toEqual({
    home: '/fake/flag',
    mode: 'isolated',
  })
})

it('leaves an existing user config and its permissions unchanged', () => {
  const home = mkdtempSync(resolve('.scratch/codex-user-home-'))
  const config = join(home, 'config.toml')
  const content = '# fake user config\n[analytics]\nenabled = true\n'
  writeFileSync(config, content, { mode: 0o644 })
  try {
    expect(prepareCodexHome({ home, mode: 'inherited' })).toBe(home)
    expect(readFileSync(config, 'utf8')).toBe(content)
    expect(statSync(config).mode & 0o777).toBe(0o644)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

it('preserves the canonical state-directory prerequisite with an inherited home', async () => {
  const dir = mkdtempSync(resolve('.scratch/codex-state-alias-'))
  const state = join(dir, 'state'),
    alias = join(dir, 'alias'),
    home = join(dir, 'home')
  mkdirSync(state)
  mkdirSync(home)
  symlinkSync(state, alias)
  vi.stubEnv('CODEX_HOME', home)
  try {
    const report = await doctorCodex({
      executable: fixture,
      fixture: true,
      stateDir: alias,
      model: 'fixture-small',
    })
    expect(report.available).toBe(false)
    expect(report.diagnostic).toBe('codex_unsafe_home')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each(['chatgpt', 'apiKey', 'environment-key', 'logged-out'])(
  'inspects %s with launch-only policy and actionable home/login output',
  async (auth) => {
    const dir = mkdtempSync(resolve('.scratch/codex-login-'))
    const home = join(dir, 'login')
    mkdirSync(home, { mode: 0o700 })
    const isolated = auth !== 'chatgpt'
    writeFileSync(join(home, 'fixture.json'), JSON.stringify({ mode: auth }), { mode: 0o600 })
    const config = '# fake existing login configuration\n[analytics]\nenabled = true\n'
    writeFileSync(join(home, 'config.toml'), config, { mode: isolated ? 0o600 : 0o644 })
    vi.stubEnv('CODEX_HOME', home)
    vi.stubEnv('ABELE_CODEX_HOME', isolated ? home : '')
    vi.stubEnv('OPENAI_API_KEY', 'fake-test-key-not-a-credential')
    try {
      const report = await doctorCodex({
        executable: fixture,
        fixture: true,
        stateDir: dir,
        model: 'fixture-small',
      })
      expect(report.home).toBe(home)
      expect(report.home_mode).toBe(isolated ? 'isolated' : 'inherited')
      expect(existsSync(join(home, 'threads.json'))).toBe(false)
      expect(existsSync(join(home, 'turn-log.jsonl'))).toBe(false)
      expect(report.checks?.authenticated).toBe(auth !== 'logged-out')
      expect(report.available).toBe(auth !== 'logged-out')
      const launch = JSON.parse(readFileSync(join(home, 'launch.json'), 'utf8'))
      expect(launch.home).toBe(isolated ? home : homedir())
      expect(launch.hasApiKey).toBe(isolated)
      expect(launch.config.forced_login_method).toBeUndefined()
      expect(launch.config.cli_auth_credentials_store).toBe(isolated ? 'file' : undefined)
      expect(launch.config.analytics.enabled).toBe(false)
      expect(launch.config.history.persistence).toBe('none')
      expect(launch.config.features.plugins).toBe(false)
      expect(launch.config.otel.exporter).toBe('none')
      expect(launch.config.shell_environment_policy.inherit).toBe('none')
      expect(launch.config.shell_environment_policy.set.OPENAI_API_KEY).toBeUndefined()
      expect(JSON.stringify(report)).not.toContain('fake-test-key-not-a-credential')
      expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(config)
      const human = humanOutput(['doctor'], { codex: report })
      expect(human).toContain(home)
      expect(human).toContain(auth === 'logged-out' ? 'not logged in' : 'logged in')
      if (auth === 'logged-out') {
        expect(report.diagnostic).toBe('codex_authentication_required')
        expect(human).toContain('CODEX_HOME=')
        expect(human).toContain('login --device-auth')
        expect(human).toContain('login --with-api-key')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

it.each(['apiKey', 'environment-key', 'logged-out', 'amazonBedrock'])(
  'accepts only supported first-party authentication on each fake worker launch: %s',
  async (auth) => {
    const dir = mkdtempSync(resolve('.scratch/codex-login-worker-'))
    const home = join(dir, 'home'),
      workspace = join(dir, 'workspace')
    mkdirSync(home)
    mkdirSync(workspace)
    writeFileSync(join(home, 'fixture.json'), JSON.stringify({ mode: auth }))
    vi.stubEnv('OPENAI_API_KEY', 'fake-test-key-not-a-credential')
    try {
      const run = await startCodexTurn(
        {
          executable: discoverCodex({ executable: fixture, fixture: true }),
          paths: { home, workspace, state: dir, sibling: dir, isolated: true },
          model: 'fixture-small',
          deadlineMs: 3000,
          turn: {
            session_id: randomUUID(),
            run_id: randomUUID(),
            cwd: workspace,
            text: 'fake only',
          },
        },
        {
          event: () => {},
          processes: () => {},
          permission: async () => ({ choice: 'deny', delivered: () => true }),
        }
      )
      const result = await run.done
      if (auth === 'apiKey' || auth === 'environment-key')
        expect(result.result?.subtype).toBe('success')
      else expect(result.reason).toBe('codex_authentication_required')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
