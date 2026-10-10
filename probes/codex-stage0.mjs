// Manual no-inference probe. Not a provider, doctor, or release acceptance.
import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile, realpath, symlink, lstat } from 'node:fs/promises'
import { isAbsolute, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { stopGroup } from './debug-runtime.mjs'

export const PROBE_METHODS = Object.freeze([
  'initialize',
  'config/read',
  'configRequirements/read',
  'experimentalFeature/list',
  'permissionProfile/list',
  'remoteControl/status/read',
  'command/exec',
])
const disabledFeatures = [
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
]
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
export function buildConfig({ home, workspace, sibling, repository }) {
  const q = JSON.stringify
  return `approval_policy = "on-request"
approvals_reviewer = "user"
web_search = "disabled"
allow_login_shell = false
check_for_update_on_startup = false
cli_auth_credentials_store = "file"
forced_login_method = "chatgpt"
sqlite_home = ${q(join(home, 'sqlite'))}
log_dir = ${q(join(home, 'logs'))}
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
in_app_browser = false
in_app_chat = false
in_app_dictation = false
in_app_local_automation = false
in_app_updates = false
browser_use_external = false
[memories]
generate_memories = false
use_memories = false
[shell_environment_policy]
inherit = "none"
[shell_environment_policy.set]
PATH = "/usr/bin:/bin:/usr/sbin:/sbin"
HOME = ${q(workspace)}
TMPDIR = ${q(join(workspace, 'tmp'))}
[history]
persistence = "none"
[apps._default]
enabled = false
[permissions.abele.workspace_roots]
${q(workspace)} = true
[permissions.abele.filesystem]
":minimal" = "read"
${q(workspace)} = "write"
${q(home)} = "deny"
${q(sibling)} = "deny"
${repository ? `${q(repository)} = "deny"\n` : ''}${q(join(workspace, '.git'))} = "read"
${q(join(workspace, '.codex'))} = "read"
"/private/tmp" = "deny"
"/private/var/tmp" = "deny"
[permissions.abele.network]
enabled = false
`
}
export function checkProfile(profile, { home, workspace, sibling, repository }) {
  const expected = {
    ':minimal': 'read',
    [workspace]: 'write',
    [home]: 'deny',
    [sibling]: 'deny',
    ...(repository ? { [repository]: 'deny' } : {}),
    [join(workspace, '.git')]: 'read',
    [join(workspace, '.codex')]: 'read',
    '/private/tmp': 'deny',
    '/private/var/tmp': 'deny',
  }
  if (
    !profile ||
    Object.keys(profile.workspace_roots ?? {}).length !== 1 ||
    profile.workspace_roots[workspace] !== true ||
    profile.network?.enabled !== false
  )
    throw new Error('permission_profile_mismatch')
  for (const [key, value] of Object.entries(expected))
    if (profile.filesystem?.[key] !== value) throw new Error('permission_profile_mismatch')
  if (
    Object.keys(profile.filesystem ?? {}).some(
      (k) => k !== 'glob_scan_max_depth' && !(k in expected)
    )
  )
    throw new Error('permission_profile_mismatch')
  if (Object.entries(profile.network).some(([k, v]) => k !== 'enabled' && v != null && v !== false))
    throw new Error('permission_profile_mismatch')
}
export function checkManagedFile(file, parent) {
  if ([file, parent].some((s) => s.uid !== 0 || (s.mode & 0o022) !== 0 || s.symlink))
    throw new Error('unsafe_managed_requirements_file')
  if ((file.mode & 0o170000) !== 0o100000 || (parent.mode & 0o170000) !== 0o040000)
    throw new Error('unsafe_managed_requirements_file')
}
export function checkRequirements(result) {
  if (result?.requirements?.allowRemoteControl !== false)
    throw new Error('managed_remote_control_ban_missing')
}
export function checkDefaults(config) {
  const expected = {
    approval_policy: 'on-request',
    approvals_reviewer: 'user',
    web_search: 'disabled',
    allow_login_shell: false,
    check_for_update_on_startup: false,
    'analytics.enabled': false,
    'feedback.enabled': false,
    'apps._default.enabled': false,
    'memories.generate_memories': false,
    'memories.use_memories': false,
    'shell_environment_policy.inherit': 'none',
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
  for (const [path, value] of Object.entries(expected)) {
    let actual = path.split('.').reduce((v, k) => v?.[k], config)
    if (path === 'features.multi_agent_v2' && actual?.enabled === false) actual = false
    if (actual !== value) throw new Error(`default_configuration_mismatch:${path}`)
  }
  for (const key of ['mcp_servers', 'plugins'])
    if (!config[key] || Object.keys(config[key]).length)
      throw new Error(`unexpected_resource:${key}`)
}
export function startRpc(binary, env, cwd, configArgs = []) {
  const child = spawn(
    binary,
    ['--strict-config', ...configArgs, '-C', cwd, 'app-server', '--listen', 'stdio://'],
    {
      env,
      cwd,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    }
  )
  child.exited = new Promise((resolve) => {
    child.once('close', resolve)
    child.once('error', resolve)
  })
  let pending = '',
    next = 0,
    output = 0,
    stopped = false
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const requests = new Map()
  const fail = (error) => {
    for (const slot of requests.values()) {
      clearTimeout(slot.timer)
      slot.reject(error)
    }
    requests.clear()
    if (!stopped) {
      stopped = true
      try {
        process.kill(-child.pid, 'SIGTERM')
      } catch {}
    }
  }
  // Diagnostics are deliberately neither persisted nor printed.
  child.stderr.on('data', (bytes) => {
    if ((output += bytes.length) > 2 * 1024 * 1024) fail(new Error('output_limit'))
  })
  child.on('error', () => fail(new Error('spawn_failed')))
  child.on('close', () => fail(new Error('transport_closed')))
  child.stdout.on('data', (bytes) => {
    try {
      output += bytes.length
      if (output > 2 * 1024 * 1024) throw new Error('output_limit')
      pending += decoder.decode(bytes, { stream: true })
      if (pending.length > 512 * 1024) throw new Error('frame_limit')
      let at
      while ((at = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, at)
        pending = pending.slice(at + 1)
        if (!line.trim()) throw new Error('empty_frame')
        const msg = JSON.parse(line)
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new Error('invalid_frame')
        if (msg.method && 'id' in msg) {
          child.stdin.write(
            JSON.stringify({
              id: msg.id,
              error: { code: -32601, message: 'Unsupported probe request' },
            }) + '\n'
          )
          continue
        }
        if (msg.method) continue
        const slot = requests.get(msg.id)
        if (!slot) throw new Error('unexpected_response')
        requests.delete(msg.id)
        clearTimeout(slot.timer)
        // Do not retain unbounded diagnostic/error payloads.
        if (msg.error) slot.resolve({ error: { code: msg.error.code } })
        else if ('result' in msg) slot.resolve(msg.result)
        else throw new Error('invalid_response')
      }
    } catch {
      fail(new Error('invalid_or_unbounded_rpc_stream'))
    }
  })
  const rpc = (method, params) => {
    if (!PROBE_METHODS.includes(method) || stopped) throw new Error('probe_method_forbidden')
    return new Promise((resolve, reject) => {
      const id = ++next
      const timer = setTimeout(() => fail(new Error(`rpc_timeout:${method}`)), 10000)
      requests.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n', (error) => {
        if (error) fail(new Error('write_failed'))
      })
    })
  }
  return {
    rpc,
    initialized: () => child.stdin.write('{"method":"initialized"}\n'),
    stop: async () => {
      fail(new Error('probe_stopped'))
      await stopGroup(child)
    },
  }
}
export function formatProbeReport(report, json = false) {
  if (json) return JSON.stringify(report, null, 2)
  return `Codex ${report.version}: measured checks passed; execution gate ${report.release_gate}.\n${report.checks.map((c) => `- ${c.name}: ${c.passed ? 'passed' : 'FAILED'}`).join('\n')}\nRemaining: ${report.unverified.join('; ')}.\nInference turns: ${report.inference_turns}.`
}
export async function probe(requestedBinary, { json = false } = {}) {
  if (!requestedBinary || !isAbsolute(requestedBinary))
    throw new Error('explicit absolute executable required')
  if (process.platform !== 'darwin') throw new Error('manual_probe_requires_macos')
  const binary = await realpath(requestedBinary)
  const policy = await lstat('/etc/codex/requirements.toml')
  const policyParent = await lstat('/etc/codex')
  checkManagedFile(
    { ...policy, symlink: policy.isSymbolicLink() },
    { ...policyParent, symlink: policyParent.isSymbolicLink() }
  )
  const repoRoot = await realpath(join(dirname(fileURLToPath(import.meta.url)), '..'))
  const scratch = join(repoRoot, '.scratch')
  await mkdir(scratch, { recursive: true, mode: 0o700 })
  if ((await realpath(scratch)) !== scratch) throw new Error('symlinked_scratch_forbidden')
  const root = await mkdtemp(join(scratch, 'codex-stage0-'))
  const paths = {
    home: join(root, 'home'),
    workspace: join(root, 'workspace'),
    sibling: join(root, 'sibling'),
    repository: join(root, 'repository'),
  }
  await mkdir(paths.home, { mode: 0o700 })
  const env = {
    HOME: paths.home,
    CODEX_HOME: paths.home,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    TMPDIR: join(paths.workspace, 'tmp'),
  }
  const run = (command, args) => {
    const r = spawnSync(command, args, {
      env,
      cwd: root,
      encoding: 'utf8',
      timeout: 15000,
      maxBuffer: 512 * 1024,
    })
    if (r.error || r.status !== 0) throw new Error('probe_subprocess_failed')
    return r.stdout
  }
  // Synthetic linked worktrees, never existing repositories or worktrees.
  run('/usr/bin/git', ['init', '-q', paths.repository])
  run('/usr/bin/git', [
    '-C',
    paths.repository,
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'user.name=Probe',
    '-c',
    'user.email=probe@example.invalid',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-qm',
    'probe',
  ])
  for (const path of [paths.workspace, paths.sibling])
    run('/usr/bin/git', [
      '-C',
      paths.repository,
      '-c',
      'core.hooksPath=/dev/null',
      'worktree',
      'add',
      '--detach',
      '-q',
      path,
    ])
  await mkdir(env.TMPDIR, { mode: 0o700 })
  await mkdir(join(paths.workspace, '.codex'), { mode: 0o700 })
  await writeFile(join(paths.home, 'config.toml'), buildConfig(paths), { mode: 0o600 })
  await writeFile(join(paths.home, 'secret.txt'), 'SYNTHETIC_NODE_SECRET', { mode: 0o600 })
  await writeFile(join(paths.sibling, 'secret.txt'), 'SYNTHETIC_SIBLING_SECRET', { mode: 0o600 })
  await symlink(paths.sibling, join(paths.workspace, 'sibling-link'))
  await symlink(paths.home, join(paths.workspace, 'home-link'))
  const version = run(binary, ['--version']).trim()
  if (version !== 'codex-cli 0.160.1') throw new Error('incompatible_version')
  if (!run(binary, ['app-server', '--help']).includes('--listen'))
    throw new Error('stdio_not_supported')
  const before = hash(await readFile(binary))
  for (const [flag, dir] of [
    [[], 'stable-schemas'],
    [['--experimental'], 'experimental-schemas'],
  ])
    run(binary, ['app-server', 'generate-ts', ...flag, '--out', join(root, dir)])
  const schemaFiles = [
    'ServerRequest.ts',
    'ServerNotification.ts',
    'v2/CommandExecutionRequestApprovalParams.ts',
  ]
  const schemaHashes = {}
  for (const dir of ['stable-schemas', 'experimental-schemas']) {
    schemaHashes[dir] = {}
    for (const file of schemaFiles)
      schemaHashes[dir][file] = hash(await readFile(join(root, dir, file)))
  }
  const pins = JSON.parse(
    await readFile(new URL('./fixtures/codex-0.160.1-pins.json', import.meta.url), 'utf8')
  )
  for (const [file, expected] of Object.entries(pins.stable_schema_sha256))
    if (schemaHashes['stable-schemas'][file] !== expected)
      throw new Error(`pinned_schema_mismatch:${file}`)
  const worker = startRpc(binary, env, paths.workspace)
  const results = []
  try {
    const init = await worker.rpc('initialize', {
      clientInfo: { name: 'abele-stage0', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    })
    if (init.codexHome !== paths.home) throw new Error('wrong_codex_home')
    worker.initialized()
    const requirements = await worker.rpc('configRequirements/read')
    checkRequirements(requirements)
    const cfg = await worker.rpc('config/read', { cwd: paths.workspace, includeLayers: true })
    checkDefaults(cfg.config)
    if (
      cfg.config.sqlite_home !== join(paths.home, 'sqlite') ||
      cfg.config.log_dir !== join(paths.home, 'logs')
    )
      throw new Error('state_path_mismatch')
    checkProfile(cfg.config.permissions?.abele, paths)
    const features = await worker.rpc('experimentalFeature/list', {
      limit: 200,
      cwd: paths.workspace,
    })
    for (const name of disabledFeatures) {
      if (!features.data?.some((f) => f.name === name && f.enabled === false))
        throw new Error(`feature_mismatch:${name}`)
    }
    const remote = await worker.rpc('remoteControl/status/read')
    if (remote.error?.code !== -32600) throw new Error('managed_remote_control_ban_not_enforced')
    const scenarios = [
      ['local-write', 'printf LOCAL_OK > local.txt; cat local.txt', true],
      ['sibling-write', `printf ESCAPE > '${paths.sibling}/escape.txt'`, false],
      ['symlink-write', 'printf ESCAPE > sibling-link/escape.txt', false],
      ['sibling-read', 'cat sibling-link/secret.txt', false],
      ['state-read', 'cat home-link/secret.txt', false],
      [
        'hardlink-read',
        `ln '${paths.sibling}/secret.txt' hardlinked-secret.txt && cat hardlinked-secret.txt`,
        false,
      ],
      ['git-pointer-write', 'printf ESCAPE > .git', false],
      ['git-common-write', `printf ESCAPE > '${paths.repository}/.git/config'`, false],
      ['policy-write', 'printf ESCAPE > .codex/config.toml', false],
      ['policy-rename', 'mv .codex .codex-backup', false],
    ]
    for (const [name, command, success] of scenarios) {
      const r = await worker.rpc('command/exec', {
        command: ['/bin/sh', '-c', command],
        cwd: paths.workspace,
        permissionProfile: 'abele',
        timeoutMs: 2000,
        outputBytesCap: 4096,
      })
      const passed = success
        ? r.exitCode === 0 && r.stdout === 'LOCAL_OK'
        : r.exitCode === 1 &&
          r.stdout === '' &&
          /Operation not permitted|Permission denied/.test(r.stderr ?? '')
      results.push({ name, passed, exit_code: r.exitCode })
      if (!passed) throw new Error(`confinement_probe_failed:${name}`)
    }
    if (before !== hash(await readFile(binary))) throw new Error('binary_changed')
  } finally {
    await worker.stop()
  }
  const report = {
    version,
    binary_sha256: before,
    schemas: schemaHashes,
    requirements: { remote_control: false, uid: policy.uid, mode: policy.mode & 0o777 },
    checks: results,
    inference_turns: 0,
    release_gate: 'incomplete',
    unverified: [
      'single-action approval dispatch against native tool execution',
      'built-in filesystem-reader confinement',
      'effective host-temp write denial',
      'restart/resume and cleanup crash windows',
    ],
    scratch: root,
  }
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  })
  console.log(formatProbeReport(report, json))
  return report
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2)
  probe(args.filter((arg) => arg !== '--json')[0], { json: args.includes('--json') })
    .then((report) => {
      if (report.release_gate !== 'complete') process.exitCode = 2
    })
    .catch((error) => {
      console.error(error.message)
      process.exitCode = 1
    })
}
