import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { acquireUpdateLock, updateInProgress } from '../packages/node-core/src/update-lock.js'

let state: string, lock: string
beforeEach(() => {
  mkdirSync('.scratch', { recursive: true })
  state = mkdtempSync(resolve('.scratch/update-lock-test-'))
  lock = join(state, 'update.lock')
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(state, { recursive: true, force: true })
})
function deadOwner() {
  const child = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' })
  expect(child.status, child.stderr).toBe(0)
  writeFileSync(lock, JSON.stringify({ pid: child.pid, id: 'dead-owner' }))
  return child.pid
}
it('unblocks provider dispatch when the updater owner has exited', () => {
  deadOwner()
  expect(updateInProgress(state)).toBe(false)
  expect(existsSync(lock)).toBe(false)
  const release = acquireUpdateLock(state)
  expect(updateInProgress(state)).toBe(true)
  release()
  expect(updateInProgress(state)).toBe(false)
})
it('keeps live and permission-denied owners fenced', () => {
  const record = JSON.stringify({ pid: process.pid, id: 'live-owner' })
  writeFileSync(lock, record)
  expect(updateInProgress(state)).toBe(true)
  vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('unverifiable'), { code: 'EPERM' })
  })
  expect(updateInProgress(state)).toBe(true)
  expect(readFileSync(lock, 'utf8')).toBe(record)
})
it('does not reclaim a stale fence while dispatch admission is owned elsewhere', () => {
  deadOwner()
  mkdirSync(join(state, '.run-admission'))
  expect(updateInProgress(state)).toBe(true)
  expect(existsSync(lock)).toBe(true)
  rmSync(join(state, '.run-admission'), { recursive: true })
  expect(updateInProgress(state)).toBe(false)
})
it('never removes a replacement lock while probing a dead owner', () => {
  const pid = deadOwner()
  const record = JSON.stringify({ pid: process.pid, id: 'replacement-owner' })
  const kill = process.kill.bind(process)
  vi.spyOn(process, 'kill').mockImplementation((owner, signal) => {
    if (owner !== pid) return kill(owner, signal)
    rmSync(lock)
    writeFileSync(lock, record)
    throw Object.assign(new Error('dead owner'), { code: 'ESRCH' })
  })
  expect(updateInProgress(state)).toBe(true)
  expect(readFileSync(lock, 'utf8')).toBe(record)
})
