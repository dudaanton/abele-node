import type { DeadlineTimers } from '../packages/provider-codex/src/timers.js'

/** Advance only the budget under test, never child I/O or cleanup watchdogs. */
export class VirtualDeadlineTimers implements DeadlineTimers {
  now = 0
  private next = 0
  private tasks = new Map<ReturnType<typeof setTimeout>, { at: number; callback: () => void }>()
  setTimeout(callback: () => void, ms: number) {
    const timer = ++this.next as unknown as ReturnType<typeof setTimeout>
    this.tasks.set(timer, { at: this.now + ms, callback })
    return timer
  }
  clearTimeout(timer: ReturnType<typeof setTimeout>) {
    this.tasks.delete(timer)
  }
  get pending() {
    return this.tasks.size
  }
  advance(ms: number) {
    const end = this.now + ms
    for (;;) {
      const next = [...this.tasks].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next || next[1].at > end) break
      this.now = next[1].at
      this.tasks.delete(next[0])
      next[1].callback()
    }
    this.now = end
  }
}
