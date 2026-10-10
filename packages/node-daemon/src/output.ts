// Keep presentation separate from the machine protocol: never mutate JSON reports.
type Report = Record<string, unknown>
const record = (value: unknown): Report =>
  value && typeof value === 'object' ? (value as Report) : {}
const line = (value: unknown) =>
  String(value ?? 'unknown')
    .replace(/\s+/g, ' ')
    .trim()
const shown = (value: unknown) => (value == null ? 'unknown' : line(value))
function provider(name: string, value: unknown) {
  const p = record(value)
  const model = line(p.model ?? record(p.configuration).model ?? 'Codex default')
  if (p.available === true)
    return `${name}: available (${shown(p.provider_version)})${name === 'Codex' ? `; model: ${model}` : ''}`
  if (name === 'Codex') {
    const diagnostic = line(p.diagnostic)
    if (
      diagnostic === 'codex_authentication_required' ||
      diagnostic === 'codex_chatgpt_authentication_required'
    )
      return `Codex: not logged in (model: ${model}) — run: ${line(p.login_command ?? 'codex login')}`
    if (diagnostic === 'codex_platform_confinement_uncertified')
      return `Codex: macOS required (model: ${model}) — run on macOS: abele-node doctor`
    const repairs: Record<string, [string, string]> = {
      codex_disabled: ['disabled', 'abele-node install --codex'],
      codex_executable_unavailable: ['not installed', 'npm install -g @openai/codex@0.160.1'],
      codex_version_unsupported: ['requires Codex 0.160.1', 'npm install -g @openai/codex@0.160.1'],
      codex_opaque_wrapper_unsupported: [
        'native executable required',
        'abele-node install --codex-path /absolute/path/to/native/codex',
      ],
      codex_absolute_executable_required: [
        'absolute executable path required',
        'abele-node install --codex-path /absolute/path/to/native/codex',
      ],
      codex_managed_requirements_missing: [
        'administrator requirements missing (set allow_remote_control = false)',
        'sudo install -d -o root -m 0755 /etc/codex && sudoedit /etc/codex/requirements.toml',
      ],
      managed_remote_control_ban_missing: [
        'administrator remote-control ban missing (set allow_remote_control = false)',
        'sudoedit /etc/codex/requirements.toml',
      ],
      unsafe_managed_requirements: [
        'administrator requirements ownership/permissions unsafe',
        'sudo chown root /etc/codex /etc/codex/requirements.toml && sudo chmod 0755 /etc/codex && sudo chmod 0644 /etc/codex/requirements.toml',
      ],
      codex_selected_model_unavailable: [
        'selected model not available for this account',
        'abele-node install --codex-model MODEL_ID',
      ],
      codex_preflight_required: ['preflight not checked', 'abele-node doctor'],
    }
    const [reason, command] = repairs[diagnostic] ?? [
      `preflight failed (${diagnostic})`,
      'abele-node doctor',
    ]
    return `Codex: ${reason} (model: ${model}) — run: ${command}`
  }
  const diagnostic = line(
    p.diagnostic ?? 'Provider diagnostics missing. Run abele-node doctor after restarting the node.'
  )
  const [reason, repair] = diagnostic
    .replace(/^Claude unavailable\/incompatible: /, '')
    .split(/\. Run /, 2)
  return `${name}: unavailable — ${repair ? `${reason}; fix: ${repair.split('. Real acceptance:')[0]}` : name === 'pi' ? `pinned SDK missing; fix: ${diagnostic}` : `${diagnostic}; fix: restart the node and run abele-node doctor`}`
}
function codexLoginLines(p: Report): string[] {
  const authenticated = record(p.checks).authenticated
  return [
    `Codex home: ${shown(p.home)} (${p.home_mode === 'isolated' ? 'isolated node home' : 'user home'})`,
    `Codex login: ${authenticated === true ? 'logged in' : authenticated === false ? 'not logged in' : 'not checked; resolve the provider diagnostic and run doctor again'}`,
    ...(authenticated === false && p.login_command ? [`Run: ${line(p.login_command)}`] : []),
    ...(authenticated === false && p.api_key_login_command
      ? [
          'Or set OPENAI_API_KEY in the daemon environment, or log in with an API key:',
          `Run: ${line(p.api_key_login_command)}`,
        ]
      : []),
  ]
}
function remote(value: Report) {
  const paired = record(value.paired),
    t = record(value.tailscale)
  if (!paired.endpoint) return 'Paired/remote: disabled (local only)'
  return `Paired/remote: ${line(paired.endpoint)}; ${t.node_mapping === true ? 'Serve mapping active' : 'Serve mapping unavailable; run abele-node doctor'}`
}
function checklist(ok: boolean, name: string, detail: string, fix: string) {
  return `${ok ? 'OK' : 'PROBLEM'} ${name}: ${detail}${ok ? '' : `; fix: ${fix}`}`
}
export function humanOutput(
  args: string[],
  value: unknown,
  context: { port?: number } = {}
): string {
  const r = record(value)
  switch (args[0]) {
    case 'status':
      return [
        `AbeleNode: ${r.running ? 'running' : 'not running'}`,
        `Version: ${shown(r.version ?? record(r.runtime).version)}`,
        `Port: ${shown(r.port)}`,
        `Node ID: ${r.node_id == null ? 'not created' : line(r.node_id)}`,
        provider('Claude', r.claude),
        provider('pi', r.pi),
        ...(r.codex ? [provider('Codex', r.codex)] : []),
        remote(r),
        `Projects: ${shown(r.projects)}; workspaces: ${shown(r.workspaces)}`,
      ].join('\n')
    case 'doctor': {
      const t = record(r.tailscale),
        paired = record(r.paired)
      const lines = [
        checklist(
          Number(line(r.node).replace(/^v/, '').split('.')[0]) >= 22,
          'Node',
          line(r.node),
          'install Node.js 22 or newer'
        ),
        checklist(
          !!r.sqlite,
          'Local storage',
          r.sqlite ? 'available' : 'unavailable',
          'reinstall AbeleNode with Node.js 22 or newer'
        ),
        checklist(
          r.state_mode === '700',
          'State directory',
          `${line(r.state_dir)} (${r.state_mode ?? 'not created'})`,
          r.state_mode == null
            ? 'run abele-node start to create protected state'
            : `chmod 700 "${line(r.state_dir)}"`
        ),
        checklist(
          r.running === true,
          'Daemon',
          r.running ? `running (${shown(record(r.runtime).version)})` : 'not running',
          'run abele-node start or start the installed service'
        ),
        // A foreground daemon does not require a LaunchAgent.
        `OK Service: ${r.launch_agent ? 'LaunchAgent installed' : 'no LaunchAgent; use foreground start or your service manager'}`,
        ...['Claude', 'pi', ...(r.codex ? ['Codex'] : [])].map((name) => {
          const p = record(r[name.toLowerCase()])
          return `${p.available === true ? 'OK' : 'PROBLEM'} ${provider(name, p)}`
        }),
        ...(r.codex ? codexLoginLines(record(r.codex)) : []),
        `${!paired.endpoint || t.node_mapping === true ? 'OK' : 'PROBLEM'} ${remote(r)}${paired.endpoint && t.node_mapping !== true ? '; fix: verify Tailscale prerequisites and enable Serve' : ''}`,
      ]
      if (paired.endpoint) {
        for (const [key, name, fix] of [
          [
            'present',
            'Tailscale',
            'install Tailscale and pass --tailscale-path /absolute/path/to/tailscale',
          ],
          ['logged_in', 'Tailnet login', 'run tailscale up'],
          ['magicdns', 'MagicDNS', 'enable MagicDNS in the Tailscale admin console'],
          ['https', 'HTTPS', 'enable HTTPS certificates in the Tailscale admin console'],
          [
            'endpoint_matches',
            'Paired endpoint',
            'set the paired endpoint hostname to this node’s Tailscale DNS name',
          ],
          [
            'node_mapping',
            'Serve mapping',
            'verify tailnet policy, then run abele-node serve enable --tailnet-policy-verified',
          ],
          [
            'policy_verified',
            'Tailnet policy',
            'verify the tailnet ACLs manually before enabling Serve',
          ],
        ])
          lines.push(
            checklist(
              t[key!] === true,
              name!,
              t[key!] === true ? 'ready' : 'unavailable or unverified',
              fix!
            )
          )
      }
      if (t.present === true || paired.endpoint)
        lines.push(
          checklist(
            t.local_token_unmapped === true,
            'Local token port',
            t.local_token_unmapped ? 'not exposed via Serve' : 'mapping safety unverified',
            'inspect tailscale serve status and remove any mapping to the local token port'
          )
        )
      // The legacy JSON flag describes application encryption, not the disk.
      // No volume-specific disk-encryption probe is performed by doctor.
      lines.push(
        'UNKNOWN Disk encryption: could not be determined; check FileVault or your operating system’s disk-encryption settings'
      )
      return lines.join('\n')
    }
    case 'update':
      return humanUpdate(r)
    case 'start':
      return `AbeleNode running on port ${shown(r.port)}; node ID ${shown(r.node_id)}${r.paired_port ? `; paired port ${line(r.paired_port)}` : ''}.`
    case 'stop':
      return r.stopping
        ? `Stopping AbeleNode (PID ${line(r.stopping)}).`
        : 'AbeleNode is not running.'
    case 'install':
      return `Installed LaunchAgent: ${line(r.installed)}\nRuntime: ${line(r.runtime)}`
    case 'token':
      if (args[1] === 'create')
        return [
          'Token created. Shown once; keep it only on this device, never in synced notes or settings.',
          'In Abele Settings → Nodes, add a local node:',
          'Label: any name you like',
          `URL: http://127.0.0.1:${context.port ?? 7777}`,
          `Installation token: ${line(r.token)}`,
          'Click Add node.',
        ].join('\n')
      if (args[1] === 'revoke') return `Revoked installation ${line(r.revoked)}.`
      return list(
        value,
        'No tokens.',
        (item) =>
          `${line(item.installation_id)} — ${line(item.label)} (${item.revoked ? 'revoked' : 'active'})`
      )
    case 'pair':
      if (args[1] === 'list')
        return list(
          value,
          'No paired devices.',
          (item) =>
            `${line(item.installation_id)} — ${line(item.state)}; fingerprint ${line(item.fingerprint)}`
        )
      if (args[1] === 'invite')
        return `Pairing invitation (expires ${new Date(Number(r.expires_at)).toISOString()}):\n${fields(r)}\nPaste these invitation fields into the Abele plugin’s remote node enrollment. Keep the secret private.`
      if (args[1] === 'revoke') return `Revoked paired installation ${line(r.revoked)}.`
      if (args[1] === 'rotate') return `Rotated node key: ${fields(record(r.node_key))}`
      return `Paired installation ${line(r.installation_id)}: ${line(r.state)}; fingerprint ${line(r.device_fingerprint)}.`
    case 'serve':
      return `Tailscale Serve ${args[1] === 'enable' ? 'enabled' : 'disabled'}.`
    default:
      return fields(r)
  }
}
function humanUpdate(r: Report): string {
  const agents = record(r.agents)
  const resumed = agents.admission_resumed ? ' Agent turns resumed.' : ''
  const next = `Next: ${line(r.next_step)}`
  switch (r.status) {
    case 'available':
    case 'checked':
    case 'up_to_date': {
      const lines = [
        `Current: ${shown(r.current)}`,
        `${r.target_kind === 'pinned' ? 'Target' : 'Latest'}: ${shown(r.target)}`,
        r.update_available
          ? 'Update available.'
          : 'No update available (installed version is equal or newer).',
      ]
      if (r.status !== 'available') lines.push(next)
      return lines.join('\n')
    }
    case 'paused': {
      const runs = Array.isArray(agents.active_runs) ? agents.active_runs : []
      const detail = runs
        .map((run) => {
          const value = record(run)
          return `${line(value.run_id)} (session ${line(value.session_id)})`
        })
        .join(', ')
      return runs.length
        ? `Agent turns paused; waiting for the installer to stop running agents (--force): ${detail}.`
        : r.service
          ? 'Agent turns paused; waiting for installer verification and service stop/restart.'
          : 'Agent turns paused; waiting for installer verification and deployment.'
    }
    case 'warning':
      return `Warning: ${Array.isArray(r.warnings) ? line(r.warnings.at(-1)) : 'installer verification unavailable'}`
    case 'updated':
      return `Updated to ${shown(r.target)} (from ${shown(r.current)}).${resumed}\n${next}`
    case 'source':
      return `This is a source/manual installation. ${next}`
    case 'interrupted':
      return `${line(r.error)}${resumed}\n${next}`
    case 'failed':
      return `Update failed: ${line(r.error)}${resumed}\n${next}`
    default:
      return `Checking for an AbeleNode update.\n${next}`
  }
}
function fields(value: Report): string {
  return Object.entries(value)
    .map(
      ([key, item]) =>
        `${key.replaceAll('_', ' ')}: ${item && typeof item === 'object' ? fields(record(item)) : line(item)}`
    )
    .join('\n')
}
function list(value: unknown, empty: string, format: (item: Report) => string) {
  return Array.isArray(value) && value.length
    ? value.map((item) => format(record(item))).join('\n')
    : empty
}
export function humanError(error: unknown) {
  const message = line(error instanceof Error ? error.message : error)
  const launchFailures: Record<string, string> = {
    launch_agent_stop_unconfirmed:
      'Could not confirm that the AbeleNode service and its daemon stopped',
    launch_agent_load_unconfirmed: 'Could not confirm that the AbeleNode service loaded',
    launch_agent_start_unconfirmed: 'Could not confirm that the AbeleNode service started',
    launch_agent_state_unconfirmed: 'Could not confirm the AbeleNode service state',
  }
  const launchCode = message.split(':', 1)[0]!
  if (Object.hasOwn(launchFailures, launchCode))
    return `${launchFailures[launchCode]}. (${launchCode})`
  if (message.startsWith('missing_--'))
    return `Provide a value for ${message.slice(8)}. (missing_option)`
  if (record(error).name === 'ZodError')
    return 'The configuration is invalid; check the supplied options and paired configuration. (invalid_configuration)'
  const code = /^[a-z][a-z0-9_]+$/.test(message)
    ? message
    : message.startsWith('Usage:')
      ? 'invalid_command'
      : line(record(error).code ?? 'command_failed')
  const explanation = message.startsWith('Usage:')
    ? message
    : /^[a-z][a-z0-9_]+$/.test(message)
      ? `Could not complete the command: ${message.replaceAll('_', ' ')}`
      : `Could not complete the command: ${message}`
  return `${explanation.replace(/[.!]+$/, '')}. (${code})`
}
