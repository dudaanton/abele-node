import { it, expect, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { piAcceptanceDeadlineMs, processStepDeadlineMs } from '../scripts/process-test-budget.mjs'
import { waitForPiPrompt } from '../scripts/pi-prompt-wait.mjs'
it(
  'runs the reproducible CLI status/doctor/restart acceptance with the fake SDK host by default',
  { timeout: piAcceptanceDeadlineMs + processStepDeadlineMs },
  () => {
    const result = spawnSync(process.execPath, ['scripts/acceptance-pi.mjs'], {
      encoding: 'utf8',
      timeout: piAcceptanceDeadlineMs,
      killSignal: 'SIGKILL',
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
    expect(summary).toMatchObject({
      outcome: 'passed',
      live_pi_user_turns: 0,
      claude_live_turns: 0,
    })
    const report = JSON.parse(readFileSync(summary.report, 'utf8'))
    expect(report.checks).toHaveLength(5)
    expect(report.interrupted_child_reaped).toBe(true)
    expect(report.doctor.pi.configuration.sdk_version).toBe('0.87.0')
  }
)
it(
  'retains status/doctor/restart guarantees across slow cold CLI starts',
  { timeout: piAcceptanceDeadlineMs + processStepDeadlineMs },
  () => {
    const result = spawnSync(process.execPath, ['scripts/acceptance-pi.mjs'], {
      encoding: 'utf8',
      timeout: piAcceptanceDeadlineMs,
      killSignal: 'SIGKILL',
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${resolve('tests/fixtures/slow-cli-start.mjs')}`,
      },
    })
    expect(result.status, result.stderr + '\n' + result.stdout).toBe(0)
    const summary = JSON.parse(result.stdout.trim().split('\n').at(-1)!)
    const report = JSON.parse(readFileSync(summary.report, 'utf8'))
    expect(report.checks).toHaveLength(5)
    expect(report.doctor.pi.configuration.sdk_version).toBe('0.87.0')
    expect(summary.outcome).toBe('passed')
  }
)
it(
  'fits allow/deny, expiry, interrupt and resume with two 5xx retries within six attempts',
  { timeout: piAcceptanceDeadlineMs + processStepDeadlineMs },
  () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/acceptance-pi.mjs', '--fixture-5xx-retries'],
      { encoding: 'utf8', timeout: piAcceptanceDeadlineMs, killSignal: 'SIGKILL', maxBuffer: 65536 }
    )
    expect(result.status, result.stderr + '\n' + result.stdout).toBe(0)
    const summary = JSON.parse(result.stdout.trim().split('\n').at(-1)!)
    const report = JSON.parse(readFileSync(summary.report, 'utf8'))
    expect(report.inference_retries).toBe(2)
    expect(report.user_prompt_attempts).toBe(6)
    expect(report.live_pi_user_turns).toBe(0)
    expect(report.checks).toHaveLength(5)
  }
)
it(
  'reports provider failure before a prompt immediately rather than consuming the approval-wait deadline',
  { timeout: piAcceptanceDeadlineMs + processStepDeadlineMs },
  () => {
    const result = spawnSync(
      process.execPath,
      ['scripts/acceptance-pi.mjs', '--fixture-provider-error'],
      { encoding: 'utf8', timeout: piAcceptanceDeadlineMs, killSignal: 'SIGKILL', maxBuffer: 65536 }
    )
    expect(result.status, result.stderr + '\n' + result.stdout).toBe(1)
    const summary = JSON.parse(result.stdout.trim().split('\n').at(-1)!)
    const report = JSON.parse(readFileSync(summary.report, 'utf8'))
    expect(report.error).toBe('provider_failed_before_prompt')
    expect(report.live_pi_user_turns).toBe(0)
    // The companion virtual-clock check below retains the <15 s guarantee for
    // this same approval-wait path, without charging it for cold CLI startup.
    expect(report.last_failure).toMatchObject({
      state: 'failed',
      granted: false,
      tool_succeeded: false,
    })
  }
)

it('surfaces terminal provider failure within 15 s of virtual approval waiting', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
  try {
    const start = Date.now()
    let providerFailed = false
    let observed: { message: string; elapsed: number } | undefined
    // Model-free SDK terminal evidence arrives while no approval exists. The
    // acceptance's real wait implementation must observe it before its deadline.
    setTimeout(() => {
      providerFailed = true
    }, 100)
    const waiting = waitForPiPrompt({
      prompt: async () => undefined,
      failIfTerminal: async () => {
        if (providerFailed) throw Error('provider_failed_before_prompt')
      },
      completed: async () => false,
    }).catch((error: Error) => {
      observed = { message: error.message, elapsed: Date.now() - start }
    })
    await vi.advanceTimersByTimeAsync(14_999)
    expect(
      observed,
      'terminal failure must surface before the approval-wait deadline'
    ).toMatchObject({
      message: 'provider_failed_before_prompt',
    })
    expect(observed!.elapsed).toBeLessThan(15_000)
    await waiting
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    // A deliberately delayed/broken wait must also be settled before teardown.
    await vi.runAllTimersAsync()
    vi.useRealTimers()
  }
})
