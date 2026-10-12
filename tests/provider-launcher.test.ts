import { afterEach, expect, it, vi } from 'vitest'
import {
  chmodSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ClaudeProviderAdapter } from '@abele/provider-claude'
import { discoverCodex } from '../packages/provider-codex/src/discovery.js'
import * as discovery from '../packages/provider-codex/src/discovery.js'
import * as doctor from '../packages/provider-codex/src/doctor.js'
import { CodexProviderAdapter } from '../packages/provider-codex/src/adapter.js'

const dirs: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function launcher(provider: 'claude' | 'codex') {
  const dir = mkdtempSync(resolve('.scratch/provider-launcher-'))
  dirs.push(dir)
  const bin = join(dir, 'bin'),
    versions = join(dir, 'versions')
  mkdirSync(bin)
  mkdirSync(versions)
  const version = (name: string) => {
    const root = join(versions, name)
    mkdirSync(root)
    const path = join(root, provider)
    writeFileSync(
      path,
      readFileSync(resolve(`tests/fixtures/${provider}.mjs`), 'utf8').replace(
        '#!/usr/bin/env node',
        `#!${process.execPath}`
      )
    )
    chmodSync(path, 0o700)
    return path
  }
  const old = version('old'),
    current = version('new'),
    path = join(bin, provider)
  symlinkSync(old, path)
  vi.stubEnv('HOME', dir)
  vi.stubEnv('PATH', `${bin}:${process.env.PATH}`)
  return {
    dir,
    old,
    current,
    path,
    update() {
      unlinkSync(path)
      symlinkSync(current, path)
      rmSync(join(versions, 'old'), { recursive: true })
    },
  }
}
it('keeps the Claude launcher and launches a checked new version after the old directory is removed', async () => {
  const f = launcher('claude')
  const adapter = new ClaudeProviderAdapter({ executable: f.path })
  expect(adapter.configuration.executable).toBe(f.path)
  expect(adapter.available).toBe(true)
  f.update()
  expect(new ClaudeProviderAdapter({ executable: f.path }).configuration.executable).toBe(f.path)
  const run = await adapter.startTurn(
    { session_id: 's', run_id: 'r', cwd: f.dir, text: 'no-result' },
    { event() {}, processes() {}, permission: async () => ({ choice: 'deny', delivered() {} }) }
  )
  try {
    expect((await run.done).reason).toBe('no_terminal_result')
  } finally {
    await run.interrupt()
    await run.done
  }
})
it.each(['status', 'doctor'])(
  'recovers a stale stored Claude version path in %s through PATH',
  (command) => {
    const f = launcher('claude')
    f.update()
    const result = spawnSync(
      process.execPath,
      [
        'packages/node-daemon/dist/cli.js',
        command,
        '--json',
        '--no-codex',
        '--state-dir',
        join(f.dir, 'state'),
        '--claude-path',
        f.old,
      ],
      { encoding: 'utf8', timeout: 10000 }
    )
    expect(result.status, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout)
    expect(report.claude.available).toBe(true)
    expect(report.claude.configuration.executable).toBe(f.path)
  }
)
it('recovers a stale Codex version path while preserving per-spawn identity checks', () => {
  const f = launcher('codex')
  const old = discoverCodex({ executable: f.path, fixture: true })
  f.update()
  expect(() => old.recheck()).toThrow()
  const current = discoverCodex({ executable: f.old, fixture: true })
  expect(current.executable).toBe(f.current)
  current.recheck()
})
it('refreshes a long-lived Codex adapter pin before each preflight after a launcher update', async () => {
  const f = launcher('codex')
  // Production rejects Node wrappers; opt into only our deterministic fixture discovery.
  const inspect = discovery.discoverCodex
  vi.spyOn(discovery, 'discoverCodex').mockImplementation((options) =>
    inspect({ ...options, fixture: true })
  )
  vi.spyOn(doctor, 'doctorCodex').mockResolvedValue({
    provider: 'codex',
    available: true,
    diagnostic: 'fixture',
  })
  class Adapter extends CodexProviderAdapter {
    get pinnedPath() {
      return this.executable?.executable
    }
  }
  const adapter = new Adapter({ stateDir: join(f.dir, 'state'), executable: f.path })
  expect(await adapter.prepare()).toBe(true)
  expect(adapter.pinnedPath).toBe(f.old)
  f.update()
  expect(await adapter.prepare()).toBe(true)
  expect(adapter.pinnedPath).toBe(f.current)
})
it.each(['claude', 'codex'] as const)(
  'recovers a stale %s version path through the common launcher without PATH',
  (provider) => {
    const f = launcher(provider)
    mkdirSync(join(f.dir, '.local/bin'), { recursive: true })
    const common = join(f.dir, '.local/bin', provider)
    symlinkSync(f.current, common)
    f.update()
    vi.stubEnv('PATH', '')
    if (provider === 'claude') {
      const adapter = new ClaudeProviderAdapter({ executable: f.old })
      expect(adapter.available).toBe(true)
      expect(adapter.configuration.executable).toBe(common)
    } else {
      expect(discoverCodex({ executable: f.old, fixture: true }).executable).toBe(f.current)
    }
  }
)
it('does not redirect a dangling launcher to another PATH binary', () => {
  const f = launcher('claude')
  const dangling = join(f.dir, 'versions', 'dangling')
  symlinkSync(join(f.dir, 'absent'), dangling)
  expect(new ClaudeProviderAdapter({ executable: dangling }).available).toBe(false)
})
it('does not redirect an explicitly missing non-version executable to PATH', () => {
  const f = launcher('claude')
  expect(new ClaudeProviderAdapter({ executable: join(f.dir, 'missing') }).available).toBe(false)
})
