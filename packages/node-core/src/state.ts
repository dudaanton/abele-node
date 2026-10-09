import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

/** Pin state to its physical location before creating any missing descendants.
 * Resolve only at startup, not per write: later alias changes must not redirect
 * the database, recovery files, provider state or a lock-release operation.
 */
export function canonicalStateDir(directory: string): string {
  let ancestor = resolve(directory)
  const missing: string[] = []
  for (;;) {
    try {
      return join(realpathSync(ancestor), ...missing)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // Never reinterpret an existing dangling symlink as a missing directory.
      try {
        lstatSync(ancestor)
        throw new Error('state_path_dangling_symlink')
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError
      }
      missing.unshift(basename(ancestor))
      ancestor = dirname(ancestor)
    }
  }
}
