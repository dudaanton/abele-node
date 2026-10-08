// SDK 0.87.0 ships a shrinkwrap that npm 10/11 reimports even during npm ci,
// ignoring the audited override. Replace only this generated, non-native module
// with the exact audited dependency; never execute third-party install scripts.
import { createRequire } from 'node:module'
import { cpSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
const require = createRequire(new URL('../packages/provider-pi/package.json', import.meta.url))
const source = dirname(dirname(dirname(require.resolve('brace-expansion'))))
if (JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version !== '5.0.12')
  throw new Error('audited_brace_expansion_missing')
const sdk = dirname(dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'))))
const target = join(sdk, 'node_modules/brace-expansion')
cpSync(source, target, { recursive: true })
if (JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).version !== '5.0.12')
  throw new Error('pi_dependency_patch_failed')
