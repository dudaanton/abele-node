import { expect, it } from 'vitest'
import { CodexProviderAdapter } from '@abele/provider-codex'
import { codexExecutionGates } from '../packages/provider-codex/src/gates.js'
it('exposes native approval scope independently of provider readiness', () => {
  const adapter = new CodexProviderAdapter({ stateDir: '/fixture/state', enabled: false })
  expect(adapter.capabilities().configuration).toMatchObject({
    approval_mode: 'on-request',
    per_action_approval: false,
    workspace_actions_without_approval: true,
  })
})
it.each(['0.163.0', '0.161.0', '0.162.0'])(
  'does not transfer native execution evidence to unproven version %s',
  (version) => {
    const gates = codexExecutionGates('darwin', version)
    expect(gates.some((gate) => gate.status === 'verified')).toBe(false)
    expect(gates.find((gate) => gate.name === 'native_approvals')?.error).toBe(
      'codex_native_approvals_uncertified'
    )
  }
)
it('enables 0.162.1 on its own native evidence only', () => {
  const gates = codexExecutionGates('darwin', '0.162.1')
  expect(gates.filter((g) => g.status === 'verified').map((g) => g.name)).toEqual([
    'native_approvals',
    'builtin_reader',
    'native_lifecycle',
    'native_delegation',
    'detached_descendants',
  ])
  for (const gate of gates.filter((g) => g.status === 'verified'))
    expect(gate.evidence).toMatch(/^0\.162\.1-/)
  expect(gates.find((g) => g.name === 'native_approvals')?.evidence).toBe(
    '0.162.1-loopback-replay-durable-allow-deny-escalation-confined-to-workspace'
  )
  expect(gates.filter((g) => g.status !== 'verified').map((g) => g.name)).toEqual([
    'host_temp',
    'live_acceptance',
  ])
  expect(codexExecutionGates('linux', '0.162.1')[0]?.error).toBe(
    'codex_platform_confinement_uncertified'
  )
})
it('reports the native sampled-descendant/marker checkpoint and retains preflight errors', () => {
  const gates = codexExecutionGates('darwin')
  expect(gates.find((g) => g.name === 'detached_descendants')).toMatchObject({
    status: 'verified',
    evidence: '0.160.1-native-setsid-marker-sweep-with-sampled-descendants',
  })
  expect(
    new CodexProviderAdapter({ stateDir: '/fixture/state' }).capabilities().capabilities.execution
      .reason
  ).toBe(codexExecutionGates().find((g) => g.error)?.error ?? 'codex_opaque_wrapper_unsupported')
})
it('does not certify Linux confinement from macOS evidence', () => {
  expect(
    codexExecutionGates('linux').some((g) => g.error === 'codex_platform_confinement_uncertified')
  ).toBe(true)
})
