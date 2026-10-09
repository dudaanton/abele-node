import { expect } from 'vitest'
import { processIt as it } from './process-test.js'
import { processStepDeadlineMs } from '../scripts/process-test-budget.mjs'
import { cpSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
it('prepares the fake SDK nested patch in an installation path with spaces, not a percent-encoded sibling', () => {
  mkdirSync(resolve('.scratch'), { recursive: true })
  const root = mkdtempSync(join(resolve('.scratch'), 'pi sdk path-'))
  const put = (path: string, text: string) => {
    const full = join(root, path)
    mkdirSync(resolve(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }
  try {
    put(
      'packages/provider-pi/package.json',
      JSON.stringify({ name: '@abele/provider-pi', type: 'module' })
    )
    put('scripts/package.json', '{"type":"module"}')
    cpSync(
      new URL('../scripts/prepare-pi.mjs', import.meta.url),
      join(root, 'scripts/prepare-pi.mjs')
    )
    put(
      'node_modules/brace-expansion/package.json',
      JSON.stringify({ name: 'brace-expansion', version: '5.0.12', main: 'dist/commonjs/index.js' })
    )
    put('node_modules/brace-expansion/dist/commonjs/index.js', '// fake package; never imported\n')
    put(
      'node_modules/@earendil-works/pi-coding-agent/package.json',
      JSON.stringify({
        name: '@earendil-works/pi-coding-agent',
        version: '0.87.0',
        type: 'module',
        exports: { '.': { import: './dist/index.js' } },
      })
    )
    put(
      'node_modules/@earendil-works/pi-coding-agent/dist/index.js',
      '// fake SDK; never imported\n'
    )
    const nested =
      'node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion/package.json'
    put(nested, '{"version":"5.0.9"}')
    const result = spawnSync(process.execPath, [join(root, 'scripts/prepare-pi.mjs')], {
      encoding: 'utf8',
      timeout: processStepDeadlineMs,
      killSignal: 'SIGKILL',
    })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(readFileSync(join(root, nested), 'utf8')).version).toBe('5.0.12')
  } finally {
    rmSync(root, { recursive: true, force: true })
    // The old bug creates this uniquely owned scratch sibling during reproduction.
    rmSync(join(resolve('.scratch'), basename(root).replaceAll(' ', '%20')), {
      recursive: true,
      force: true,
    })
  }
}, 1)
