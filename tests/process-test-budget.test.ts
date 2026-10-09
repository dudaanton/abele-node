import { expect, it, vi } from 'vitest'
import {
  processScenarioDeadline,
  processStepDeadlineMs,
  waitForProcessCondition,
  withProcessDeadline,
} from '../scripts/process-test-budget.mjs'

it('derives the scenario watchdog from its phases plus cleanup', () => {
  expect(processScenarioDeadline(3)).toBe(4 * processStepDeadlineMs)
})

it('waits for evidence beyond the old 20 s watchdog without a settling sleep', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  try {
    const start = performance.now()
    const completed = waitForProcessCondition(
      () => (performance.now() - start >= 21_000 ? 'ready' : undefined),
      'restart'
    )
    await vi.advanceTimersByTimeAsync(21_000)
    expect(await completed).toBe('ready')
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it.each(['missing evidence', 'stalled probe'])('still fails on %s', async (mode) => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  try {
    const pending = waitForProcessCondition(
      () => (mode === 'stalled probe' ? new Promise(() => {}) : false),
      'doctor',
      100
    )
    const assertion = expect(pending).rejects.toThrow('doctor deadline (100ms)')
    await vi.advanceTimersByTimeAsync(120)
    await assertion
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('bounds an exit that never arrives, but does not hide a process failure', async () => {
  vi.useFakeTimers()
  try {
    const pending = withProcessDeadline(() => new Promise(() => {}), 'daemon cleanup', 100)
    const assertion = expect(pending).rejects.toThrow('daemon cleanup deadline')
    await vi.advanceTimersByTimeAsync(100)
    await assertion
    await expect(
      withProcessDeadline(() => {
        throw Error('daemon failed before ready')
      }, 'restart')
    ).rejects.toThrow('daemon failed before ready')
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
