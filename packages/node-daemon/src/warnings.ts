// Install before importing SQLite. Keep Node's default printer and all other warnings.
const emit = process.emit.bind(process) as (event: string | symbol, ...args: unknown[]) => boolean
process.emit = ((event: string | symbol, ...args: unknown[]) => {
  const warning = args[0]
  if (
    event === 'warning' &&
    warning instanceof Error &&
    warning.name === 'ExperimentalWarning' &&
    warning.message === 'SQLite is an experimental feature and might change at any time'
  )
    return false
  return emit(event, ...args)
}) as typeof process.emit
