/** Only explicit dependency absence at session startup is a setup warning. A missing
 * module file, failed extension tool, or an extension merely named node_modules is an error. */
export function missingPiDependencies(type: string, data: Record<string, unknown>): boolean {
  if (type !== 'pi.extension.error' || data.event !== 'session_start') return false
  if (data.code === 'missing_dependencies') return true
  if (typeof data.error !== 'string') return false
  const error = data.error.slice(0, 4096)
  return (
    /\bdependencies (?:are )?(?:missing|not installed)\b/i.test(error) ||
    /\bnode_modules (?:directory )?(?:is )?(?:missing|not found|not installed)\b/i.test(error) ||
    (/\bENOENT\b/.test(error) &&
      /\b(?:scandir|stat|access)\b.*[\\/]node_modules['"]?\s*$/i.test(error))
  )
}
