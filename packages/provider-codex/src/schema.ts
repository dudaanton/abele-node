import { readFileSync, lstatSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, posix } from 'node:path'

export interface SchemaPins {
  roots: string[]
  files: Record<string, string>
}
export function schemaClosure(directory: string, roots: string[]): SchemaPins {
  const files: Record<string, string> = {}
  const visit = (name: string) => {
    if (name in files) return
    if (name.startsWith('../') || name.startsWith('/') || !name.endsWith('.ts'))
      throw new Error('invalid_schema_dependency')
    const path = join(directory, name)
    if (lstatSync(path).isSymbolicLink()) throw new Error('invalid_schema_dependency')
    const bytes = readFileSync(path)
    files[name] = createHash('sha256').update(bytes).digest('hex')
    for (const match of bytes
      .toString()
      .matchAll(/(?:import|export)\s+[^;]*?from\s+["']([^"']+)["']/g)) {
      const dependency = match[1]!
      if (!dependency.startsWith('.')) throw new Error('invalid_schema_dependency')
      const module = posix.normalize(posix.join(posix.dirname(name), dependency))
      visit(
        existsSync(join(directory, `${module}.ts`))
          ? `${module}.ts`
          : posix.join(module, 'index.ts')
      )
    }
  }
  roots.forEach(visit)
  return {
    roots,
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
  }
}
export function verifySchemaDirectory(directory: string, pins: SchemaPins) {
  const actual = schemaClosure(directory, pins.roots)
  if (
    JSON.stringify(actual.files) !==
    JSON.stringify(
      Object.fromEntries(Object.entries(pins.files).sort(([a], [b]) => a.localeCompare(b)))
    )
  )
    throw new Error('codex_schema_fingerprint_mismatch')
}
export function pinnedSchemas(experimental = false): SchemaPins {
  return JSON.parse(
    readFileSync(
      new URL(`../schemas/${experimental ? 'experimental' : 'stable'}-pins.json`, import.meta.url),
      'utf8'
    )
  )
}
