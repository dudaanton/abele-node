import { it } from 'vitest'
import { processScenarioDeadline } from '../scripts/process-test-budget.mjs'

/** Cold CLI/probe, worker, tool/bridge, then terminal evidence; cleanup is extra. */
export function processIt(name: string, work: () => void | Promise<void>, phases = 4) {
  return it(name, { timeout: processScenarioDeadline(phases) }, work)
}
