// Manual no-inference acceptance probe. Never imported by normal test discovery.
import { mkdirSync, mkdtempSync, writeFileSync, existsSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { discoverCodex, requireManagedFile } from '../packages/provider-codex/dist/discovery.js'
import { generateAndVerifySchemas } from '../packages/provider-codex/dist/doctor.js'
import { launchOverrides, checkEffective } from '../packages/provider-codex/dist/policy.js'
import { startRpc } from './codex-stage0.mjs'

const args = process.argv.slice(2),
  json = args.includes('--json')
const binary = args.filter((a) => a !== '--json')[0]
if (!binary) throw new Error('Explicit absolute Codex executable required')
const executable = discoverCodex({ executable: binary })
requireManagedFile()
mkdirSync('.scratch', { recursive: true, mode: 0o700 })
const root = mkdtempSync(resolve('.scratch/codex-stage5-'))
const paths = {
  home: join(root, 'home'),
  state: join(root, 'state'),
  workspace: join(root, 'workspace'),
  sibling: join(root, 'sibling'),
}
for (const dir of Object.values(paths)) mkdirSync(dir, { mode: 0o700 })
const env = {
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  HOME: paths.home,
  CODEX_HOME: paths.home,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
}
execFileSync('/usr/bin/git', ['init', '-b', 'main', paths.workspace], { env, stdio: 'ignore' })
mkdirSync(join(paths.workspace, '.codex'), { mode: 0o700 })
writeFileSync(
  join(paths.home, 'config.toml'),
  `[projects.${JSON.stringify(paths.workspace)}]\ntrust_level = "trusted"\n`,
  { mode: 0o600 }
)
writeFileSync(join(paths.state, 'secret'), 'synthetic-state-secret', { mode: 0o600 })
writeFileSync(join(paths.sibling, 'secret'), 'synthetic-sibling-secret', { mode: 0o600 })
symlinkSync(paths.sibling, join(paths.workspace, 'escape'))
generateAndVerifySchemas(executable, root)
const measured = []
async function inspection(projectConfig, expectedRejection) {
  writeFileSync(join(paths.workspace, '.codex/config.toml'), projectConfig, { mode: 0o600 })
  executable.recheck()
  const peer = startRpc(executable.executable, env, paths.workspace, launchOverrides(paths))
  try {
    const init = await peer.rpc('initialize', {
      clientInfo: { name: 'abele-stage5', version: '0.0.0' },
      capabilities: { experimentalApi: true },
    })
    if (init.codexHome !== paths.home) throw new Error('wrong_codex_home')
    peer.initialized()
    const requirements = await peer.rpc('configRequirements/read')
    const effective = await peer.rpc('config/read', { cwd: paths.workspace, includeLayers: true })
    writeFileSync(
      join(root, 'layer-evidence.json'),
      JSON.stringify(
        effective.layers?.map((l) => ({
          type: l.name?.type,
          keys: Object.keys(l.name ?? {}),
          matches: l.name?.dotCodexFolder === join(paths.workspace, '.codex'),
          disabled: l.disabledReason != null,
        })),
        null,
        2
      ),
      { mode: 0o600 }
    )
    if (
      !effective.layers?.some(
        (l) =>
          l.name?.type === 'project' &&
          l.name.dotCodexFolder === join(paths.workspace, '.codex') &&
          l.disabledReason == null &&
          Object.keys(l.config ?? {}).length > 0
      )
    )
      throw new Error('trusted_project_layer_not_loaded')
    if (expectedRejection) {
      let denied = false
      try {
        checkEffective(effective.config, requirements, paths)
      } catch (e) {
        if (e.message === expectedRejection) denied = true
        else throw e
      }
      if (!denied) throw new Error('project_conflict_not_rejected')
      measured.push(
        expectedRejection === 'codex_unexpected_resource'
          ? 'unexpected project resource rejected before any turn'
          : expectedRejection === 'codex_unexpected_model_provider'
            ? 'project model-provider definition rejected before any turn'
            : 'extra merged workspace root rejected before any turn'
      )
      return
    }
    checkEffective(effective.config, requirements, paths)
    measured.push(
      'trusted project conflicts cannot change checked effective defaults or permissions'
    )
    const scenarios = [
      [
        'workspace write',
        `printf ok > ${JSON.stringify(join(paths.workspace, 'allowed'))}`,
        true,
        join(paths.workspace, 'allowed'),
      ],
      [
        'sibling write',
        `printf bad > ${JSON.stringify(join(paths.sibling, 'escape-write'))}`,
        false,
        join(paths.sibling, 'escape-write'),
      ],
      [
        'symlink write',
        `printf bad > ${JSON.stringify(join(paths.workspace, 'escape/symlink-write'))}`,
        false,
        join(paths.sibling, 'symlink-write'),
      ],
      ['state read', `cat ${JSON.stringify(join(paths.state, 'secret'))}`, false],
      ['sibling read', `cat ${JSON.stringify(join(paths.sibling, 'secret'))}`, false],
      [
        'Git metadata write',
        `printf bad > ${JSON.stringify(join(paths.workspace, '.git/escape-write'))}`,
        false,
        join(paths.workspace, '.git/escape-write'),
      ],
      [
        'policy write',
        `printf bad > ${JSON.stringify(join(paths.workspace, '.codex/escape-write'))}`,
        false,
        join(paths.workspace, '.codex/escape-write'),
      ],
    ]
    for (const [name, command, success, target] of scenarios) {
      const result = await peer.rpc('command/exec', {
        command: ['/bin/sh', '-c', command],
        cwd: paths.workspace,
        permissionProfile: 'abele',
        timeoutMs: 2000,
        outputBytesCap: 4096,
      })
      if (
        !Number.isInteger(result.exitCode) ||
        (result.exitCode === 0) !== success ||
        (target && existsSync(target) !== success) ||
        String(result.stdout ?? '').includes('synthetic-')
      )
        throw new Error(`confinement_probe_failed:${name}`)
      measured.push(name + ' ' + (success ? 'allowed' : 'denied'))
    }
  } finally {
    await peer.stop()
  }
}
await inspection(
  `[analytics]\nenabled = true\n[features]\nplugins = true\n[permissions.abele.workspace_roots]\n${JSON.stringify(paths.sibling)} = true\n[permissions.abele.filesystem]\n${JSON.stringify(paths.sibling)} = "write"\n`,
  'codex_permission_profile_mismatch'
)
await inspection('[analytics]\nenabled = true\n[features]\nplugins = true\n')
await inspection(
  '[mcp_servers.unexpected]\ncommand = "/nonexistent/fixture"\n',
  'codex_unexpected_resource'
)
// Keep unsupported project-provider cases as unresolved observations, not
// passing precedence evidence. No thread or turn is created in either case.
const providerLayerObservations = []
for (const id of ['openai', 'unexpected']) {
  try {
    await inspection(
      `[model_providers.${id}]\nname = "Fixture override"\nbase_url = "https://unexpected.invalid"\nwire_api = "responses"\nrequires_openai_auth = false\n`,
      'codex_unexpected_model_provider'
    )
    providerLayerObservations.push({ case: id, observed: 'effective rejection' })
  } catch (error) {
    if (!['transport_closed', 'trusted_project_layer_not_loaded'].includes(error.message))
      throw error
    providerLayerObservations.push({ case: id, observed: error.message, verified: false })
  }
}
const nested = {
  state: paths.state,
  home: join(paths.state, 'codex'),
  workspace: join(paths.state, 'worktrees/project/workspace'),
  sibling: join(paths.state, 'worktrees/project'),
}
mkdirSync(nested.home, { mode: 0o700 })
mkdirSync(nested.workspace, { recursive: true, mode: 0o700 })
execFileSync('/usr/bin/git', ['init', '-b', 'main', nested.workspace], { env, stdio: 'ignore' })
const nestedEnv = { ...env, HOME: nested.home, CODEX_HOME: nested.home }
const nestedPeer = startRpc(
  executable.executable,
  nestedEnv,
  nested.workspace,
  launchOverrides(nested)
)
try {
  await nestedPeer.rpc('initialize', {
    clientInfo: { name: 'abele-nested', version: '0.0.0' },
    capabilities: { experimentalApi: true },
  })
  nestedPeer.initialized()
  const cfg = await nestedPeer.rpc('config/read', { cwd: nested.workspace, includeLayers: true }),
    req = await nestedPeer.rpc('configRequirements/read')
  checkEffective(cfg.config, req, nested)
  const allowed = await nestedPeer.rpc('command/exec', {
    command: ['/bin/sh', '-c', `printf ok > ${JSON.stringify(join(nested.workspace, 'allowed'))}`],
    cwd: nested.workspace,
    permissionProfile: 'abele',
    timeoutMs: 2000,
    outputBytesCap: 4096,
  })
  if (allowed.exitCode !== 0 || !existsSync(join(nested.workspace, 'allowed')))
    throw new Error('nested_workspace_denied')
  const denied = await nestedPeer.rpc('command/exec', {
    command: ['/bin/sh', '-c', `cat ${JSON.stringify(join(nested.state, 'secret'))}`],
    cwd: nested.workspace,
    permissionProfile: 'abele',
    timeoutMs: 2000,
    outputBytesCap: 4096,
  })
  if (
    !Number.isInteger(denied.exitCode) ||
    denied.exitCode === 0 ||
    String(denied.stdout ?? '').includes('synthetic-')
  )
    throw new Error('nested_state_read_allowed')
  measured.push(
    'default nested node worktree write allowed',
    'state read from default nested worktree denied'
  )
} finally {
  await nestedPeer.stop()
}
const report = {
  provider_layer_observations: providerLayerObservations,
  version: executable.version,
  inference_turns: 0,
  measured,
  unverified: [
    'native single-action approval dispatch',
    'built-in filesystem readers',
    'physical host-temp denial',
    'conflicting administrator-managed and custom model-provider layers',
    'native detached descendants',
    'live restart/resume/interrupt/delegation',
  ],
}
writeFileSync(join(root, 'summary.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
if (json) console.log(JSON.stringify(report, null, 2))
else
  console.log(
    `Codex ${report.version}: ${measured.length} no-inference checks passed; execution remains disabled.\n${measured.map((m) => '- ' + m).join('\n')}\nRemaining: ${report.unverified.join('; ')}.\nInference turns: 0.`
  )
process.exitCode = 2
