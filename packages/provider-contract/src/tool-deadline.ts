/** Bounded legacy workers exclude time awaiting an external Obsidian tool.
 * Normal owner approval clocks stay on their existing provider path. */
export class ToolWaitDeadline {
  private timer?: ReturnType<typeof setTimeout>
  private started = 0
  private waits = 0
  private stopped = false
  constructor(
    private remaining: number,
    private expire: () => void,
    private scheduler = {
      setTimeout: (callback: () => void, ms: number) => setTimeout(callback, ms),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    }
  ) {
    this.arm()
  }
  private arm() {
    if (this.stopped) return
    this.started = Date.now()
    this.timer = this.scheduler.setTimeout(
      () => {
        this.stopped = true
        this.timer = undefined
        this.expire()
      },
      Math.max(0, this.remaining)
    )
  }
  pause() {
    if (this.stopped) return () => {}
    if (this.waits++ === 0) {
      this.remaining -= Date.now() - this.started
      if (this.timer !== undefined) this.scheduler.clearTimeout(this.timer)
      this.timer = undefined
    }
    let resumed = false
    return () => {
      if (resumed) return
      resumed = true
      if (--this.waits === 0 && !this.stopped) this.arm()
    }
  }
  clear() {
    this.stopped = true
    if (this.timer !== undefined) this.scheduler.clearTimeout(this.timer)
    this.timer = undefined
  }
}
