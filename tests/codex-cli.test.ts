import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

it.each(['default', 'environment', 'flag'])(
  'reports the selected Codex home through the CLI: %s',
  (mode) => {
    const dir = mkdtempSync(resolve('.scratch/codex-cli-'))
    try {
      const selected = join(dir, mode === 'default' ? 'user-login' : mode)
      const result = spawnSync(
        process.execPath,
        [
          'packages/node-daemon/dist/cli.js',
          'doctor',
          '--json',
          '--state-dir',
          join(dir, 'state'),
          '--codex-path',
          resolve('tests/fixtures/codex.mjs'),
          ...(mode === 'flag' ? ['--codex-home', selected] : []),
        ],
        {
          encoding: 'utf8',
          timeout: 10000,
          env: {
            ...process.env,
            HOME: dir,
            CODEX_HOME: join(dir, 'user-login'),
            ABELE_CODEX_HOME: mode === 'default' ? '' : join(dir, 'environment'),
            ABELE_CLAUDE_PATH: resolve('tests/fixtures/claude.mjs'),
            ABELE_TAILSCALE_PATH: resolve('tests/fixtures/tailscale.mjs'),
            ABELE_PI_HOST: resolve('tests/fixtures/pi-host.mjs'),
            OPENAI_API_KEY: '',
          },
        }
      )
      expect(result.status, result.stderr).toBe(0)
      const report = JSON.parse(result.stdout).codex
      expect(report.home).toBe(selected)
      expect(report.home_mode).toBe(mode === 'default' ? 'inherited' : 'isolated')
      // Production never accepts this fixture launcher, so this test cannot infer.
      expect(report.diagnostic).toBe('codex_opaque_wrapper_unsupported')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
