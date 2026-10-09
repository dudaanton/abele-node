export const processStepDeadlineMs: number
export const piAcceptanceDeadlineMs: number
export const stage2AcceptanceDeadlineMs: number
export function processScenarioDeadline(steps: number): number
export function withProcessDeadline<T>(
  work: () => T | Promise<T>,
  label: string,
  ms?: number
): Promise<T>
export function waitForProcessCondition<T>(
  check: () => T | Promise<T>,
  label: string,
  ms?: number
): Promise<NonNullable<T>>
