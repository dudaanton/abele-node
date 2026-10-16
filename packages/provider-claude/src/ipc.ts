import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const prefix = 'abele-p-'
function ipcRoot() {
  // Canonicalize before measuring: macOS temporary paths can have symlink aliases.
  const temporary = realpathSync(tmpdir())
  return Buffer.byteLength(join(temporary, prefix + 'XXXXXX/p.sock')) <= 100
    ? temporary
    : realpathSync('/tmp')
}
export function createRunIpc() {
  // Per-run endpoints are ephemeral, independent of HOME and any long state path.
  const dir = mkdtempSync(join(ipcRoot(), prefix))
  try {
    chmodSync(dir, 0o700)
    return dir
  } catch (error) {
    rmSync(dir, { recursive: true, force: true })
    throw error
  }
}
/** The version of the protocol between a node and a session host it started or adopts. */
export const HOST_PROTOCOL = 1
/** A per-run directory this provider creates, by name; says nothing about its contents. */
export function isRunIpc(dir: string) {
  return (
    dirname(dir) === ipcRoot() &&
    /^abele-p-[A-Za-z0-9]{6}$/.test(basename(dir)) &&
    Buffer.byteLength(join(dir, 'p.sock')) <= 100
  )
}
/** Before trusting what is in a directory a previous node left: ours, private, and real. */
export function verifyRunIpc(dir: string, socket?: string) {
  if (!isRunIpc(dir)) throw new Error('unmanaged_ipc_directory')
  const stat = lstatSync(dir)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    realpathSync(dir) !== dir ||
    stat.uid !== process.getuid!() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('unsafe_ipc_directory')
  if (socket) {
    const entry = lstatSync(socket)
    if (!entry.isSocket() || entry.uid !== process.getuid!()) throw new Error('unsafe_ipc_socket')
  }
}
export function cleanupRunIpc(dir: string) {
  if (!isRunIpc(dir)) throw new Error('unmanaged_ipc_directory')
  try {
    const stat = lstatSync(dir)
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      realpathSync(dir) !== dir ||
      stat.uid !== process.getuid!() ||
      (stat.mode & 0o777) !== 0o700
    )
      throw new Error('unsafe_ipc_directory')
    rmSync(dir, { recursive: true, force: true })
  } catch (error) {
    // Worker and daemon both own cleanup. Only confirmed absence permits either
    // owner to settle a concurrent removal as successful, not an arbitrary error.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        lstatSync(dir)
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code === 'ENOENT') return
        throw probe
      }
    }
    throw error
  }
}
