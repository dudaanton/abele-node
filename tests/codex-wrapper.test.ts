import { expect, it } from 'vitest'
import { join, resolve } from 'node:path'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { discoverCodex, resolveCodexExecutable } from '../packages/provider-codex/src/discovery.js'
it.each(['bundled', 'optional', 'aliased-bin'])(
  'resolves the official npm %s native layout without executing its launcher',
  (layout) => {
    const dir = mkdtempSync(resolve('.scratch/codex-npm-'))
    const root = join(dir, 'node_modules/@openai/codex')
    const launcher = join(root, 'bin/codex.js')
    const name = `@openai/codex-${process.platform}-${process.arch}`
    const nativeRoot = layout === 'bundled' ? root : join(dir, 'node_modules', name)
    const triple = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`
    const folder = layout === 'aliased-bin' ? 'bin' : 'codex'
    const version = layout === 'aliased-bin' ? '0.162.1' : '0.160.1'
    const native = join(nativeRoot, 'vendor', triple, folder, 'codex')
    mkdirSync(join(root, 'bin'), { recursive: true })
    mkdirSync(join(nativeRoot, 'vendor', triple, folder), { recursive: true })
    // The tool helper ships beside the native executable.
    writeFileSync(join(nativeRoot, 'vendor', triple, folder, 'codex-code-mode-host'), '', {
      mode: 0o700,
    })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@openai/codex', version }))
    if (layout !== 'bundled')
      writeFileSync(
        join(nativeRoot, 'package.json'),
        JSON.stringify(
          layout === 'aliased-bin'
            ? { name: '@openai/codex', version: `${version}-${process.platform}-${process.arch}` }
            : { name, version }
        )
      )
    writeFileSync(launcher, '#!/usr/bin/env node\nthrow new Error("never execute launcher")\n', {
      mode: 0o700,
    })
    copyFileSync(process.execPath, native)
    try {
      expect(resolveCodexExecutable(launcher)).toBe(native)
      // Resolution is not readiness: the native target still must pass the exact version pin.
      expect(() => discoverCodex({ executable: launcher })).toThrow('codex_version_unsupported')
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'opaque-wrapper', version }))
      expect(() => discoverCodex({ executable: launcher })).toThrow('wrapper_unsupported')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
it('does not accept opaque Node launchers in production even if their advertised version matches', () => {
  const executable = resolve('tests/fixtures/codex.mjs')
  expect(() => discoverCodex({ executable })).toThrow('wrapper_unsupported')
})
