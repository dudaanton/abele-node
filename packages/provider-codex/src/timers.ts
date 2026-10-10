/** Local deadline scheduler. Process I/O and cleanup watchdogs stay on real time. */
export interface DeadlineTimers {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
}
export const systemDeadlineTimers: DeadlineTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer),
}
