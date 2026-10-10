import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildConfig,
  checkDefaults,
  checkRequirements,
  checkManagedFile,
  checkProfile,
  PROBE_METHODS,
} from './codex-stage0.mjs'

const paths = {
  home: '/probe/state/codex',
  workspace: '/probe/workspace',
  sibling: '/probe/sibling',
}
test('minimal runtime must not implicitly permit host temporary writes', () => {
  const config = buildConfig(paths)
  assert.match(config, /":minimal" = "read"/)
  assert.match(config, /"\/private\/tmp" = "deny"/)
  assert.match(config, /"\/private\/var\/tmp" = "deny"/)
  assert.match(config, /"\/probe\/state\/codex" = "deny"/)
  assert.match(config, /"\/probe\/workspace" = "write"/)
  assert.doesNotMatch(config, /"\/" = "(?:read|write)"/)
  assert.doesNotMatch(config, /sandbox_mode/)
})
test('an effective profile cannot add writable roots through merged configuration', () => {
  const profile = {
    workspace_roots: { [paths.workspace]: true },
    filesystem: {
      ':minimal': 'read',
      [paths.workspace]: 'write',
      [paths.home]: 'deny',
      [paths.sibling]: 'deny',
      '/probe/workspace/.git': 'read',
      '/probe/workspace/.codex': 'read',
      '/private/tmp': 'deny',
      '/private/var/tmp': 'deny',
    },
    network: { enabled: false },
  }
  checkProfile(profile, paths)
  profile.filesystem['/'] = 'write'
  assert.throws(() => checkProfile(profile, paths), /permission_profile_mismatch/)
})
test('managed requirements must be administered, not writable by the worker', () => {
  const safe = { uid: 0, mode: 0o100644, symlink: false }
  const parent = { uid: 0, mode: 0o40755, symlink: false }
  checkManagedFile(safe, parent)
  for (const unsafe of [
    { ...safe, uid: 501 },
    { ...safe, mode: 0o100666 },
    { ...safe, symlink: true },
  ])
    assert.throws(() => checkManagedFile(unsafe, parent), /unsafe_managed_requirements_file/)
  assert.throws(
    () => checkManagedFile(safe, { ...parent, mode: 0o40777 }),
    /unsafe_managed_requirements_file/
  )
})
test('requirements gate accepts only an explicit managed remote-control ban', () => {
  for (const requirements of [null, {}, { allowRemoteControl: true }])
    assert.throws(() => checkRequirements({ requirements }), /managed_remote_control_ban_missing/)
  checkRequirements({ requirements: { allowRemoteControl: false } })
})
test('defaults gate never treats absent values as disabled', () => {
  assert.throws(() => checkDefaults({}), /default_configuration_mismatch/)
  const config = {
    approval_policy: 'on-request',
    approvals_reviewer: 'user',
    web_search: 'disabled',
    allow_login_shell: false,
    check_for_update_on_startup: false,
    analytics: { enabled: false },
    feedback: { enabled: false },
    otel: {
      exporter: 'none',
      trace_exporter: 'none',
      metrics_exporter: 'none',
      log_user_prompt: false,
      log_agent_responses: false,
      log_guardian_assessments: false,
    },
    features: Object.fromEntries(
      [
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
      ].map((k) => [k, false])
    ),
    apps: { _default: { enabled: false } },
    memories: { generate_memories: false, use_memories: false },
    shell_environment_policy: { inherit: 'none' },
    mcp_servers: {},
    plugins: {},
  }
  checkDefaults(config)
  config.analytics.enabled = true
  assert.throws(() => checkDefaults(config), /analytics.enabled/)
})
test('no inference, authentication, or mutation RPCs belong to the probe allowlist', () => {
  for (const method of [
    'turn/start',
    'thread/start',
    'thread/resume',
    'account/read',
    'account/login/start',
    'config/value/write',
    'remoteControl/enable',
    'process/spawn',
    'fs/readFile',
  ])
    assert.equal(PROBE_METHODS.includes(method), false)
  assert.ok(PROBE_METHODS.includes('command/exec'))
})
test('probe refuses executable fallback before creating scratch state', async () => {
  const { spawnSync } = await import('node:child_process')
  const result = spawnSync(process.execPath, ['probes/codex-stage0.mjs'], {
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /explicit absolute executable/)
})
