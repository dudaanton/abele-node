import { expect, it } from 'vitest'
// @ts-expect-error Manual probe formatter; importing does not launch Codex
import { formatProbeReport } from '../probes/codex-stage0.mjs'
it('formats Codex probe output as human text by default and JSON only explicitly', () => {
  const report = {
    version: 'codex-cli 0.160.1',
    checks: [{ name: 'write', passed: true }],
    inference_turns: 0,
    release_gate: 'incomplete',
    unverified: ['native approvals'],
  }
  expect(formatProbeReport(report)).toContain('Inference turns: 0')
  expect(formatProbeReport(report)).not.toMatch(/^\s*\{/)
  expect(JSON.parse(formatProbeReport(report, true))).toEqual(report)
})
