import {
  constants,
  openSync,
  closeSync,
  writeFileSync,
  readSync,
  fsyncSync,
  fchmodSync,
  renameSync,
  unlinkSync,
  statSync,
} from 'node:fs'
import { dirname } from 'node:path'
import type { SessionManager } from '@earendil-works/pi-coding-agent'
import { randomUUID } from 'node:crypto'

export function markAppendOnlyNative(file: string) {
  const stat = statSync(file, { bigint: true })
  writeFileSync(file + '.checkpoint-safe', `${stat.dev}:${stat.ino}`, { mode: 0o600 })
}
/** SDK 0.87.0 appends normal entries, but _rewriteFile truncates in place during
 * migration/fork. Replace that one writer before opening any session. Public
 * header/entry accessors preserve its exact serialization order. */
export function installAtomicNativeWrites(Manager: unknown): boolean {
  const prototype = (Manager as { prototype?: Record<string, unknown> }).prototype
  if (!prototype || typeof prototype._rewriteFile !== 'function') return false
  const key = Symbol.for('abele.atomic-pi-native-writes.v1')
  if ((prototype as Record<symbol, unknown>)[key]) return true
  prototype._rewriteFile = function (this: SessionManager) {
    const file = this.getSessionFile()
    if (!this.isPersisted() || !file) return
    const temporary = file + '.' + randomUUID() + '.tmp'
    const fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    )
    try {
      writeFileSync(fd, JSON.stringify(this.getHeader()) + '\n')
      for (const entry of this.getEntries()) writeFileSync(fd, JSON.stringify(entry) + '\n')
      fsyncSync(fd)
      renameSync(temporary, file)
      markAppendOnlyNative(file)
    } catch (error) {
      try {
        unlinkSync(temporary)
      } catch {}
      throw error
    } finally {
      closeSync(fd)
    }
  }
  ;(prototype as Record<symbol, unknown>)[key] = true
  return true
}
type NativeState = Pick<
  SessionManager,
  | 'getSessionFile'
  | 'getSessionId'
  | 'getHeader'
  | 'getEntries'
  | 'getLeafId'
  | 'setSessionFile'
  | 'branch'
  | 'resetLeaf'
>
/** 0.87.0 defers JSONL until the first assistant response. Materialize the exact
 * header/pending entries, fsync, then reload through the public API so its flushed
 * flag agrees with disk. No synthetic assistant and no private SDK fields. */
export function materializeNativeState(manager: NativeState) {
  const file = manager.getSessionFile(),
    header = manager.getHeader(),
    leaf = manager.getLeafId()
  if (!file || !header || header.id !== manager.getSessionId())
    throw new Error('invalid_pi_native_state')
  let fd: number,
    created = false
  try {
    fd = openSync(
      file,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600
    )
    created = true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    fd = openSync(file, constants.O_RDWR | constants.O_NOFOLLOW)
  }
  try {
    if (created)
      writeFileSync(
        fd,
        [header, ...manager.getEntries()].map((e) => JSON.stringify(e)).join('\n') + '\n'
      )
    else {
      const bytes = Buffer.alloc(65536),
        length = readSync(fd, bytes, 0, bytes.length, 0),
        nl = bytes.subarray(0, length).indexOf(10)
      if (nl < 0 || JSON.parse(bytes.subarray(0, nl).toString('utf8')).id !== header.id)
        throw new Error('pi_native_context_mismatch')
    }
    fchmodSync(fd, 0o600)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  const directory = openSync(dirname(file), constants.O_RDONLY)
  try {
    fsyncSync(directory)
  } finally {
    closeSync(directory)
  }
  if (created) {
    manager.setSessionFile(file)
    if (manager.getSessionId() !== header.id) throw new Error('pi_native_context_mismatch')
    if (leaf === null) manager.resetLeaf()
    else manager.branch(leaf)
  }
}
