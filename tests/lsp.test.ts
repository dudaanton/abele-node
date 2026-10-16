import { it, expect, afterEach } from 'vitest'
import { installPlan, install, status } from '../packages/node-core/src/lsp/servers.js'
import { LspConnection } from '../packages/node-core/src/lsp/connection.js'
import { LspService } from '../packages/node-core/src/lsp/service.js'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  lstatSync,
  realpathSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
const fixture = resolve('tests/fixtures/fake-lsp.mjs')
const cleanups: (() => unknown | Promise<unknown>)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})
function temp() {
  const root = mkdtempSync(join(tmpdir(), 'node-lsp-'))
  cleanups.push(() => rmSync(root, { recursive: true, force: true }))
  return root
}
async function until(fn: () => boolean) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('condition timed out')
}
it('plans pinned private language servers including ESLint', () => {
  const plan = installPlan(['typescript', 'eslint'], '/state')
  expect(plan).toHaveLength(2)
  expect(plan[0]!.args).toContain('--ignore-scripts')
  expect(plan[0]!.args).toContain('typescript-language-server@4.3.4')
  expect(plan[1]!.args).toContain('vscode-langservers-extracted@4.10.0')
  expect(() => installPlan(['unknown'], '/state')).toThrow()
})
it('frames UTF-8 bytes, handles server requests and cancels pending work', async () => {
  const c = new LspConnection(process.execPath, [fixture], process.cwd())
  cleanups.push(() => c.stop())
  c.onRequest = () => []
  expect(await c.request('initialize', {})).toHaveProperty('capabilities')
  expect(await c.request('echo', { text: 'Ошибка 🐛' })).toEqual({ text: 'Ошибка 🐛' })
  const abort = new AbortController()
  const pending = c.request('wait', {}, abort.signal)
  abort.abort()
  await expect(pending).rejects.toThrow('cancelled')
})
it('shares processes, merges source-tagged diagnostics, confines definitions and stops idle', async () => {
  const root = temp(),
    log = join(root, 'frames')
  writeFileSync(join(root, 'a.ts'), 'const a = 1')
  mkdirSync(join(root, 'node_modules/eslint'), { recursive: true })
  writeFileSync(join(root, 'node_modules/eslint/package.json'), '{}')
  symlinkSync('/etc/passwd', join(root, 'escape.ts'))
  const service = new LspService(root, {
    idleMs: 150,
    command: (language) =>
      ['typescript', 'eslint'].includes(language)
        ? { command: process.execPath, args: [fixture, language, log] }
        : null,
    check: (base, path) => {
      if (!path || path.split('/').some((p) => p === '..' || p === '.') || path.startsWith('/'))
        throw new Error('unsafe_path')
      const file = join(base, path)
      if (lstatSync(file).isSymbolicLink() || realpathSync(file) !== file)
        throw new Error('unsafe_path')
      return file
    },
  })
  cleanups.push(() => service.stop())
  expect((await service.open(root, 'a.ts')).servers).toEqual(['typescript', 'eslint'])
  await until(() => readFileSync(log, 'utf8').includes('textDocument/didOpen'))
  let merged: string[] = []
  for (let i = 0; i < 100; i++) {
    merged =
      (await service.query(root, 'a.ts', 'diagnostics')).diagnostics?.map((d) => d.source) ?? []
    if (merged.length === 2) break
    await new Promise((r) => setTimeout(r, 10))
  }
  const diagnostics = await service.query(root, 'a.ts', 'diagnostics')
  expect(diagnostics.diagnostics?.map((d) => d.source).sort()).toEqual(['eslint', 'typescript'])
  const result = await service.query(root, 'a.ts', 'definition', { line: 0, character: 1 })
  expect(result.locations).toEqual([
    { path: 'a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } },
  ])
  await service.open(root, 'a.ts', 'const a = 2')
  expect(
    readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line === 'initialize').length
  ).toBe(2)
  await expect(service.open(root, '../secret.ts')).rejects.toThrow('unsafe_path')
  await expect(service.open(root, 'escape.ts')).rejects.toThrow('unsafe_path')
  await new Promise((r) => setTimeout(r, 300))
  await service.open(root, 'a.ts')
  expect(
    readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line === 'initialize').length
  ).toBe(4)
})
it('restarts once after a crash and reports a repeated crash', async () => {
  const root = temp(),
    log = join(root, 'frames'),
    errors: string[] = []
  writeFileSync(join(root, 'a.ts'), '')
  const service = new LspService(root, {
    command: (language) =>
      language === 'typescript'
        ? { command: process.execPath, args: [fixture, 'crash', log] }
        : null,
    check: (_, path) => join(root, path),
    error: (_, message) => errors.push(message),
  })
  cleanups.push(() => service.stop())
  await expect(service.open(root, 'a.ts')).rejects.toThrow('lsp_exited')
  await until(
    () =>
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line === 'initialize').length === 2
  )
  await service.open(root, 'a.ts')
  // Trigger a second crash through a deterministic fake definition request.
  const slot = [...(service as any).slots.values()][0]
  slot.connection.notify('crash', {})
  await until(() => errors.length === 2)
  await expect(service.open(root, 'a.ts')).rejects.toThrow('lsp_repeated_crash')
})
it('uses fake install transports without network and refuses corrupt Rust binaries', async () => {
  const root = temp(),
    calls: string[][] = []
  const transport = {
    run: async (_command: string, args: string[]) => {
      calls.push(args)
      return ''
    },
    download: async () => Buffer.from('corrupt'),
  }
  const result = await install(root, ['typescript', 'eslint'], undefined, transport)
  expect(result).toHaveLength(2)
  expect(
    calls.every((args) => args.includes('--ignore-scripts') && args.includes('--prefix'))
  ).toBe(true)
  await expect(install(root, ['rust'], undefined, transport)).rejects.toThrow('checksum_mismatch')
  const rows = await status(root, root)
  expect(rows.find((r) => r.language === 'eslint')?.project_eslint).toContain('missing')
})
