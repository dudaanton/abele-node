import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import {
  discoverCodex,
  requireManagedFile,
  type CodexDiscoveryOptions,
  type CodexExecutable,
} from './discovery.js'
import { pinnedSchemas, verifySchemaDirectory } from './schema.js'
import { checkEffective, launchOverrides, type PolicyPaths } from './policy.js'
import { RpcPeer } from './rpc.js'
import { ensureCodexHome } from './home.js'
import { codexExecutionGates, codexExecutionError } from './gates.js'
import type { ProcessIdentity } from '@abele/provider-contract'
export interface CodexDoctorReport {
  provider: string
  provider_version?: string
  available: boolean
  diagnostic: string
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
    verifySchemaDirectory(out, pinnedSchemas(experimental))
  }
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
    const authenticated = account?.account?.type === 'chatgpt'
    let modelAvailable = false
    if (authenticated && model) {
      const catalog = await peer.request('model/list', { includeHidden: false, limit: 100 })
      modelAvailable =
        Array.isArray(catalog?.data) &&
        catalog.data.length <= 100 &&
        catalog.data.some(
          (m: any) =>
            m.model === model &&
            m.hidden !== true &&
            m.supportedReasoningEfforts?.some((e: any) => e.reasoningEffort === 'low')
        )
    }
    return {
      handshake: true,
      effective_policy: true,
      managed_remote_control: true,
      authenticated,
      ...(model ? { model_available: modelAvailable } : {}),
    }
  } finally {
    await peer.close()
  }
}
export async function doctorCodex(
  options: CodexDiscoveryOptions & { stateDir: string; model?: string }
): Promise<CodexDoctorReport> {
  let directory: string | undefined
  try {
    const executable = discoverCodex(options)
    requireManagedFile()
    const home = ensureCodexHome(options.stateDir)
    directory = mkdtempSync(join(realpathSync(options.stateDir), 'codex-doctor-'))
    const paths = {
      home,
      workspace: join(directory, 'workspace'),
      sibling: directory,
      state: options.stateDir,
    }
    mkdirSync(paths.workspace, { mode: 0o700 })
    generateAndVerifySchemas(executable, directory)
    const checks = await inspectCodex(executable, paths, () => {}, options.model)
    const error =
      codexExecutionError() ??
      (!checks.authenticated
        ? 'codex_chatgpt_authentication_required'
        : !options.model
          ? 'codex_selected_model_required'
          : !checks.model_available
            ? 'codex_selected_model_unavailable'
            : undefined)
    return {
      provider: 'codex',
      provider_version: executable.version,
      available: error === undefined,
      checks,
      gates: codexExecutionGates(),
      diagnostic:
        error ??
        'Pinned executable, schemas, managed policy, authentication and selected model checked without inference.',
    }
  } catch (error) {
    // Return only controlled error identifiers; never CLI diagnostics or authentication payloads.
    const message = error instanceof Error ? error.message : ''
    return {
      provider: 'codex',
      available: false,
      diagnostic: /^[a-z_]+(?::[A-Za-z_.]+)?$/.test(message) ? message : 'codex_inspection_failed',
    }
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
}
