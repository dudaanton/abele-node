// Explicit manual acceptance only: failed inference is not permission to replay
// a tool effect or uncertain delivery. Every attempted user prompt consumes budget.
export class PiAcceptanceBudget {
  turns = 0
  retries = 0
  beginTurn() {
    if (this.turns >= 6) throw Error('live turn budget exceeded')
    return ++this.turns
  }
  retry({ state, http_status, granted = false, tool_succeeded = false }) {
    if (
      state !== 'failed' ||
      !Number.isInteger(http_status) ||
      http_status < 500 ||
      http_status > 599 ||
      granted ||
      tool_succeeded ||
      this.retries >= 2 ||
      this.turns >= 6
    )
      return false
    this.retries++
    return true
  }
}
