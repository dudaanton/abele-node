import { it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
it('runs the reproducible CLI status/doctor/restart acceptance with the fake SDK host by default', () => {
  const result = spawnSync(process.execPath, ['scripts/acceptance-pi.mjs'], {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 65536,
  })
  let diagnostic = result.stderr + '\n' + result.stdout
  if (result.status !== 0 && result.stdout.trim()) {
    try {
      const summary = JSON.parse(result.stdout.trim().split('\n').at(-1)!)
      diagnostic += '\n' + readFileSync(summary.report, 'utf8')
    } catch {
      // Retain raw startup/timeout diagnostics when no report was written.
    }
  }
  expect(result.status, diagnostic).toBe(0)
  const summary = JSON.parse(result.stdout.trim().split('\n').at(-1)!)
  expect(summary).toMatchObject({ outcome: 'passed', live_pi_user_turns: 0, claude_live_turns: 0 })
  const report = JSON.parse(readFileSync(summary.report, 'utf8'))
  expect(report.checks).toHaveLength(5)
  expect(report.doctor.pi.configuration.sdk_version).toBe('0.87.0')
})
it('fits allow/deny, expiry, interrupt and resume with two 5xx retries within six attempts', () => {
  const result = spawnSync(
    process.execPath,
    ['scripts/acceptance-pi.mjs', '--fixture-5xx-retries'],
    { encoding: 'utf8', timeout: 25000, maxBuffer: 65536 }
  )
  expect(result.status, result.stderr + '\n' + result.stdout).toBe(0)
  const summary = JSON.parse(result.stdout.trim().split('\n').at(-1)!)
  const report = JSON.parse(readFileSync(summary.report, 'utf8'))
  expect(report.inference_retries).toBe(2)
  expect(report.user_prompt_attempts).toBe(6)
  expect(report.live_pi_user_turns).toBe(0)
  expect(report.checks).toHaveLength(5)
}, 30000)
it('reports provider failure before a prompt immediately rather than consuming the approval-wait deadline', () => {
  const start = Date.now()
  const result = spawnSync(
    process.execPath,
    ['scripts/acceptance-pi.mjs', '--fixture-provider-error'],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 }
  )
  expect(result.status, result.stderr + '\n' + result.stdout).toBe(1)
  const summary = JSON.parse(result.stdout.trim().split('\n').at(-1)!)
  const report = JSON.parse(readFileSync(summary.report, 'utf8'))
  expect(report.error).toBe('provider_failed_before_prompt')
  expect(report.live_pi_user_turns).toBe(0)
  expect(Date.now() - start).toBeLessThan(15000)
})
