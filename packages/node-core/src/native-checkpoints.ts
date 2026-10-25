import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readSync,
  writeSync,
  linkSync,
  mkdirSync,
  realpathSync,
  lstatSync,
  readFileSync,
  unlinkSync,
  fsyncSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { ChannelError } from '@abele/channel-protocol'

export type NativeCheckpoint = string | { file: string; bytes: number }
const LEGACY_MAX = 32 * 1024 * 1024
const HEADER_MAX = 65536
/** A store pins its trusted root once; later ancestor aliases cannot redirect it. */
export class NativeCheckpointRoot {
  readonly path: string
  constructor(state: string, options: { canonical?: boolean } = {}) {
    this.path = options.canonical ? state : realpathSync(state)
  }
}
type Root = string | NativeCheckpointRoot
function pinned(state: Root) {
  return typeof state === 'string' ? new NativeCheckpointRoot(state) : state
}
function directory(state: Root) {
  const root = pinned(state).path
  if (realpathSync(root) !== root) throw new ChannelError('unsafe_path')
  const dir = join(root, 'native-checkpoints')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (realpathSync(dir) !== dir) throw new ChannelError('unsafe_path')
  return dir
}
function referencePath(state: Root, ref: Exclude<NativeCheckpoint, string>) {
  if (!/^[0-9]+-[0-9]+\.jsonl$/.test(ref.file) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1)
    throw new ChannelError('invalid_pi_native_state')
  return join(directory(state), ref.file)
}
/** The pi host marks writers whose rewrites use atomic replacement. Appends never
 * change a checkpoint's prefix; replacement leaves its hard-linked inode intact. */
export function captureNative(state: Root, session: string, file: string): NativeCheckpoint {
  state = pinned(state)
  const parent = join(state.path, 'pi-sessions', session)
  if (realpathSync(dirname(file)) !== parent) throw new ChannelError('unsafe_path')
  // Resolve trusted ancestors, never the final file. Open only the pinned path,
  // so a later alias change cannot redirect the lstat, marker, or hard link.
  file = join(parent, basename(file))
  if (lstatSync(file).isSymbolicLink()) throw new ChannelError('unsafe_path')
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(fd, { bigint: true })
    const size = Number(stat.size)
    if (!stat.isFile() || !Number.isSafeInteger(size)) throw new ChannelError('unsafe_path')
    let safe = false
    try {
      const marker = openSync(file + '.checkpoint-safe', constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        if (fstatSync(marker).size <= 128)
          safe = readFileSync(marker, 'utf8') === `${stat.dev}:${stat.ino}`
      } finally {
        closeSync(marker)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (!safe) {
      // Compatibility for old hosts, which may still overwrite the inode.
      if (size > LEGACY_MAX) throw new ChannelError('pi_checkpoint_writer_upgrade_required')
      return readFileSync(fd, 'utf8')
    }
    const last = Buffer.alloc(1)
    if (!size || readSync(fd, last, 0, 1, size - 1) !== 1 || last[0] !== 10)
      throw new ChannelError('invalid_pi_native_state')
    const ref = { file: `${stat.dev}-${stat.ino}.jsonl`, bytes: size }
    const path = referencePath(state, ref)
    let created = false
    try {
      linkSync(file, path)
      created = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const linked = lstatSync(path, { bigint: true })
    if (linked.ino !== stat.ino || linked.dev !== stat.dev || !linked.isFile()) {
      unlinkSync(path)
      throw new ChannelError('stale_revision')
    }
    fsyncSync(fd)
    if (created) {
      const parentFd = openSync(dirname(path), constants.O_RDONLY)
      try {
        fsyncSync(parentFd)
      } finally {
        closeSync(parentFd)
      }
    }
    return ref
  } finally {
    closeSync(fd)
  }
}
function openReference(state: Root, native: Exclude<NativeCheckpoint, string>) {
  const fd = openSync(referencePath(state, native), constants.O_RDONLY | constants.O_NOFOLLOW)
  const stat = fstatSync(fd)
  if (!stat.isFile() || stat.size < native.bytes) {
    closeSync(fd)
    throw new ChannelError('invalid_pi_native_state')
  }
  return fd
}
function header(bytes: Buffer, allowEnd = false) {
  let nl = bytes.indexOf(10)
  if (nl < 0 && allowEnd) nl = bytes.length
  if (nl < 0) throw new ChannelError('invalid_pi_native_state')
  const value = JSON.parse(bytes.subarray(0, nl).toString('utf8'))
  if (value.type !== 'session') throw new ChannelError('invalid_pi_native_state')
  return { value, offset: Math.min(nl + 1, bytes.length) }
}
export function nativeHeader(state: Root, native: NativeCheckpoint) {
  if (typeof native === 'string')
    return header(Buffer.from(native.slice(0, HEADER_MAX)), native.length < HEADER_MAX)
  const fd = openReference(state, native)
  try {
    const bytes = Buffer.alloc(Math.min(HEADER_MAX, native.bytes))
    const n = readSync(fd, bytes, 0, bytes.length, 0)
    return header(bytes.subarray(0, n))
  } finally {
    closeSync(fd)
  }
}
/** Restoring is deliberately O(selected prefix), with fixed working memory. */
export function writeNative(
  state: Root,
  native: NativeCheckpoint,
  destination: string,
  id: string,
  cwd: string
) {
  state = pinned(state)
  const { value, offset } = nativeHeader(state, native)
  const output = openSync(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600
  )
  let input: number | undefined
  try {
    const first = Buffer.from(JSON.stringify({ ...value, id, cwd }) + '\n')
    const write = (bytes: Buffer) => {
      let n = 0
      while (n < bytes.length) n += writeSync(output, bytes, n, bytes.length - n)
    }
    write(first)
    if (typeof native === 'string') {
      const rest = Buffer.from(native).subarray(offset)
      write(rest)
      if (rest.length && rest.at(-1) !== 10) write(Buffer.from('\n'))
    } else {
      input = openReference(state, native)
      const buffer = Buffer.alloc(128 * 1024)
      let position = offset
      while (position < native.bytes) {
        const n = readSync(
          input,
          buffer,
          0,
          Math.min(buffer.length, native.bytes - position),
          position
        )
        if (!n) throw new ChannelError('invalid_pi_native_state')
        write(buffer.subarray(0, n))
        position += n
      }
    }
    fsyncSync(output)
  } catch (error) {
    unlinkSync(destination)
    throw error
  } finally {
    if (input !== undefined) closeSync(input)
    closeSync(output)
  }
}
