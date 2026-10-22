/** Keep optional owner-stop fields off older strict session/delegation readers.
 * Enforcement is unconditional; negotiation only changes the published copy. */
export function legacyOwnerStop(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(legacyOwnerStop)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  if (
    record.kind === 'response' &&
    record.result &&
    typeof record.result === 'object' &&
    (record.result as Record<string, unknown>).code === 'owner_restart_required'
  ) {
    const { result, ...response } = record
    return {
      ...response,
      error: {
        code: 'owner_restart_required',
        message: 'Stopped by the owner; an explicit owner restart is required.',
        details: result,
      },
    }
  }
  const resource =
    typeof record.session_id === 'string' &&
    (typeof record.provider === 'string' ||
      typeof record.process === 'string' ||
      typeof record.delegation_id === 'string')
  return Object.fromEntries(
    Object.entries(record)
      .filter(
        ([key, child]) =>
          !(
            resource &&
            (['stop_generation', 'owner_stopped', 'stop_reason'].includes(key) ||
              (key === 'reason' && child === 'stopped_by_owner'))
          )
      )
      .map(([key, child]) => [
        key,
        ['input', 'raw_input', 'raw_output', 'configuration'].includes(key)
          ? child
          : legacyOwnerStop(child),
      ])
  )
}
