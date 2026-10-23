import { it, expect } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  realpathSync,
  lstatSync,
  symlinkSync,
  existsSync,
} from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LspService } from '../packages/node-core/src/lsp/service.js'

async function checkServerPaths(
  kind:
    'root alias' | 'literal backslash' | 'case alias' | 'case root' | 'case file' | 'outside alias'
) {
  const dir = mkdtempSync(resolve('.scratch/lsp-paths-'))
  const root = join(dir, 'project'),
    alias = join(dir, 'project-alias')
  mkdirSync(root)
  const outside = join(dir, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'a.ts'), 'outside')
  symlinkSync(kind === 'outside alias' ? outside : root, alias)
  const path = kind === 'literal backslash' ? 'a\\b.ts' : 'a.ts'
  writeFileSync(join(root, path), 'let a = 1')
  const service = new LspService(dir, {
    trusted: () => true,
    check: (root, path) => {
      if (path.startsWith('/') || path.split('/').some((p) => p === '..'))
        throw new Error('unsafe_path')
      const target = join(root, path)
      if (lstatSync(target).isSymbolicLink() || realpathSync(target) !== target)
        throw new Error('unsafe_path')
      return target
    },
    command: (language) =>
      language === 'typescript'
        ? {
            command: process.execPath,
            args: [
              resolve('tests/fixtures/fake-lsp.mjs'),
              language,
              join(dir, 'frames'),
              ...(kind === 'root alias' || kind === 'outside alias'
                ? [pathToFileURL(alias).href]
                : kind === 'case alias'
                  ? [pathToFileURL(root.toUpperCase()).href]
                  : kind === 'case root'
                    ? [pathToFileURL(root).href]
                    : []),
            ],
          }
        : null,
  })
  try {
    const requestRoot = kind === 'case root' ? root.toUpperCase() : root
    const requestPath = kind === 'case file' ? 'A.ts' : path
    await service.open(requestRoot, requestPath)
    expect(
      (
        await service.query(requestRoot, requestPath, 'definition', { line: 0, character: 1 })
      ).locations?.map((l) => l.path)
    ).toEqual(kind === 'outside alias' ? [] : [path])
    await expect
      .poll(async () => (await service.query(requestRoot, requestPath, 'diagnostics')).diagnostics)
      .toEqual(kind === 'outside alias' ? [] : [expect.objectContaining({ source: 'typescript' })])
  } finally {
    await service.stop()
    rmSync(dir, { recursive: true, force: true })
  }
}
it.each(['root alias', 'literal backslash', 'outside alias'] as const)(
  'confines server URI results using filesystem identity (%s)',
  checkServerPaths
)
it
  .runIf(existsSync(process.cwd().toUpperCase()))
  .each(['case alias', 'case root', 'case file'] as const)(
  'confines server URI results on a case-insensitive filesystem (%s)',
  checkServerPaths
)
