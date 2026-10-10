// Test-only daemon preload: freeze Date.now budget time, not process I/O timers.
// Each test owns its file and advances it atomically at an observed expiry boundary.
import { readFileSync } from 'node:fs'
const path = new URL(import.meta.url).searchParams.get('path')
if (!path) throw new Error('test clock path required')
Date.now = () => {
  const now = Number(readFileSync(path, 'utf8'))
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error('invalid test clock')
  return now
}
