import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { doctorCodex } from '../packages/provider-codex/src/doctor.js'
import { startDaemon, readRuntime, control } from '../packages/node-daemon/src/index.js'

// Exercise startup with the fake app-server, never host admin policy/accounts.
vi.mock('../packages/provider-codex/src/discovery.js', async (original) => ({
  ...(await original<any>()),
  requireManagedFile: vi.fn(),
}))
vi.mock('@abele/node-core', async (original) => {
  const core = await original<typeof import('@abele/node-core')>()
  return {
    ...core,
    CodexProviderAdapter: class extends core.CodexProviderAdapter {
      protected async inspect() {
        return doctorCodex(
          {
            ...this.options,
            executable: resolve('tests/fixtures/codex.mjs'),
            fixture: true,
          },
          undefined,
          'darwin'
        )
      }
    },
  }
})
afterEach(() => vi.unstubAllEnvs())
it.each(['chatgpt', 'logged-out', 'disabled'])(
  'runs automatic daemon preflight and publishes usable status: %s',
  async (mode) => {
    const dir = mkdtempSync(resolve('.scratch/codex-auto-daemon-'))
    const home = join(dir, 'login'),
      state = join(dir, 'state')
    mkdirSync(home, { mode: 0o700 })
    writeFileSync(join(home, 'fixture.json'), JSON.stringify({ mode }))
    vi.stubEnv('CODEX_HOME', home)
    const daemon = await startDaemon(
      state,
      0,
      undefined,
      {},
      undefined,
      undefined,
      {},
      mode === 'disabled' ? { enabled: false } : {}
    )
    try {
      const report = readRuntime(state)?.codex as any
      expect(report.available).toBe(mode === 'chatgpt')
      expect(report.configuration.model).toBeNull()
      expect(report.model).toBe(mode === 'chatgpt' ? 'fixture-small' : 'Codex default')
      if (mode === 'logged-out') {
        expect(report.checks.authenticated).toBe(false)
        expect(report.login_command).toContain('login')
        expect(report.diagnostic).toBe('codex_authentication_required')
      }
      if (mode === 'logged-out') {
        writeFileSync(join(home, 'fixture.json'), JSON.stringify({ mode: 'chatgpt' }))
        const refreshed = (await control(state, { action: 'codex.preflight' })) as any
        expect(refreshed.available).toBe(true)
        expect((readRuntime(state)?.codex as any).available).toBe(true)
      }
      if (mode === 'disabled') {
        expect(existsSync(join(home, 'launch.json'))).toBe(false)
        expect(await control(state, { action: 'codex.preflight' })).toMatchObject({
          diagnostic: 'codex_disabled',
          available: false,
        })
        expect(existsSync(join(home, 'launch.json'))).toBe(false)
      }
      expect(existsSync(join(home, 'threads.json'))).toBe(false)
      expect(existsSync(join(home, 'turn-log.jsonl'))).toBe(false)
    } finally {
      await daemon.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
