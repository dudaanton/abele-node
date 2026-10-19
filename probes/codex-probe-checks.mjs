// Pure assertions shared by manual probes. No executable discovery or inference.
export function assertReplayProgress(runId, events) {
  const failed = events.find(
    (event) =>
      ['run.failed', 'run.interrupted'].includes(event.type) && event.data?.run_id === runId
  )
  if (!failed) return
  const reason = /^[a-z_]+(:-?\d+)?$/.test(failed.data.reason ?? '')
    ? failed.data.reason
    : 'provider_failure'
  throw new Error(`native_replay_run_failed:${reason}`)
}

export function assertConfinementResult(name, result, success, targetExists) {
  if (result.error) {
    const code = Number.isInteger(result.error.code) ? result.error.code : 'unknown'
    throw new Error(`confinement_probe_rpc_failed:${name}:${code}`)
  }
  if (
    !Number.isInteger(result.exitCode) ||
    (result.exitCode === 0) !== success ||
    (targetExists !== undefined && targetExists !== success) ||
    String(result.stdout ?? '').includes('synthetic-')
  )
    throw new Error(`confinement_probe_failed:${name}`)
}

// An approved command must leave the denied structure in place: no chain directory
// moved or replaced, no effect outside the allowed area, no denied content in output.
export function assertChainIntact(name, { chainIntact, escapedPaths, output }) {
  if (!chainIntact) throw new Error(`chain_probe_failed:${name}:chain`)
  if (escapedPaths.length) throw new Error(`chain_probe_failed:${name}:effect`)
  if (String(output ?? '').includes('synthetic-'))
    throw new Error(`chain_probe_failed:${name}:leak`)
}
