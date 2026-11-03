import { readdir, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** js-debug must use the same repo-relative identities, including future lazy
 * scripts. Guard relocation against both filesystem and file-URL owner paths;
 * identity overrides cannot guard them because js-debug skips unchanged results. */
export async function sourceMapPathOverrides(
  root?: string
): Promise<Record<string, string> | undefined> {
  if (!root) return
  const overrides: Record<string, string> = {
    'webpack:///./~/*': root + '/node_modules/*',
    'webpack:////*': '/*',
    'webpack://@?:*/?:*/*': root + '/*',
    'webpack://?:*/*': root + '/*',
    'webpack:///./*': root + '/*',
  }
  const suffixes: string[] = []
  for (const entry of (await readdir(root, { withFileTypes: true })).slice(0, 4096)) {
    if (entry.name.startsWith('.') || /[?*]/.test(entry.name)) continue
    suffixes.push(escapeRegex(entry.name) + (entry.isDirectory() ? '/.*' : ''))
  }
  if (suffixes.length) {
    const owner = `(?:${[root, pathToFileURL(root).href, 'file://' + root].map(escapeRegex).join('|')})(?:/|$)`
    // js-debug accepts raw regex patterns when the replacement uses $1 and no
    // wildcard. The negative lookahead excludes owner paths from every rule,
    // independently of the adapter's longest-pattern-first priority. One rule
    // also keeps an earlier repo-relative segment (src/packages) ahead of a
    // later segment (packages), regardless of their names' lengths.
    overrides[`(?!${owner}).*?/(${suffixes.join('|')})`] = root.replace(/\$/g, '$$$$') + '/$1'
  }
  return overrides
}

/** Resolve only inside the owner folder. Relocated maps can name an old checkout;
 * use its longest existing repo-relative suffix, never read that other checkout.
 * Callers must still prove the original content before trusting this identity. */
export async function mappedSourcePath(
  root: string,
  mapPath: string,
  sourceRoot: string,
  source: string
): Promise<string | undefined> {
  try {
    const base = new URL('.', pathToFileURL(mapPath))
    const prefix = sourceRoot ? new URL(sourceRoot.replace(/\/?$/, '/'), base) : base
    const address = new URL(source, prefix)
    if (!['file:', 'webpack:'].includes(address.protocol)) return
    const path =
      address.protocol === 'file:'
        ? fileURLToPath(address)
        : resolve(root, '.' + decodeURIComponent(address.pathname))
    const inside = (path: string) => {
      const rel = relative(root, path)
      return !!rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel)
    }
    const local = async (path: string) => {
      if (!inside(path)) return
      const full = await realpath(path).catch(() => undefined)
      return full && inside(full) ? full : undefined
    }
    if (inside(path)) return await local(path)
    // Relative paths escaping the owner are not relocation declarations.
    if (
      !isAbsolute(source) &&
      !isAbsolute(sourceRoot) &&
      !/^(file:|webpack:)/.test(sourceRoot + source)
    )
      return
    const parts = path.split(sep).filter(Boolean)
    for (let i = 0; i < parts.length; i++) {
      const found = await local(resolve(root, ...parts.slice(i)))
      if (found) return found
    }
  } catch {
    // Unsupported or malformed URLs supply no identity.
  }
}
