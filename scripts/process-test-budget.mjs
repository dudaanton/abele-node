// Model-free process acceptance is about eventual completion, not cold-start
// throughput. One phase gets 30 s on a throttled runner. Scenario watchdogs are
// derived from phase counts and reserve a separate cleanup phase; unit tests keep
// Vitest's default. These are test-only budgets, not provider/product deadlines.
export const processStepDeadlineMs = 30_000
export const processScenarioDeadline = (steps) => (steps + 1) * processStepDeadlineMs
export const piAcceptanceDeadlineMs = processScenarioDeadline(8)
export const stage2AcceptanceDeadlineMs = processScenarioDeadline(6)

export async function withProcessDeadline(work, label, ms = processStepDeadlineMs) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`${label} deadline (${ms}ms)`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

// Poll only while evidence is absent. The watchdog also bounds a stalled async
// probe; a retry count (or a fixed settling sleep) cannot establish completion.
export function waitForProcessCondition(check, label, ms = processStepDeadlineMs) {
  return withProcessDeadline(
    async () => {
      const deadline = performance.now() + ms
      while (performance.now() < deadline) {
        const value = await check()
        if (value) return value
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw Error(`${label} deadline (${ms}ms)`)
    },
    label,
    ms
  )
}
