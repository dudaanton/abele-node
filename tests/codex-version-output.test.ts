import { expect, it } from 'vitest'
import { humanOutput } from '../packages/node-daemon/src/output.js'

it('identifies a found unsupported version and its specific blocking gate', () => {
  const output = humanOutput(['status'], {
    codex: {
      available: false,
      provider_version: '0.162.1',
      diagnostic: 'codex_native_approvals_uncertified',
    },
  })
  expect(output).toContain('Codex 0.162.1 found, unsupported because')
  expect(output).toContain('codex_native_approvals_uncertified')
  expect(output).not.toContain('not installed')
})
