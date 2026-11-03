import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, normalize } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { sourceMapPathOverrides } from '../../packages/node-core/src/debugger/source-map-paths.js'

// Model the pinned js-debug 1.140.0 override consumer: longest pattern first,
// ?:* is noncapturing, raw regex replacements use $1, and unchanged replacements
// do not stop matching. This catches configuration bugs without a live adapter.
function applyOverrides(overrides: Record<string, string>, source: string) {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const keys = Object.keys(overrides).sort(
    (a, b) => b.replace('?:*', '*').length - a.replace('?:*', '*').length
  )
  for (const key of keys) {
    const replacement = overrides[key]!
    let regex: RegExp
    let target: string
    if (!replacement.includes('*') && /\$[0-9'`&]/.test(replacement)) {
      regex = new RegExp('^' + key + '$', 'i')
      target = replacement
    } else {
      let pattern = '',
        offset = 0
      for (const match of key.matchAll(/\?:\*|\*/g)) {
        pattern += escape(key.slice(offset, match.index)) + (match[0] === '*' ? '(.*?)' : '.*?')
        offset = match.index! + match[0].length
      }
      regex = new RegExp('^' + pattern + escape(key.slice(offset)) + '$', 'i')
      target = replacement.replace(/\$/g, '$$$$').replace('*', '$1')
    }
    const mapped = source.replace(regex, target)
    if (mapped !== source) return normalize(mapped)
  }
  return source
}

it('preserves owner paths with colliding directory suffixes and relocates only outside paths', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'owner map [paths]-')))
  try {
    mkdirSync(join(root, 'src/packages'), { recursive: true })
    mkdirSync(join(root, 'packages'))
    const nested = join(root, 'src/packages/main.ts'),
      other = join(root, 'packages/main.ts')
    writeFileSync(nested, 'export const value = 1')
    writeFileSync(other, 'export const value = 2')
    const overrides = (await sourceMapPathOverrides(root))!
    for (const path of [nested, other]) {
      for (const source of [path, pathToFileURL(path).href]) {
        const mapped = applyOverrides(overrides, source)
        expect(mapped.startsWith('file:') ? fileURLToPath(mapped) : mapped).toBe(path)
      }
    }
    for (const prefix of ['/old/checkout', 'file:///old/checkout']) {
      expect(applyOverrides(overrides, prefix + '/src/packages/main.ts')).toBe(nested)
      expect(applyOverrides(overrides, prefix + '/packages/main.ts')).toBe(other)
    }
    expect(applyOverrides(overrides, root + '-other/packages/main.ts')).toBe(other)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
