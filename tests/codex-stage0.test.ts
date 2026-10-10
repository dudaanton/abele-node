import { spawnSync } from 'node:child_process'
import { expect, test } from 'vitest'

test('Codex no-inference probe policy regressions (no executable discovery)', () => {
  const result = spawnSync(process.execPath, ['--test', 'probes/codex-stage0.test.mjs'], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 65536,
    env: { PATH: process.env.PATH, HOME: '', CODEX_HOME: '', ABELE_CODEX_PATH: '' },
  })
  expect(result.error).toBeUndefined()
  expect(result.status, result.stdout + result.stderr).toBe(0)
})
