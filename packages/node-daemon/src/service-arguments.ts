/** Preserve even unknown owner flags from the authenticated prior service. */
export function retainServiceArguments(
  generated: string[],
  previous: string,
  os: string,
  overrides: Record<string, string | boolean> = {}
): string[] {
  let args: string[]
  if (os === 'darwin') {
    const array = previous.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1]
    if (!array) throw new Error('unsupported_service_arguments')
    if (array.replace(/<string>[\s\S]*?<\/string>/g, '').trim())
      throw new Error('unsupported_service_arguments')
    args = [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) =>
      m[1]!
        .replaceAll('&quot;', '"')
        .replaceAll('&apos;', "'")
        .replaceAll('&gt;', '>')
        .replaceAll('&lt;', '<')
        .replaceAll('&amp;', '&')
    )
  } else {
    const command = previous.match(/^ExecStart=(.*)$/m)?.[1]
    const token = /"((?:\\.|[^"\\])*)"/g
    if (!command || command.replace(token, '').trim())
      throw new Error('unsupported_service_arguments')
    args = [...command.matchAll(token)].map((m) =>
      m[1]!
        .replace(/\\([\\"])/g, '$1')
        .replaceAll('%%', '%')
        .replaceAll('$$', '$')
    )
  }
  if (args[2] !== 'start' || !args[1]?.endsWith('/cli.js'))
    throw new Error('unsupported_service_arguments')
  const retained = args.slice(2)
  for (const [flag, value] of Object.entries(overrides)) {
    for (let i = retained.length - 1; i >= 0; i--)
      if (retained[i] === flag)
        retained.splice(i, ['--debugger', '--no-codex'].includes(flag) ? 1 : 2)
    if (value !== false) retained.push(flag, ...(value === true ? [] : [value]))
  }
  return [...generated.slice(0, 2), ...retained]
}
