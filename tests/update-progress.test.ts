import { expect, it } from 'vitest'
import { formatProgress, progressDue } from '../packages/node-daemon/src/update-progress.js'
it('formats totals, rate and remaining time', () => {
  expect(formatProgress({ stage: 'download', bytes: 50, total: 100, elapsed: 2 })).toBe(
    'download: 50 B / 100 B (50%), 25 B/s, 2 s left'
  )
  expect(formatProgress({ stage: 'download', bytes: 50, total: null, elapsed: 2 })).toBe(
    'download: 50 B, 25 B/s'
  )
})
it('throttles pipes at ten percent or five seconds', () => {
  expect(progressDue(9, 100, 1000, 0, 0)).toBe(false)
  expect(progressDue(10, 100, 1000, 0, 0)).toBe(true)
  expect(progressDue(0, null, 5000, 0, 0)).toBe(true)
  expect(progressDue(100, 100, 1, 99, 0)).toBe(true)
})
