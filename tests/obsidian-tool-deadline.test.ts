import { afterEach, expect, it, vi } from 'vitest'
import { ToolWaitDeadline } from '../packages/provider-contract/src/tool-deadline.js'
afterEach(() => vi.useRealTimers())

it('suspends the bounded worker clock across concurrent Obsidian owner waits and resumes the remaining budget', () => {
  vi.useFakeTimers()
  const expired = vi.fn()
  const clock = new ToolWaitDeadline(1000, expired)
  vi.advanceTimersByTime(200)
  const first = clock.pause(),
    second = clock.pause()
  vi.advanceTimersByTime(3 * 86400000)
  first()
  first()
  expect(expired).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
  second()
  vi.advanceTimersByTime(799)
  expect(expired).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(expired).toHaveBeenCalledOnce()
  clock.clear()
  expect(vi.getTimerCount()).toBe(0)
})

it('does not rearm a settled worker when a pending tool finally resolves', () => {
  vi.useFakeTimers()
  const expired = vi.fn()
  const clock = new ToolWaitDeadline(1000, expired)
  const resume = clock.pause()
  clock.clear()
  resume()
  vi.advanceTimersByTime(2000)
  expect(expired).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
