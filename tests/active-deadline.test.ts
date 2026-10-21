import { expect, it, vi } from 'vitest'
import { ActiveDeadline } from '../packages/provider-contract/src/deadline.js'
import { VirtualDeadlineTimers } from './deadline-timers.js'

it('uses the injected Codex clock when resuming its remaining budget', () => {
  const timers = new VirtualDeadlineTimers()
  const expired = vi.fn()
  const deadline = new ActiveDeadline(1000, expired, timers)
  timers.advance(400)
  const resume = deadline.pause()
  timers.advance(10000)
  resume()
  timers.advance(599)
  expect(expired).not.toHaveBeenCalled()
  timers.advance(1)
  expect(expired).toHaveBeenCalledOnce()
  deadline.close()
  expect(timers.pending).toBe(0)
})

it('charges only active time, including overlapping approval waits', () => {
  vi.useFakeTimers()
  try {
    const expired = vi.fn()
    const deadline = new ActiveDeadline(1000, expired)
    vi.advanceTimersByTime(400)
    const first = deadline.pause()
    vi.advanceTimersByTime(10000)
    const second = deadline.pause()
    first()
    vi.advanceTimersByTime(10000)
    expect(expired).not.toHaveBeenCalled()
    second()
    second()
    vi.advanceTimersByTime(599)
    expect(expired).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(expired).toHaveBeenCalledTimes(1)
    deadline.close()
  } finally {
    vi.useRealTimers()
  }
})
