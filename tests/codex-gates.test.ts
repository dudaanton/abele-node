import { expect, it } from 'vitest'
import { CodexProviderAdapter } from '@abele/provider-codex'
import { codexExecutionGates } from '../packages/provider-codex/src/gates.js'
it('reports the native sampled-descendant/marker checkpoint and retains preflight errors', () => {
  const gates = codexExecutionGates('darwin')
  expect(gates.find((g) => g.name === 'detached_descendants')).toMatchObject({
    status: 'verified',
    evidence: '0.160.1-native-setsid-marker-sweep-with-sampled-descendants',
  })
  expect(
    new CodexProviderAdapter({ stateDir: '/fixture/state' }).capabilities().capabilities.execution
      .reason
  ).toBe(
    codexExecutionGates().find((g) => g.error)?.error ??
      'Not configured; select an executable and model, then run doctor preflight.'
  )
})
it('does not certify Linux confinement from macOS evidence', () => {
  expect(
    codexExecutionGates('linux').some((g) => g.error === 'codex_platform_confinement_uncertified')
  ).toBe(true)
})
