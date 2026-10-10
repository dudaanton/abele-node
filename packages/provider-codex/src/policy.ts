import { join } from 'node:path'
import { createHash } from 'node:crypto'
export interface PolicyPaths {
  home: string
  workspace: string
  sibling: string
  repository?: string
  state: string
}
export const disabledFeatures = [
  'apps',
  'plugins',
  'remote_plugin',
  'plugin_hooks',
  'plugin_sharing',
  'hooks',
  'daemon_auto_start',
  'memories',
  'multi_agent',
  'multi_agent_v2',
  'browser_use',
  'computer_use',
  'in_app_browser',
  'in_app_chat',
  'in_app_dictation',
  'in_app_local_automation',
  'in_app_updates',
  'browser_use_external',
]
export function filesystem(p: PolicyPaths): Record<string, string> {
  return {
    ':minimal': 'read',
    [p.workspace]: 'write',
    [p.home]: 'deny',
    [p.sibling]: 'deny',
    [p.state]: 'deny',
    ...(p.repository ? { [p.repository]: 'deny' } : {}),
    [join(p.workspace, '.git')]: 'read',
    [join(p.workspace, '.codex')]: 'read',
    '/private/tmp': 'deny',
    '/private/var/tmp': 'deny',
  }
}
export function buildConfig(p: PolicyPaths) {
  const q = JSON.stringify
  return `approval_policy = "on-request"
approvals_reviewer = "user"
model_provider = "openai"
web_search = "disabled"
allow_login_shell = false
check_for_update_on_startup = false
cli_auth_credentials_store = "file"
forced_login_method = "chatgpt"
sqlite_home = ${q(join(p.home, 'sqlite'))}
log_dir = ${q(join(p.home, 'logs'))}
default_permissions = "abele"
[analytics]
enabled = false
[feedback]
enabled = false
[otel]
exporter = "none"
trace_exporter = "none"
metrics_exporter = "none"
log_user_prompt = false
log_agent_responses = false
log_guardian_assessments = false
[features]
${disabledFeatures.map((k) => `${k} = false`).join('\n')}
[memories]
generate_memories = false
use_memories = false
[shell_environment_policy]
inherit = "none"
[shell_environment_policy.set]
PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
HOME = ${q(p.workspace)}
TMPDIR = ${q(join(p.workspace, '.abele-tmp'))}
[history]
persistence = "none"
[apps._default]
enabled = false
[permissions.abele.workspace_roots]
${q(p.workspace)} = true
[permissions.abele.filesystem]
${Object.entries(filesystem(p))
  .map(([k, v]) => `${q(k)} = ${q(v)}`)
  .join('\n')}
[permissions.abele.network]
enabled = false
`
}
export function launchOverrides(p: PolicyPaths): string[] {
  let section = ''
  const args: string[] = []
  for (const line of buildConfig(p).trim().split('\n')) {
    if (line.startsWith('[')) {
      section = line.slice(1, -1)
      continue
    }
    const at = line.indexOf(' = ')
    if (at < 0) throw new Error('invalid_launch_policy')
    if (
      section === 'permissions.abele.filesystem' ||
      section === 'permissions.abele.workspace_roots'
    )
      continue
    args.push('-c', `${section ? section + '.' : ''}${line.slice(0, at)}=${line.slice(at + 3)}`)
  }
  const inline = (table: Record<string, unknown>) =>
    '{ ' +
    Object.entries(table)
      .map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`)
      .join(', ') +
    ' }'
  args.push(
    '-c',
    `permissions.abele.workspace_roots=${inline({ [p.workspace]: true })}`,
    '-c',
    `permissions.abele.filesystem=${inline(filesystem(p))}`
  )
  return args
}
export const policyFingerprint = (p: PolicyPaths) =>
  createHash('sha256').update(buildConfig(p)).digest('hex')
export function checkEffective(config: any, requirements: any, p: PolicyPaths) {
  if (requirements?.requirements?.allowRemoteControl !== false)
    throw new Error('managed_remote_control_ban_missing')
  const expected: Record<string, unknown> = {
    approval_policy: 'on-request',
    approvals_reviewer: 'user',
    model_provider: 'openai',
    web_search: 'disabled',
    allow_login_shell: false,
    check_for_update_on_startup: false,
    forced_login_method: 'chatgpt',
    default_permissions: 'abele',
    sqlite_home: join(p.home, 'sqlite'),
    log_dir: join(p.home, 'logs'),
    'analytics.enabled': false,
    'feedback.enabled': false,
    'apps._default.enabled': false,
    'memories.generate_memories': false,
    'memories.use_memories': false,
    'shell_environment_policy.inherit': 'none',
    'shell_environment_policy.set.PATH': '/usr/bin:/bin:/usr/sbin:/sbin',
    'shell_environment_policy.set.HOME': p.workspace,
    'shell_environment_policy.set.TMPDIR': join(p.workspace, '.abele-tmp'),
    ...Object.fromEntries(disabledFeatures.map((k) => [`features.${k}`, false])),
    ...Object.fromEntries(
      ['exporter', 'trace_exporter', 'metrics_exporter'].map((k) => [`otel.${k}`, 'none'])
    ),
    ...Object.fromEntries(
      ['log_user_prompt', 'log_agent_responses', 'log_guardian_assessments'].map((k) => [
        `otel.${k}`,
        false,
      ])
    ),
  }
  for (const [key, value] of Object.entries(expected)) {
    let actual = key.split('.').reduce((v: any, k) => v?.[k], config)
    if (key === 'features.multi_agent_v2' && actual?.enabled === false) actual = false
    if (actual !== value) throw new Error(`codex_effective_config_mismatch:${key}`)
  }
  for (const key of ['mcp_servers', 'plugins'])
    if (!config[key] || Object.keys(config[key]).length)
      throw new Error('codex_unexpected_resource')
  if (config.model_providers != null && Object.keys(config.model_providers).length)
    throw new Error('codex_unexpected_model_provider')
  const profile = config.permissions?.abele
  if (
    JSON.stringify(Object.entries(profile?.workspace_roots ?? {})) !==
      JSON.stringify([[p.workspace, true]]) ||
    profile?.network?.enabled !== false
  )
    throw new Error('codex_permission_profile_mismatch')
  const fs = profile.filesystem ?? {},
    expectedFs = filesystem(p)
  for (const [key, value] of Object.entries(expectedFs))
    if (fs[key] !== value) throw new Error('codex_permission_profile_mismatch')
  if (Object.keys(fs).some((k) => k !== 'glob_scan_max_depth' && !(k in expectedFs)))
    throw new Error('codex_permission_profile_mismatch')
  if (
    Object.keys(profile.network).some(
      (k) => k !== 'enabled' && profile.network[k] != null && profile.network[k] !== false
    )
  )
    throw new Error('codex_permission_profile_mismatch')
  if (config.sandbox_mode != null || config.sandbox_workspace_write != null)
    throw new Error('codex_competing_sandbox_configuration')
}
