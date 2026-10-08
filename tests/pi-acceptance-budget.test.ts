import { it, expect } from 'vitest'
// @ts-expect-error manual acceptance helper is plain JS
import { PiAcceptanceBudget } from '../scripts/pi-acceptance-budget.mjs'
it('caps all attempted prompts at six and 5xx retries at two across the entire scenario', () => {
  const budget = new PiAcceptanceBudget()
  for (let i = 0; i < 2; i++) {
    budget.beginTurn()
    expect(budget.retry({ state: 'failed', http_status: 502 })).toBe(true)
  }
  budget.beginTurn()
  expect(budget.retry({ state: 'failed', http_status: 503 })).toBe(false)
  for (let i = 0; i < 3; i++) budget.beginTurn()
  expect(budget.turns).toBe(6)
  expect(() => budget.beginTurn()).toThrow(/budget/)
  expect(budget.turns).toBe(6)
})
it.each([
  { state: 'delivery_unknown', http_status: 502 },
  { state: 'failed', http_status: 401 },
  { state: 'failed', http_status: undefined },
  { state: 'failed', http_status: 502, granted: true },
  { state: 'failed', http_status: 503, tool_succeeded: true },
])(
  'never retries uncertain delivery, unclassified errors or granted/executed actions: %j',
  (failure) => {
    const budget = new PiAcceptanceBudget()
    budget.beginTurn()
    expect(budget.retry(failure)).toBe(false)
    expect(budget.retries).toBe(0)
  }
)
