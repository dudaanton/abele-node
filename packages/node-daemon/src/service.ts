import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  realpathSync,
  readlinkSync,
  statSync,
  lstatSync,
  copyFileSync,
  openSync,
  fsyncSync,
  closeSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { readRuntime } from './index.js'

export function recoverServiceTransition(runtime: string) {
  const root = dirname(runtime)
  if (!existsSync(join(root, '.installer-owned'))) return
  let serviceLock = false
  try {
    serviceLock = lstatSync(join(root, '.install-lock')).isSymbolicLink()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (!existsSync(join(root, '.service-transition')) && !serviceLock) return
  const result = spawnSync(
    process.execPath,
    [join(runtime, 'service-transition.mjs'), 'recover', root],
    { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 }
  )
  if (result.error || result.status !== 0)
    throw new Error(
      (
        result.stderr ||
        result.error?.message ||
        'Service transition recovery failed; retained journal needs inspection.'
      ).trim()
    )
}

export function stageServiceCandidate(runtime: string, candidate: string) {
  const requested = process.env.ABELE_SERVICE_TRANSITION
  if (!requested) return
  const directory = realpathSync(requested)
  const s = statSync(directory)
  if (
    directory !== join(realpathSync(dirname(runtime)), '.service-transition') ||
    s.uid !== process.getuid!() ||
    s.mode & 0o077
  )
    throw new Error('Unprotected service transition staging directory')
  const stage = join(directory, 'next-service')
  copyFileSync(candidate, stage)
  for (const p of [stage, directory]) {
    const fd = openSync(p, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
}

/** Status also runs during installer transactions, before config publication. */
export function installationMode(runtime: string, state: string): 'service' | 'foreground' {
  const root = dirname(runtime)
  const file = join(root, 'config.json')
  if (!existsSync(join(root, '.installer-owned')) || !existsSync(file)) return 'foreground'
  const config = JSON.parse(readFileSync(file, 'utf8')) as { state?: string; service?: number }
  return config.state === state && config.service === 1 ? 'service' : 'foreground'
}

/** The installer remains the single owner of service admission and recovery. */
export function installedService(runtime: string, state: string) {
  recoverServiceTransition(runtime)
  const root = dirname(runtime)
  if (!existsSync(join(root, '.installer-owned')) || !existsSync(join(root, 'config.json')))
    return undefined
  const config = JSON.parse(readFileSync(join(root, 'config.json'), 'utf8')) as {
    version: string
    prefix?: string
    state: string
    state_identity: string
    service: number
    service_file?: string
    service_sha256?: string
  }
  if (
    !/^\d+\.\d+\.\d+$/.test(config.version) ||
    readlinkSync(join(root, 'current')) !== config.version ||
    realpathSync(join(root, config.version)) !== realpathSync(runtime) ||
    (config.service !== 0 && config.service !== 1) ||
    config.state !== state ||
    realpathSync(state) !== state
  )
    throw new Error(
      'Installer configuration differs from this runtime/state; inspect the installation before changing its service.'
    )
  const identity = statSync(state, { bigint: true })
  if (!identity.isDirectory() || `${identity.dev}:${identity.ino}` !== config.state_identity)
    throw new Error(
      'Installed state identity changed or is unrecorded; nothing was stopped or changed.'
    )
  const prefix = config.prefix ?? dirname(dirname(root))
  if (
    !prefix.startsWith('/') ||
    !existsSync(join(prefix, 'share/abele-node')) ||
    realpathSync(join(prefix, 'share/abele-node')) !== realpathSync(root)
  )
    throw new Error('Installer prefix differs from this runtime; nothing was stopped or changed.')
  return { ...config, root, prefix }
}

export function serviceStatus(runtime: string, state: string) {
  const config = installedService(runtime, state)
  let ownership = config?.service === 1 ? 'missing' : 'none'
  if (config?.service_file && existsSync(config.service_file)) {
    const file = statSync(config.service_file)
    ownership =
      file.isFile() &&
      realpathSync(config.service_file) === config.service_file &&
      createHash('sha256').update(readFileSync(config.service_file)).digest('hex') ===
        config.service_sha256
        ? 'recorded'
        : 'modified'
  }
  return {
    mode: config?.service === 1 ? 'service' : 'foreground',
    managed: !!config,
    enabled: config?.service === 1,
    running: !!readRuntime(state),
    ownership,
    service_file: config?.service_file ?? null,
    state_dir: state,
  }
}

export async function changeService(runtime: string, state: string, action: string) {
  if (!['enable', 'disable'].includes(action))
    throw new Error('Usage: abele-node service enable|disable|status [--json]')
  const config = installedService(runtime, state)
  if (!config)
    throw new Error(
      'Service changes require a one-command installer deployment. For a source/manual deployment, use the documented manual service setup; nothing changed.'
    )
  const installer = join(runtime, 'install.sh')
  if (!existsSync(installer))
    throw new Error(
      'This runtime has no bundled service installer. Update to a release supporting service enable/disable first.'
    )
  const child = spawn(
    '/bin/sh',
    [installer, '--prefix', config.prefix, '--service-action', action],
    {
      detached: true, // Isolate the shell and mutation children from the caller's process group.
      // Services must use the same Node executable as this CLI, not shell discovery.
      env: { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )
  let stdout = '',
    stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    stdout = (stdout + chunk).slice(-4 * 1024 * 1024)
  })
  child.stderr.setEncoding('utf8').on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-4 * 1024 * 1024)
  })
  const status = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', resolve)
  })
  if (status !== 0) throw new Error((stderr || stdout || 'Service change failed.').trim())
  return serviceStatus(runtime, state)
}
