import { it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { LspService } from '../packages/node-core/src/lsp/service.js'

it('pulls diagnostics from advertised providers on open and refresh, without diagnostic pushes', async () => {
  const root = mkdtempSync(resolve('.scratch/lsp-pull-'))
  const log = join(root, 'frames')
  const published: any[] = []
  writeFileSync(join(root, 'a.js'), 'const unused = 42')
  mkdirSync(join(root, 'node_modules/eslint'), { recursive: true })
  writeFileSync(join(root, 'node_modules/eslint/package.json'), '{}')
  const service = new LspService(root, {
    trusted: () => true,
    diagnostics: (_root, _path, items) => published.push(...items),
    check: (root, path) => join(root, path),
    command: (language) =>
      language === 'eslint'
        ? {
            command: process.execPath,
            args: [resolve('tests/fixtures/fake-lsp.mjs'), 'pull', log, '', '80'],
          }
        : null,
  })
  try {
    expect(await service.open(root, 'a.js')).toEqual({ servers: ['eslint'] })
    await expect
      .poll(() => JSON.parse(readFileSync(log + '.configuration', 'utf8'))[0])
      .toMatchObject({
        experimental: { useFlatConfig: false },
        options: {},
        workspaceFolder: { uri: pathToFileURL(root).href },
      })
    await expect
      .poll(async () => (await service.query(root, 'a.js', 'diagnostics')).diagnostics)
      .toEqual([expect.objectContaining({ source: 'eslint', message: 'pulled diagnostic' })])
    const count = () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((m) => m === 'textDocument/diagnostic').length
    const before = count()
    writeFileSync(join(root, 'a.js'), 'const another = 42')
    await service.refresh(root)
    await expect.poll(count).toBeGreaterThan(before)
    await expect
      .poll(async () => (await service.query(root, 'a.js', 'diagnostics')).diagnostics)
      .toEqual([expect.objectContaining({ code: 'const another = 42' })])
    await service.open(root, 'a.js', 'stale buffer', 100)
    await service.open(root, 'a.js', 'current buffer', 101)
    await expect
      .poll(async () => (await service.query(root, 'a.js', 'diagnostics')).diagnostics)
      .toEqual([expect.objectContaining({ code: 'current buffer' })])
    expect(published.some((item) => item.code === 'stale buffer')).toBe(false)
    await service.open(root, 'a.js', 'closed buffer', 102)
    service.closeDocument(root, 'a.js')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(published.some((item) => item.code === 'closed buffer')).toBe(false)
  } finally {
    await service.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
