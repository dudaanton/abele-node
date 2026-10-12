import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Locate the owning release in both workspace and copied node_modules layouts.
 * Never use the core workspace's 0.0.0 or a provider's package version.
 */
export function nodeReleaseVersion(moduleUrl = import.meta.url): string {
  let directory = dirname(fileURLToPath(moduleUrl))
  for (;;) {
    const manifest = join(directory, 'package.json')
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string; version?: string }
      if (pkg.name === 'abele-node' && typeof pkg.version === 'string' && pkg.version.length)
        return pkg.version
    }
    const parent = dirname(directory)
    if (parent === directory) throw new Error('node_release_manifest_not_found')
    directory = parent
  }
}
