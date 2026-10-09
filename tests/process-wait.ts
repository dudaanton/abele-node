const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
/** A transient ps failure is unknown, never evidence that a process is gone. */
export async function waitForProcessGuarantee(check: () => boolean, ms = 15000) {
  const deadline = Date.now() + ms
  let unavailable: unknown
  while (Date.now() < deadline) {
    try {
      if (check()) return
      unavailable = undefined
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'process_probe_unavailable') throw error
      unavailable = error
    }
    await delay(50)
  }
  throw unavailable ?? new Error('process guarantee deadline')
}
