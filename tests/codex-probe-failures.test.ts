import { expect, it } from 'vitest'
// @ts-expect-error Manual probe helper; importing never launches Codex.
import { assertReplayProgress, assertConfinementResult } from '../probes/codex-probe-checks.mjs'

it('reports an already failed replay instead of waiting for an impossible approval', () => {
  expect(() =>
    assertReplayProgress('run', [
      { type: 'run.failed', data: { run_id: 'run', reason: 'process_probe_unavailable' } },
    ])
  ).toThrow('native_replay_run_failed:process_probe_unavailable')
  expect(() =>
    assertReplayProgress('run', [
      { type: 'run.failed', data: { run_id: 'previous', reason: 'process_probe_unavailable' } },
    ])
  ).not.toThrow()
  expect(() =>
    assertReplayProgress('run', [
      { type: 'run.failed', data: { run_id: 'run', reason: 'private diagnostic payload' } },
    ])
  ).toThrow('native_replay_run_failed:provider_failure')
})

it('reports a replay run the provider interrupted before any approval', () => {
  expect(() =>
    assertReplayProgress('run', [
      { type: 'run.interrupted', data: { run_id: 'run', reason: 'codex_rpc_error:-32603' } },
    ])
  ).toThrow('native_replay_run_failed:codex_rpc_error:-32603')
  expect(() =>
    assertReplayProgress('run', [
      { type: 'run.interrupted', data: { run_id: 'run', reason: 'private diagnostic payload' } },
    ])
  ).toThrow('native_replay_run_failed:provider_failure')
})

it('distinguishes a command RPC failure from a confinement assertion failure', () => {
  expect(() =>
    assertConfinementResult('workspace write', { error: { code: -32603 } }, true, false)
  ).toThrow('confinement_probe_rpc_failed:workspace write:-32603')
})

it('keeps allowed writes, forbidden effects, exit codes and secret-output checks mandatory', () => {
  expect(() =>
    assertConfinementResult('workspace write', { exitCode: 0, stdout: '' }, true, true)
  ).not.toThrow()
  expect(() =>
    assertConfinementResult('state read', { exitCode: 1, stdout: '' }, false)
  ).not.toThrow()
  for (const [result, expected, effect] of [
    [{ exitCode: 1 }, true, false],
    [{ exitCode: 0 }, true, false],
    [{ exitCode: 0 }, false, true],
    [{ exitCode: 1 }, false, true],
    [{ exitCode: 1, stdout: 'synthetic-state-secret' }, false, false],
    [{}, false, false],
  ] as const) {
    expect(() => assertConfinementResult('scenario', result, expected, effect)).toThrow(
      'confinement_probe_failed:scenario'
    )
  }
})

it('fails a chain case when a chain directory moved, a lookalike appeared or denied content leaked', async () => {
  // @ts-expect-error Manual probe helper; importing never launches Codex.
  const { assertChainIntact } = await import('../probes/codex-probe-checks.mjs')
  const intact = { chainIntact: true, escapedPaths: [], output: 'mv: Operation not permitted' }
  expect(() => assertChainIntact('rename', intact)).not.toThrow()
  expect(() => assertChainIntact('rename', { ...intact, chainIntact: false })).toThrow(
    'chain_probe_failed:rename:chain'
  )
  expect(() => assertChainIntact('link', { ...intact, escapedPaths: ['/state/x'] })).toThrow(
    'chain_probe_failed:link:effect'
  )
  expect(() => assertChainIntact('read', { ...intact, output: 'synthetic-state-secret' })).toThrow(
    'chain_probe_failed:read:leak'
  )
})
