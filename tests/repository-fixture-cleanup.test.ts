import { expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
import { closeRepositoryFixtures } from './helpers/close-repository-fixtures.js'

it('does not delete the next test state when an earlier cleanup resumes after a hook timeout', async () => {
  const firstDir = mkdtempSync(resolve('.scratch/cleanup-first-'))
  const secondDir = mkdtempSync(resolve('.scratch/cleanup-second-'))
  const first = new NodeCore(join(firstDir, 'state'))
  const second = new NodeCore(join(secondDir, 'state'))
  const cores = [first],
    dirs = [firstDir]
  let release!: () => void
  const held = new Promise<void>((r) => {
    release = r
  })
  const stop = first.resources.stop.bind(first.resources)
  vi.spyOn(first.resources, 'stop').mockImplementation(async () => {
    await held
    await stop()
  })
  const cleanup = closeRepositoryFixtures(cores, dirs)
  // Vitest may start the next test while a timed-out hook is still awaiting stop.
  cores.push(second)
  dirs.push(secondDir)
  release()
  let secondClosed = false
  try {
    await cleanup
    expect(existsSync(join(secondDir, 'state'))).toBe(true)
    await closeRepositoryFixtures(cores, dirs)
    secondClosed = true
    expect(existsSync(firstDir)).toBe(false)
    expect(existsSync(secondDir)).toBe(false)
  } finally {
    if (!secondClosed) {
      await second.resources.stop()
      if (existsSync(join(secondDir, 'state'))) second.close()
      else second.db.close()
    }
    rmSync(firstDir, { recursive: true, force: true })
    rmSync(secondDir, { recursive: true, force: true })
  }
})
