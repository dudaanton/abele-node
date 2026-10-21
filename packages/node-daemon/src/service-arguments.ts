export const serviceFlagLimits: Record<string, number> = {
  '--allow-bypass': 0,
  '--permission-ttl-ms': 3600000,
  '--pi-deadline-ms': Number.MAX_SAFE_INTEGER,
  '--pi-max-tokens': Number.MAX_SAFE_INTEGER,
}

/** Human output uses the same defaults as daemon startup; JSON retains raw argv. */
export function summarizeServiceFlags(flags: string[]): string {
  const value = (flag: string, fallback: string) => {
    const index = flags.lastIndexOf(flag)
    return index < 0 ? fallback : (flags[index + 1] ?? fallback)
  }
  return [
    `Permission TTL: ${value('--permission-ttl-ms', '60000')} ms`,
    `Pi deadline: ${value('--pi-deadline-ms', '1800000')} ms`,
    `Pi max tokens: ${value('--pi-max-tokens', '32768')}`,
    `Debugger: ${flags.includes('--debugger') ? 'on' : 'off'}`,
    `Allow bypass: ${flags.includes('--claude-allow-bypass') ? 'on' : 'off'}`,
  ].join('\n')
}

export function validateServiceFlags(flags: Record<string, string>) {
  for (const [flag, value] of Object.entries(flags))
    if (flag === '--allow-bypass') {
      if (value !== 'on' && value !== 'off')
        throw new Error('Invalid --allow-bypass: use on or off.')
    } else if (
      !serviceFlagLimits[flag] ||
      !/^\d+$/.test(value) ||
      !Number.isSafeInteger(Number(value)) ||
      Number(value) < 1 ||
      Number(value) > serviceFlagLimits[flag]!
    )
      throw new Error(
        `Invalid service flag ${flag}: use a positive integer${flag === '--permission-ttl-ms' ? ' up to 3600000' : ''}.`
      )
}

export function readServiceArguments(previous: string, os: string): string[] {
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
  return args
}

/** Preserve even unknown owner flags from the authenticated prior service. */
export function retainServiceArguments(
  generated: string[],
  previous: string,
  os: string,
  overrides: Record<string, string | boolean> = {}
): string[] {
  const args = readServiceArguments(previous, os)
  const retained = args.slice(2)
  for (const [requested, setting] of Object.entries(overrides)) {
    const flag = requested === '--allow-bypass' ? '--claude-allow-bypass' : requested
    const value = requested === '--allow-bypass' ? setting === 'on' : setting
    for (let i = retained.length - 1; i >= 0; i--)
      if (retained[i] === flag)
        retained.splice(
          i,
          ['--debugger', '--no-codex', '--claude-allow-bypass'].includes(flag) ? 1 : 2
        )
    if (value !== false) retained.push(flag, ...(value === true ? [] : [value]))
  }
  return [...generated.slice(0, 2), ...retained]
}
