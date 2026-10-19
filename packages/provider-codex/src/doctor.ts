import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import {
  discoverCodex,
  CodexDiscoveryError,
  requireManagedFile,
  type CodexDiscoveryOptions,
  type CodexExecutable,
} from './discovery.js'
import { pinnedSchemas, verifySchemaDirectory } from './schema.js'
import { checkEffective, launchOverrides, type PolicyPaths } from './policy.js'
import { RpcPeer } from './rpc.js'
import { ensureCodexState, prepareCodexHome, resolveCodexHome, type CodexHome } from './home.js'
import { isCodexAuthenticated, codexLoginCommand, codexApiKeyLoginCommand } from './auth.js'
import { codexExecutionGates } from './gates.js'
import { exposedCodexModel, codexModelAvailable, validCodexCatalog } from './models.js'
import type { ProcessIdentity } from '@abele/provider-contract'
export interface CodexDoctorReport {
  provider: string
  provider_version?: string
  available: boolean
  diagnostic: string
  home?: string
  model?: string
  home_mode?: CodexHome['mode']
  login_command?: string
  api_key_login_command?: string
  checks?: Record<string, boolean>
  gates?: ReturnType<typeof codexExecutionGates>
}

export function generateAndVerifySchemas(executable: CodexExecutable, directory: string) {
  for (const experimental of [false, true]) {
    const out = join(directory, experimental ? 'experimental' : 'stable')
    const args = [
      'app-server',
      'generate-ts',
      ...(experimental ? ['--experimental'] : []),
      '--out',
      out,
    ]
    executable.recheck()
    const result = spawnSync(
      executable.interpreter ?? executable.executable,
      executable.interpreter ? [executable.executable, ...args] : args,
      {
        env: { PATH: dirname(process.execPath), HOME: directory, CODEX_HOME: directory },
        encoding: 'utf8',
        timeout: 10000,
        maxBuffer: 256 * 1024,
      }
    )
    if (result.status !== 0) throw new Error('codex_schema_generation_failed')
  }
  // Both closures must belong to one reviewed protocol. The handshake alone
  // cannot establish compatibility of approval and result contracts.
  const versions = executable.version === '0.160.1' ? ['0.160.1'] : ['0.162.1', '0.160.1']
  for (const version of versions) {
    try {
      for (const experimental of [false, true]) {
        verifySchemaDirectory(
          join(directory, experimental ? 'experimental' : 'stable'),
          pinnedSchemas(experimental, version)
        )
      }
      executable.recheck()
      return
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'codex_schema_fingerprint_mismatch')
        throw error
    }
  }
  throw new Error('codex_schema_fingerprint_mismatch')
}
export async function inspectCodex(
  executable: CodexExecutable,
  paths: PolicyPaths,
  processes: (p: ProcessIdentity[]) => void,
  model?: string
) {
  const peer = await RpcPeer.start({
    executable,
    cwd: paths.workspace,
    home: paths.home,
    isolated: paths.isolated,
    configArgs: launchOverrides(paths),
    processes,
  })
  try {
    const init = await peer.request('initialize', {
      clientInfo: { name: 'abele-node', version: '0.3.7' },
      capabilities: { experimentalApi: true },
    })
    if (init.codexHome !== paths.home) throw new Error('codex_home_mismatch')
    await peer.initialized()
    const requirements = await peer.request('configRequirements/read')
    const effective = await peer.request('config/read', {
      cwd: paths.workspace,
      includeLayers: true,
    })
    checkEffective(effective.config, requirements, paths)
    const account = await peer.request('account/read', { refreshToken: false })
    const authenticated = isCodexAuthenticated(account)
    const catalog = authenticated
      ? await peer.request('model/list', { includeHidden: false, limit: 100 })
      : undefined
    const selected = exposedCodexModel(effective.config, catalog, model)
    return {
      handshake: true,
      effective_policy: true,
      managed_remote_control: true,
      authenticated,
      model: selected ?? 'Codex default',
      ...(authenticated && !validCodexCatalog(catalog)
        ? { model_available: false }
        : selected
          ? { model_available: authenticated && codexModelAvailable(catalog, selected) }
          : {}),
    }
  } finally {
    await peer.close()
  }
}
export async function doctorCodex(
  options: CodexDiscoveryOptions & { stateDir: string; model?: string; home?: string },
  selection = resolveCodexHome(options.home),
  platform: string = process.platform
): Promise<CodexDoctorReport> {
  let version: string | undefined
  let directory: string | undefined
  let home = selection.home
  try {
    const executable = discoverCodex(options)
    version = executable.version
    requireManagedFile()
    ensureCodexState(options.stateDir)
    home = prepareCodexHome(selection)
    directory = mkdtempSync(join(realpathSync(options.stateDir), 'codex-doctor-'))
    const paths = {
      home,
      isolated: selection.mode === 'isolated',
      workspace: join(directory, 'workspace'),
      sibling: directory,
      state: options.stateDir,
    }
    mkdirSync(paths.workspace, { mode: 0o700 })
    generateAndVerifySchemas(executable, directory)
    const { model, ...checks } = await inspectCodex(executable, paths, () => {}, options.model)
    const gates = codexExecutionGates(platform, executable.version)
    const error =
      gates.find((g) => g.error)?.error ??
      (!checks.authenticated
        ? 'codex_authentication_required'
        : checks.model_available === false
          ? 'codex_selected_model_unavailable'
          : undefined)
    return {
      provider: 'codex',
      provider_version: executable.version,
      available: error === undefined,
      home,
      model,
      home_mode: selection.mode,
      ...(!checks.authenticated
        ? {
            login_command: codexLoginCommand(executable.executable, home, paths.isolated),
            ...(paths.isolated
              ? { api_key_login_command: codexApiKeyLoginCommand(executable.executable, home) }
              : {}),
          }
        : {}),
      checks,
      gates,
      diagnostic:
        error ??
        'Pinned executable, schemas, managed policy, authentication and exposed model checked without inference.',
    }
  } catch (error) {
    // Return only controlled error identifiers; never CLI diagnostics or authentication payloads.
    const message = error instanceof Error ? error.message : ''
    return {
      provider: 'codex',
      provider_version: error instanceof CodexDiscoveryError ? error.version : version,
      gates: version ? codexExecutionGates(platform, version) : undefined,
      available: false,
      home,
      model: options.model || 'Codex default',
      home_mode: selection.mode,
      diagnostic: /^[a-z_]+(?::[A-Za-z_.]+)?$/.test(message) ? message : 'codex_inspection_failed',
    }
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
}
