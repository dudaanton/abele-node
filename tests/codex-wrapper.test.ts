import { expect, it } from 'vitest'
import { resolve } from 'node:path'
import { discoverCodex } from '../packages/provider-codex/src/discovery.js'
it('does not accept opaque Node launchers in production even if their advertised version matches', () => {
  const executable = resolve('tests/fixtures/codex.mjs')
  expect(() => discoverCodex({ executable })).toThrow('wrapper_unsupported')
})
