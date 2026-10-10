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
      // Login/home behaviour is independent of the host's confinement certification.
      const report = await doctorCodex(
        {
          executable: fixture,
          fixture: true,
          stateDir: dir,
          model: 'fixture-small',
        },
        undefined,
        'darwin'
      )
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

it.each(['chatgpt', 'logged-out'])(
  'keeps Linux confinement uncertified ahead of %s authentication',
  async (auth) => {
    const dir = mkdtempSync(resolve('.scratch/codex-login-linux-'))
    const home = join(dir, 'home')
    mkdirSync(home, { mode: 0o700 })
    writeFileSync(join(home, 'fixture.json'), JSON.stringify({ mode: auth }), { mode: 0o600 })
    try {
      const report = await doctorCodex(
        {
          executable: fixture,
          fixture: true,
          stateDir: dir,
          home,
          model: 'fixture-small',
        },
        undefined,
        'linux'
      )
      expect(report.available).toBe(false)
      expect(report.diagnostic).toBe('codex_platform_confinement_uncertified')
      expect(report.checks).toEqual({
        handshake: true,
        effective_policy: true,
        managed_remote_control: true,
        authenticated: auth !== 'logged-out',
        model_available: auth !== 'logged-out',
      })
      expect(report.gates).toEqual([
        {
          name: 'platform_confinement',
          status: 'unverified',
          error: 'codex_platform_confinement_uncertified',
        },
      ])
      expect(report.home).toBe(home)
      expect(report.home_mode).toBe('isolated')
      expect(existsSync(join(home, 'threads.json'))).toBe(false)
      expect(existsSync(join(home, 'turn-log.jsonl'))).toBe(false)
      if (auth === 'logged-out') {
        expect(report.login_command).toContain('login --device-auth')
        expect(report.api_key_login_command).toContain('login --with-api-key')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

it.each(['chatgpt', 'user-model', 'no-model-metadata', 'logged-out', 'model-missing'])(
  'reports Codex own default without inference or a node model override: %s',
  async (mode) => {
    const dir = mkdtempSync(resolve('.scratch/codex-default-model-'))
    const home = join(dir, 'home')
    mkdirSync(home, { mode: 0o700 })
    writeFileSync(join(home, 'fixture.json'), JSON.stringify({ mode, track_requests: true }))
    try {
      const report = await doctorCodex(
        { executable: fixture, fixture: true, stateDir: dir, home },
        undefined,
        'darwin'
      )
      expect(report.available).toBe(!['logged-out', 'model-missing'].includes(mode))
      expect(report.model).toBe(
        mode === 'user-model'
          ? 'fixture-user-default'
          : ['no-model-metadata', 'logged-out'].includes(mode)
            ? 'Codex default'
            : mode === 'model-missing'
              ? 'fixture-missing'
              : 'fixture-small'
      )
      if (['no-model-metadata', 'logged-out'].includes(mode))
        expect(report.checks?.model_available).toBeUndefined()
      else
        expect(report.checks?.model_available).toBe(!['logged-out', 'model-missing'].includes(mode))
      expect(humanOutput(['doctor'], { codex: report })).toContain(`model: ${report.model}`)
      const requests = readFileSync(join(home, 'request-log.jsonl'), 'utf8')
      expect(requests).not.toContain('thread/start')
      expect(JSON.parse(readFileSync(join(home, 'launch.json'), 'utf8')).config.model).toBe(
        mode === 'user-model'
          ? 'fixture-user-default'
          : mode === 'model-missing'
            ? 'fixture-missing'
            : undefined
      )
      if (mode === 'model-missing')
        expect(report.diagnostic).toBe('codex_selected_model_unavailable')
      expect(existsSync(join(home, 'threads.json'))).toBe(false)
      expect(existsSync(join(home, 'turn-log.jsonl'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
it.each(['default-hidden', 'default-no-low', 'oversized-catalog'])(
  'retains the catalog/low-effort gates for Codex own default: %s',
  async (mode) => {
    const dir = mkdtempSync(resolve('.scratch/codex-default-gates-')),
      home = join(dir, 'home')
    mkdirSync(home, { mode: 0o700 })
    writeFileSync(join(home, 'fixture.json'), JSON.stringify({ mode }))
    try {
      const report = await doctorCodex(
        { executable: fixture, fixture: true, stateDir: dir, home },
        undefined,
        'darwin'
      )
      expect(report).toMatchObject({
        available: false,
        diagnostic: 'codex_selected_model_unavailable',
        model: mode === 'oversized-catalog' ? 'Codex default' : 'fixture-small',
        checks: { model_available: false },
      })
      mkdirSync(join(dir, 'workspace'))
      const events: any[] = []
      const run = await startCodexTurn(
        {
          executable: discoverCodex({ executable: fixture, fixture: true }),
          paths: { home, workspace: join(dir, 'workspace'), state: dir, sibling: dir },
          deadlineMs: 3000,
          turn: {
            session_id: randomUUID(),
            run_id: randomUUID(),
            cwd: join(dir, 'workspace'),
            text: 'must not dispatch',
          },
        },
        {
          event: (e) => events.push(e),
          processes: () => {},
          permission: async () => ({ choice: 'deny', delivered: () => true }),
        }
      )
      expect((await run.done).reason).toBe('codex_selected_model_unavailable')
      expect(events.some((e) => e.type === 'codex.session.bound')).toBe(false)
      expect(existsSync(join(home, 'turn-log.jsonl'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
it('shows one actionable Codex status line instead of a generic restart suggestion', () => {
  const output = humanOutput(['status'], {
    codex: {
      available: false,
      diagnostic: 'codex_authentication_required',
      login_command: 'codex login',
    },
  })
  expect(output.split('\n').filter((line) => line.startsWith('Codex:'))).toEqual([
    'Codex: not logged in (model: Codex default) — run: codex login',
  ])
  expect(
    humanOutput(['status'], { codex: { available: false, diagnostic: 'codex_disabled' } })
  ).toContain('Codex: disabled (model: Codex default) — run: abele-node install --codex')
})
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
