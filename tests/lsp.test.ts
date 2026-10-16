import { it, expect, afterEach } from 'vitest'
import {
  installPlan,
  install,
  status,
  executable,
  discover,
} from '../packages/node-core/src/lsp/servers.js'
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
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, relative, delimiter } from 'node:path'
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
it('does not start project-code servers without trust, including implicit queries and refresh', async () => {
  const root = temp()
  for (const path of ['a.ts', 'a.py', 'a.sh', 'a.go', 'a.rs', 'a.json'])
    writeFileSync(join(root, path), '')
  mkdirSync(join(root, 'node_modules/eslint'), { recursive: true })
  writeFileSync(join(root, 'node_modules/eslint/package.json'), '{}')
  const service = new LspService(root, {
    check: (base, path) => join(base, path),
    command: () => ({ command: process.execPath, args: [fixture] }),
  })
  cleanups.push(() => service.stop())
  for (const path of ['a.ts', 'a.py', 'a.sh', 'a.go', 'a.rs']) {
    expect(await service.open(root, path)).toEqual({ servers: [] })
    expect(await service.query(root, path, 'diagnostics')).toEqual({ diagnostics: [] })
    await expect(service.query(root, path, 'hover', { line: 0, character: 0 })).rejects.toThrow(
      'untrusted_folder'
    )
  }
  await service.refresh(root)
  expect((service as any).slots.size).toBe(0)
  expect(await service.open(root, 'a.json')).toEqual({ servers: ['json'] })
})
it('drops diagnostics and prevents crash restarts as soon as folder trust is revoked', async () => {
  const root = temp(),
    log = join(root, 'frames')
  writeFileSync(join(root, 'a.ts'), '')
  let trusted = true
  const service = new LspService(root, {
    trusted: () => trusted,
    check: (base, path) => join(base, path),
    command: (language) =>
      language === 'typescript'
        ? { command: process.execPath, args: [fixture, 'typescript', log] }
        : null,
  })
  cleanups.push(() => service.stop())
  await service.open(root, 'a.ts')
  await until(() => (service as any).diagnostics.size > 0)
  const slot = [...(service as any).slots.values()][0]
  trusted = false
  // Exercise the crash path before any query or explicit trust cleanup runs.
  slot.connection.notify('crash', {})
  await until(() => (service as any).slots.size === 0)
  expect(service.canRefresh(root)).toBe(false)
  expect(await service.query(root, 'a.ts', 'diagnostics')).toEqual({ diagnostics: [] })
  await service.refresh(root)
  expect(
    readFileSync(log, 'utf8')
      .split('\n')
      .filter((line) => line === 'initialize')
  ).toHaveLength(1)
})
it('reports blocked servers without starting even a version probe in an untrusted folder', async () => {
  const state = temp(),
    marker = join(state, 'started')
  const bin = join(state, 'lsp/typescript/bin')
  mkdirSync(bin, { recursive: true })
  const file = join(bin, 'typescript-language-server')
  writeFileSync(
    file,
    `#!${process.execPath}\nimport('node:fs').then(fs => fs.writeFileSync(${JSON.stringify(marker)}, 'started'))\n`
  )
  chmodSync(file, 0o700)
  const rows = await status(state, state)
  expect(rows.find((row) => row.language === 'typescript')).toMatchObject({
    found: true,
    reason: 'untrusted_folder',
    version: null,
  })
  expect(() => readFileSync(marker)).toThrow()
})
it('ignores relative and empty PATH entries and returns the canonical validated executable', () => {
  const dir = temp()
  const server = join(dir, 'server')
  writeFileSync(server, '#!/bin/sh\nexit 0\n')
  chmodSync(server, 0o700)
  symlinkSync(server, join(dir, 'alias'))
  expect(executable('server', ['', relative(process.cwd(), dir), '.'].join(delimiter))).toBeNull()
  expect(executable('alias', dir)).toBe(realpathSync(server))
})
it('launches the canonical discovered server with a different project cwd', async () => {
  const dir = temp()
  const root = join(dir, 'project')
  const bin = join(dir, 'bin')
  mkdirSync(root)
  mkdirSync(bin)
  mkdirSync(join(root, 'bin'))
  writeFileSync(join(root, 'a.ts'), 'let a = 1')
  const server = join(dir, 'validated-server')
  writeFileSync(server, `#!${process.execPath}\nimport(${JSON.stringify(fixture)})\n`)
  chmodSync(server, 0o700)
  symlinkSync(server, join(bin, 'typescript-language-server'))
  const decoy = join(root, 'bin/typescript-language-server')
  writeFileSync(decoy, '#!/bin/sh\nexit 99\n')
  chmodSync(decoy, 0o700)
  const previous = process.env.PATH
  process.env.PATH = ['bin', '', bin].join(delimiter)
  cleanups.push(() => {
    if (previous === undefined) delete process.env.PATH
    else process.env.PATH = previous
  })
  const found = discover(join(dir, 'state'), 'typescript')
  const service = new LspService(join(dir, 'state'), {
    trusted: () => true,
    check: (base, path) => join(base, path),
  })
  cleanups.push(() => service.stop())
  expect((await service.open(root, 'a.ts')).servers).toEqual(['typescript'])
  const slot = [...(service as any).slots.values()][0]
  expect(slot.connection.child.spawnfile).toBe(realpathSync(server))
  expect(found).toBe(realpathSync(server))
})
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
it.each(['direct', 'symlinked'] as const)(
  'shares processes, merges source-tagged diagnostics, confines definitions and stops idle (%s root)',
  async (kind) => {
    const dir = temp()
    const realRoot = join(dir, 'project')
    mkdirSync(realRoot)
    const root = kind === 'symlinked' ? join(dir, 'project-alias') : realRoot
    if (kind === 'symlinked') symlinkSync(realRoot, root)
    const log = join(dir, 'frames')
    writeFileSync(join(root, 'a.ts'), 'const a = 1')
    mkdirSync(join(root, 'node_modules/eslint'), { recursive: true })
    writeFileSync(join(root, 'node_modules/eslint/package.json'), '{}')
    symlinkSync('/etc/passwd', join(root, 'escape.ts'))
    const outside = join(dir, 'project-outside')
    mkdirSync(outside)
    writeFileSync(join(outside, 'secret.ts'), 'secret')
    symlinkSync(outside, join(root, 'escape-dir'))
    const service = new LspService(root, {
      trusted: () => true,
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
    // Both spellings must address the same processes and document versions.
    await service.open(realpathSync(root), 'a.ts', 'const a = 2')
    expect(
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line === 'initialize').length
    ).toBe(2)
    await expect(service.open(root, '../secret.ts')).rejects.toThrow('unsafe_path')
    await expect(service.open(root, 'escape.ts')).rejects.toThrow('unsafe_path')
    await expect(service.open(root, 'escape-dir/secret.ts')).rejects.toThrow('unsafe_path')
    await new Promise((r) => setTimeout(r, 300))
    await service.open(root, 'a.ts')
    expect(
      readFileSync(log, 'utf8')
        .split('\n')
        .filter((line) => line === 'initialize').length
    ).toBe(4)
  }
)
it('restarts once after a crash and reports a repeated crash', async () => {
  const root = temp(),
    log = join(root, 'frames'),
    errors: string[] = []
  writeFileSync(join(root, 'a.ts'), '')
  const service = new LspService(root, {
    trusted: () => true,
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
