import { spawnSync } from 'node:child_process'
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { delimiter, dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'

export interface CodexDiscoveryOptions {
  executable?: string
  trustedPath?: string
  /** Explicit deterministic Node fixture, never passed by the production adapter or CLI. */
  fixture?: boolean
}
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
// Resolve the official npm layout without running its JavaScript launcher.
// All other wrappers remain unsupported; the native target still passes every pin.
export function resolveCodexExecutable(requested: string): string {
  const entry = realpathSync(requested)
  if (readFileSync(entry).subarray(0, 2).toString() !== '#!') return entry
  try {
    const root = dirname(dirname(entry))
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    if (
      manifest.name !== '@openai/codex' ||
      manifest.version !== '0.160.1' ||
      entry !== join(root, 'bin/codex.js')
    )
      return entry
    const triple = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'darwin' ? 'apple-darwin' : 'unknown-linux-musl'}`
    const vendorRoots = [join(root, 'vendor')]
    const name = `@openai/codex-${process.platform}-${process.arch}`
    try {
      const file = createRequire(join(root, 'package.json')).resolve(`${name}/package.json`)
      const nativeManifest = JSON.parse(readFileSync(file, 'utf8'))
      if (nativeManifest.name === name && nativeManifest.version === '0.160.1')
        vendorRoots.unshift(join(dirname(file), 'vendor'))
    } catch {}
    for (const vendor of vendorRoots) {
      try {
        const native = realpathSync(join(vendor, triple, 'codex/codex'))
        accessSync(native, constants.X_OK)
        if (readFileSync(native).subarray(0, 2).toString() !== '#!') return native
      } catch {}
    }
  } catch {}
  return entry
}
export function discoverCodex(options: CodexDiscoveryOptions = {}): CodexExecutable {
  const requested = options.executable || process.env.ABELE_CODEX_PATH
  if (requested) return inspectExecutable(requested, options)
  const candidates = [
    join(homedir(), '.local/bin/codex'),
    join(homedir(), '.codex/local/codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    ...(options.trustedPath ?? process.env.PATH ?? '')
      .split(delimiter)
      .filter((root) => isAbsolute(root))
      .map((root) => join(root, 'codex')),
  ]
  let failure: unknown
  for (const candidate of new Set(candidates)) {
    try {
      accessSync(candidate, constants.X_OK)
    } catch {
      continue
    }
    try {
      return inspectExecutable(candidate, options)
    } catch (error) {
      failure ??= error
    }
  }
  throw failure ?? new Error('codex_executable_unavailable')
}
function inspectExecutable(requested: string, options: CodexDiscoveryOptions) {
  if (!isAbsolute(requested)) throw new Error('codex_absolute_executable_required')
  const executable = options.fixture ? realpathSync(requested) : resolveCodexExecutable(requested)
  accessSync(executable, constants.X_OK)
  const bytes = readFileSync(executable)
  // Opaque launchers cannot be fingerprinted transitively. Production accepts
  // native binaries; Node fixtures pin their interpreter explicitly.
  let interpreter: string | undefined
  if (bytes.subarray(0, 2).toString() === '#!') {
    if (!options.fixture) throw new Error('codex_opaque_wrapper_unsupported')
    const shebang = bytes.subarray(0, 256).toString().split('\n')[0]
    if (shebang !== '#!/usr/bin/env node' && shebang !== `#!${process.execPath}`)
      throw new Error('codex_opaque_wrapper_unsupported')
    interpreter = realpathSync(process.execPath)
  }
  const sha256 = digest(executable),
    interpreterHash = interpreter && digest(interpreter)
  const recheck = () => {
    if (
      (options.fixture ? realpathSync(requested) : resolveCodexExecutable(requested)) !==
        executable ||
      digest(executable) !== sha256 ||
      (interpreter && digest(interpreter) !== interpreterHash)
    )
      throw new Error('codex_executable_identity_changed')
  }
  const env = { PATH: dirname(process.execPath), HOME: '/nonexistent', CODEX_HOME: '/nonexistent' }
  const run = (args: string[]) =>
    spawnSync(interpreter ?? executable, interpreter ? [executable, ...args] : args, {
      env,
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 256 * 1024,
    })
  const version = run(['--version']),
    help = run(['app-server', '--help'])
  if (version.status !== 0 || version.stdout.trim() !== 'codex-cli 0.160.1')
    throw new Error('codex_version_unsupported')
  if (help.status !== 0 || !help.stdout.includes('stdio://'))
    throw new Error('codex_stdio_unsupported')
  recheck()
  return { executable, interpreter, sha256, version: '0.160.1', recheck }
}
export type CodexExecutable = ReturnType<typeof inspectExecutable>
interface FileEvidence {
  uid: number
  mode: number
  isSymbolicLink(): boolean
}
export function checkManagedRequirements(file: FileEvidence, parent: FileEvidence) {
  if (
    [file, parent].some((s) => s.uid !== 0 || (s.mode & 0o022) !== 0 || s.isSymbolicLink()) ||
    (file.mode & 0o170000) !== 0o100000 ||
    (parent.mode & 0o170000) !== 0o040000
  )
    throw new Error('unsafe_managed_requirements')
}
export function checkManagedAncestry(entries: FileEvidence[]) {
  if (
    entries.some(
      (s) =>
        s.uid !== 0 ||
        (!s.isSymbolicLink() && ((s.mode & 0o022) !== 0 || (s.mode & 0o170000) !== 0o040000))
    )
  )
    throw new Error('unsafe_managed_requirements')
}
export function requireManagedFile(path = '/etc/codex/requirements.toml') {
  try {
    checkManagedRequirements(lstatSync(path), lstatSync(dirname(path)))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error('codex_managed_requirements_missing')
    throw error
  }
  const entries: FileEvidence[] = []
  for (let root of [dirname(path), realpathSync(dirname(path))]) {
    for (;;) {
      entries.push(lstatSync(root))
      const parent = dirname(root)
      if (parent === root) break
      root = parent
    }
  }
  checkManagedAncestry(entries)
}
