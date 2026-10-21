/** Run budgets exclude overlapping waits for owner decisions. */
type Scheduler = {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimeout(timer: ReturnType<typeof setTimeout>): void
  nowMs?(): number
}
export class ActiveDeadline {
  private remaining: number
  private started = Date.now()
  private waiting = 0
  private closed = false
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(
    ms: number,
    private expire: () => void,
    private scheduler?: Scheduler
  ) {
    this.remaining = ms
    this.arm()
  }
  private arm() {
    this.started = this.scheduler?.nowMs?.() ?? Date.now()
    this.timer = (this.scheduler?.setTimeout.bind(this.scheduler) ?? setTimeout)(() => {
      this.closed = true
      this.expire()
    }, this.remaining)
  }
  pause() {
    if (this.closed) return () => {}
    if (this.waiting++ === 0) {
      if (this.timer !== undefined)
        (this.scheduler?.clearTimeout.bind(this.scheduler) ?? clearTimeout)(this.timer)
      this.remaining = Math.max(
        0,
        this.remaining - ((this.scheduler?.nowMs?.() ?? Date.now()) - this.started)
      )
    }
    let resumed = false
    return () => {
      if (resumed || this.closed) return
      resumed = true
      if (--this.waiting === 0) this.arm()
    }
  }
  close() {
    this.closed = true
    if (this.timer !== undefined)
      (this.scheduler?.clearTimeout.bind(this.scheduler) ?? clearTimeout)(this.timer)
  }
}
