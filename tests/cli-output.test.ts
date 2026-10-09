import { it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { processScenarioDeadline, processStepDeadlineMs } from '../scripts/process-test-budget.mjs'

it.each(['--version', 'version'])(
  'prints the package version without the SQLite warning: %s',
  (arg) => {
    const result = spawnSync(process.execPath, ['packages/node-daemon/dist/cli.js', arg], {
      encoding: 'utf8',
      timeout: processStepDeadlineMs,
      killSignal: 'SIGKILL',
    })
    expect(result.status, result.error?.message ?? result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version)
    expect(result.stderr).toBe('')
  },
  processScenarioDeadline(1)
)

it(
  'preserves other experimental warnings and warnings with the same text but a different type',
  { timeout: processScenarioDeadline(1) },
  () => {
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
    await import('./packages/node-daemon/dist/warnings.js');
    await import('node:sqlite');
    process.emitWarning('other experiment', 'ExperimentalWarning');
    process.emitWarning('SQLite is an experimental feature and might change at any time', 'UserWarning');
  `,
      ],
      { encoding: 'utf8', timeout: processStepDeadlineMs, killSignal: 'SIGKILL' }
    )
    expect(result.status, result.error?.message ?? result.stderr).toBe(0)
    expect(result.stderr).toContain('ExperimentalWarning: other experiment')
    expect(result.stderr).toContain('UserWarning: SQLite is an experimental feature')
    expect(result.stderr).not.toContain('ExperimentalWarning: SQLite')
  }
)
