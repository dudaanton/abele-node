/** Diagnostics must never prevent transport settlement or owned process cleanup.
 * No request arguments or raw DAP traffic belong in these records. */
export function debuggerLog(message: string, details: () => object) {
  try {
    console.debug(`[debugger] ${message}`, details())
  } catch {
    // Snapshot storage or the log sink may already be unavailable during close.
  }
}
