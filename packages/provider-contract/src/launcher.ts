import { accessSync, constants, lstatSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'

/** Recover legacy installer paths only when a removed version target is missing.
 * Keep the launcher spelling: resolving its symlink here would freeze the next update too.
 * An explicit missing custom path or dangling launcher is not an invitation to search PATH.
 */
export function recoverProviderLauncher(requested: string, provider: 'claude' | 'codex'): string {
  if (!isAbsolute(requested)) return requested
  try {
    lstatSync(requested)
    return requested
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return requested
  }
  if (
    !requested.includes('/versions/') &&
    !(provider === 'codex' && requested.includes('/node_modules/@openai/codex/'))
  )
    return requested
  const candidates = [
    join(homedir(), `.local/bin/${provider}`),
    join(homedir(), `.${provider}/local/${provider}`),
    ...(process.env.PATH ?? '')
      .split(delimiter)
      .filter(isAbsolute)
      .map((root) => join(root, provider)),
    `/opt/homebrew/bin/${provider}`,
    `/usr/local/bin/${provider}`,
  ]
  for (const candidate of new Set(candidates)) {
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {}
  }
  return requested
}
