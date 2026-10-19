import { afterEach, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function fixture() {
  const dir = mkdtempSync(resolve('.scratch/lsp-cli-'))
  dirs.push(dir)
  const bin = join(dir, 'bin')
  mkdirSync(bin)
  writeFileSync(join(bin, 'npm'), '#!/bin/sh\necho "$@" >> "$INSTALL_LOG"\n', { mode: 0o700 })
  writeFileSync(join(bin, 'rustup'), '#!/bin/sh\necho "component missing" >&2\nexit 1\n', {
    mode: 0o700,
  })
  symlinkSync(join(bin, 'rustup'), join(bin, 'rust-analyzer'))
  writeFileSync(
    join(dir, 'offline.mjs'),
    'globalThis.fetch = async () => { throw new Error("fake_rust_download") }'
  )
  return { dir, bin }
}
function command(f: ReturnType<typeof fixture>, ...args: string[]) {
  return spawnSync(
    process.execPath,
    [
      '--import',
      join(f.dir, 'offline.mjs'),
      resolve('packages/node-daemon/dist/cli.js'),
      ...args,
      '--state-dir',
      join(f.dir, 'state'),
      '--claude-path',
      '/fake/claude',
      '--codex-path',
      '/fake/codex',
      '--codex-model',
      'fake-model',
      '--codex-home',
      join(f.dir, 'codex'),
      '--runtime-dir',
      f.dir,
      '--no-pi-live',
      '--port',
      '0',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: f.bin, INSTALL_LOG: join(f.dir, 'installs') },
    }
  )
}
it('accepts wrapper globals after an explicit language', () => {
  const result = command(fixture(), 'lsp', 'install', 'typescript')
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toMatch(/^typescript: installed .+\n$/)
})
it('keeps explicit installs machine-readable only with --json', () => {
  const result = command(fixture(), 'lsp', 'install', 'typescript', '--json')
  expect(result.status, result.stderr).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual([
    {
      language: 'typescript',
      message: expect.stringContaining('installed typescript-language-server'),
    },
  ])
})
it('consumes repeated global switches before positional commands', () => {
  const result = command(
    fixture(),
    'token',
    'create',
    'desktop',
    '--no-pi-live',
    '--no-codex',
    '--no-codex'
  )
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('Installation token:')
})
it('uses operator state and port ahead of appended wrapper defaults', () => {
  const f = fixture(),
    state = join(f.dir, 'operator-state')
  const result = command(f, 'token', 'create', 'desktop', '--state-dir', state, '--port', '7799')
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain('URL: http://127.0.0.1:7799')
  expect(readFileSync(join(state, 'node.sqlite')).length).toBeGreaterThan(0)
  expect(() => readFileSync(join(f.dir, 'state', 'node.sqlite'))).toThrow()
})
it('continues to parse every repeatable account instead of treating later accounts as defaults', () => {
  const result = command(
    fixture(),
    'version',
    '--claude-account',
    'one=/fake/one',
    '--claude-account',
    'bad-entry'
  )
  expect(result.status).toBe(1)
  expect(result.stderr).toContain('invalid_claude_account')
})
it.each([[], ['--popular']])('installs the popular set for %j without network', (...args) => {
  const f = fixture()
  const result = command(f, 'lsp', 'install', ...args)
  expect(result.stderr).toContain('fake rust download')
  expect(readFileSync(join(f.dir, 'installs'), 'utf8')).toContain(
    'typescript-language-server@4.3.4'
  )
  expect(readFileSync(join(f.dir, 'installs'), 'utf8')).toContain('bash-language-server@5.4.3')
})
it.each([['version'], ['token', 'create', 'desktop'], ['service', 'status']])(
  'accepts trailing wrapper globals for %j',
  (...args) => {
    const result = command(fixture(), ...args)
    expect(result.status, result.stderr).toBe(0)
  }
)
it.each([
  ['token', 'create', 'desktop'],
  ['pair', 'list'],
  ['approve-pair', '--list'],
  ['recover-worktree-deletion', 'operation-one', 'installation-one'],
  ['service', 'status'],
  ['debugger', 'install', 'js'],
  ['serve', 'disable'],
  ['update', '--check'],
  ['lsp', 'install', 'typescript'],
])('consumes wrapper defaults even when an operator overrides a global: %j', (...args) => {
  const f = fixture()
  const baseline = command(f, ...args, '--json')
  const overridden = command(
    f,
    ...args,
    '--json',
    '--claude-path',
    '/operator/claude',
    '--codex-path',
    '/operator/codex',
    '--codex-model',
    'operator-model',
    '--codex-home',
    join(f.dir, 'operator-codex')
  )
  expect(overridden.status, overridden.stderr).toBe(baseline.status)
  expect(overridden.stderr).toBe(baseline.stderr)
  // Token creation intentionally generates a new secret on each invocation.
  if (args[0] === 'token') expect(JSON.parse(overridden.stdout)).toHaveProperty('token')
  else expect(overridden.stdout).toBe(baseline.stdout)
})
it('reports a missing rustup component and never renders a null version', () => {
  const f = fixture()
  const result = command(f, 'lsp', 'status')
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).not.toContain('(null)')
  expect(result.stdout).toContain('rust: missing')
  expect(result.stdout).toContain('rustup component add rust-analyzer')
  const json = command(f, 'lsp', 'status', '--json')
  expect(
    JSON.parse(json.stdout).find((row: { language: string }) => row.language === 'rust')
  ).toMatchObject({ found: false, version: null })
})
it('locates an installed rustup component without probing an untrusted server', () => {
  const f = fixture()
  const target = join(f.dir, 'real-rust-analyzer')
  writeFileSync(target, '#!/bin/sh\necho started > "$INSTALL_LOG"\n', { mode: 0o700 })
  writeFileSync(join(f.bin, 'rustup'), `#!/bin/sh\nprintf '%s\\n' '${target}'\n`, { mode: 0o700 })
  const result = command(f, 'lsp', 'status')
  expect(result.status, result.stderr).toBe(0)
  expect(result.stdout).toContain(`rust: ${target} (version not checked)`)
  expect(() => readFileSync(join(f.dir, 'installs'))).toThrow()
})
