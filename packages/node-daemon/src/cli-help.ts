const valueOptions = new Set([
  '--state-dir',
  '--port',
  '--worktree-root',
  '--runtime-dir',
  '--installer-journal',
  '--paired-config',
  '--tailscale-path',
  '--pair-installation',
  '--node-name',
  '--claude-path',
  '--claude-profile',
  '--claude-budget',
  '--claude-deadline-ms',
  '--permission-ttl-ms',
  '--codex-path',
  '--codex-model',
  '--codex-home',
  '--pi-provider',
  '--pi-model',
  '--pi-agent-dir',
  '--pi-profile',
  '--pi-deadline-ms',
  '--pi-max-tokens',
  '--installation-id',
  '--fingerprint',
])
const switches = new Set([
  '--help',
  '-h',
  '--json',
  '--service-run',
  '--tailnet-policy-verified',
  '--debugger',
  '--codex',
  '--no-codex',
  '--no-paired-config',
  '--check',
  '--force',
  '--list',
])
const usage: Record<string, string> = {
  start:
    'start [--port PORT] [--worktree-root PATH]\nRuns in the foreground; Ctrl-C stops it. In a service deployment, starts/verifies the service instead.',
  stop: 'stop\nStops the selected daemon. For managed background service removal, use service disable.',
  status: 'status\nShows daemon health, providers and foreground/background mode.',
  doctor:
    'doctor\nChecks local runtime, provider and service prerequisites without model inference.',
  service:
    'service enable [--paired-config PATH | --no-paired-config] | disable | status\nEnable registers and starts the existing installer runtime; disable stops/unregisters it and retains state. No reinstall or download. Stop a foreground daemon with abele-node stop before enabling.\n--paired-config records a protected (owner-only, not a symlink) paired listener configuration for remote access and restarts the service with it; update and later enables keep it. --no-paired-config removes it.',
  install:
    'install\nDeprecated alias to service enable for installer deployments; retains recorded settings. Source deployments keep the legacy manual macOS runtime-copy path.',
  update:
    'update [--version X.Y.Z] [--check] [--force]\nUpdates an installer deployment while preserving its recorded service mode.',
  version: '--version | version\nPrints the package version.',
  token: 'token create LABEL | list | revoke INSTALLATION_ID',
  pair: 'pair [--node-name NAME] | invite LABEL | list | confirm INSTALLATION_ID FINGERPRINT | revoke INSTALLATION_ID | rotate | routes',
  'approve-pair': 'approve-pair [NAME] [--installation-id ID] [--fingerprint FULL] | --list',
  serve: 'serve enable --tailnet-policy-verified | disable',
  debugger: 'debugger install js',
  'recover-worktree-deletion': 'recover-worktree-deletion [OPERATION_ID] [INSTALLATION_ID]',
}
export function cliHelp(command?: string): string {
  const detail = command ? usage[command] : undefined
  if (command && !detail) throw new Error(`Unknown help command: ${command}. Run abele-node help.`)
  return [
    detail
      ? `Usage: abele-node ${detail}`
      : 'Usage: abele-node COMMAND [OPTIONS]\nCommands: start, stop, status, doctor, service, install, update, version, token, pair, approve-pair, serve, debugger, recover-worktree-deletion',
    'Background: abele-node service enable | service disable | service status',
    'Common options: --state-dir PATH, --json; use abele-node COMMAND --help for details.',
    'Provider/start options: --claude-path PATH, --codex-path PATH, --codex-model MODEL, --codex-home PATH, --no-codex, --pi-provider ID, --pi-model ID, --paired-config PATH.',
  ].join('\n')
}

/** Validate before reading configuration or contacting a daemon/service manager. */
export function requestedHelp(args: string[]): string | undefined {
  // Update owns a structured failure report, including invalid arguments.
  if (args[0] === 'update' && !args.includes('--help') && !args.includes('-h')) return undefined
  const words: string[] = []
  let help = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (valueOptions.has(arg) || (arg === '--version' && args.includes('update'))) {
      if (!args[i + 1] || args[i + 1]!.startsWith('--')) throw new Error(`missing_${arg}`)
      i++
    } else if (switches.has(arg) || arg === '--version') {
      if (arg === '--help' || arg === '-h') help = true
    } else if (arg.startsWith('-')) {
      throw new Error(
        `Unknown option: ${arg}. For background operation use abele-node service enable; run abele-node --help.`
      )
    } else words.push(arg)
  }
  if (words[0] === 'help') return cliHelp(words[1])
  if (help) return cliHelp(words[0])
  return undefined
}
