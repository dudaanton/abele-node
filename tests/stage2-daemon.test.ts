import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  processStepDeadlineMs,
  stage2AcceptanceDeadlineMs,
} from '../scripts/process-test-budget.mjs'

it(
  'real CLI + node-client: two projects, isolated workspaces, fake sessions, preview, restart and safe removal',
  () => {
    const result = spawnSync(process.execPath, ['scripts/acceptance-stage2.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: stage2AcceptanceDeadlineMs,
      killSignal: 'SIGKILL',
    })
    expect(result.status, result.stderr).toBe(0)
    const report = JSON.parse(result.stdout.trim()) as {
      passed: boolean
      evidence: string
      original_checkouts_untouched: boolean
      status_and_diff_survived_restart: boolean
      branch_retained: boolean
    }
    expect(report).toMatchObject({
      passed: true,
      original_checkouts_untouched: true,
      status_and_diff_survived_restart: true,
      branch_retained: true,
    })
    expect(report.evidence.startsWith(resolve('.scratch') + '/')).toBe(true)
    rmSync(report.evidence, { recursive: true, force: true })
  },
  stage2AcceptanceDeadlineMs + processStepDeadlineMs
)
