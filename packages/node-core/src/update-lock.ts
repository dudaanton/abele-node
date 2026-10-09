import { randomUUID } from 'node:crypto'
import { lstatSync, readFileSync, unlinkSync, writeFileSync, mkdirSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'

/** Admission fence, not a second database owner or a daemon-stop mechanism. */
export function updateInProgress(state: string, admissionHeld = false): boolean {
  const file = join(state, 'update.lock')
  try {
    const identity = lstatSync(file)
    if (!identity.isFile()) return true // Never follow a symlink or adopt an unknown fence.
    const record = readFileSync(file, 'utf8')
    let pid: unknown
    try {
      pid = (JSON.parse(record) as { pid?: unknown } | null)?.pid
    } catch {
      return true
    }
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid < 1) return true
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      // EPERM and every other unverifiable result are not proof of a dead owner.
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return true
    }
    if (!admissionHeld) {
      const releaseAdmission = tryRunAdmission(state)
      if (!releaseAdmission) return true
      try {
        // Re-read and re-probe under the same mutex used to publish fences.
        return updateInProgress(state, true)
      } finally {
        releaseAdmission()
      }
    }
    const current = lstatSync(file)
    if (
      current.dev !== identity.dev ||
      current.ino !== identity.ino ||
      readFileSync(file, 'utf8') !== record
    )
      return true // A replacement is not the dead owner's lock.
    unlinkSync(file)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    // An unreadable fence is not permission to launch a provider.
    throw error
  }
}
// Both provider dispatch and fence publication serialize on this short critical
// section. A fence check followed by an INSERT without it has a cross-process race.
export function tryRunAdmission(state: string): (() => void) | undefined {
  const dir = join(state, '.run-admission')
  try {
    mkdirSync(dir, { mode: 0o700 })
    return () => rmdirSync(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return undefined
    throw error
  }
}
export function acquireUpdateLock(state: string): () => void {
  const releaseAdmission = tryRunAdmission(state)
  if (!releaseAdmission)
    throw new Error(
      `Provider dispatch admission is busy: ${join(state, '.run-admission')}. Retry after dispatch completes; inspect an interrupted owner's lock before removing it.`
    )
  const file = join(state, 'update.lock')
  const record = JSON.stringify({ pid: process.pid, id: randomUUID() }) + '\n'
  try {
    if (updateInProgress(state, true))
      throw Object.assign(new Error('update_lock_owned'), { code: 'EEXIST' })
    writeFileSync(file, record, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw new Error(
        `Another update or an unverifiable owner holds ${file}. Inspect it before retrying; do not remove a live updater's lock.`
      )
    throw error
  } finally {
    releaseAdmission()
  }
  return () => {
    // Never unlink a replacement belonging to another invocation.
    if (readFileSync(file, 'utf8') !== record)
      throw new Error(`Update lock identity changed: ${file}`)
    unlinkSync(file)
  }
}
