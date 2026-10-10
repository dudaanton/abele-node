import { spawnSync } from 'node:child_process'
import { accessSync, constants, lstatSync, readFileSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { delimiter, dirname, isAbsolute, join } from 'node:path'

export interface CodexDiscoveryOptions {
  executable?: string
  trustedPath?: string
  /** Explicit deterministic Node fixture, never passed by the production adapter or CLI. */
  fixture?: boolean
}
const digest = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex')
export function discoverCodex(options: CodexDiscoveryOptions = {}) {
  let requested = options.executable ?? process.env.ABELE_CODEX_PATH
  if (!requested) {
    for (const root of (options.trustedPath ?? process.env.PATH ?? '').split(delimiter)) {
      if (!isAbsolute(root)) continue
      try {
        accessSync(join(root, 'codex'), constants.X_OK)
        requested = join(root, 'codex')
        break
      } catch {}
    }
  }
  if (!requested || !isAbsolute(requested)) throw new Error('codex_absolute_executable_required')
  const executable = realpathSync(requested)
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
      realpathSync(requested!) !== executable ||
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
export type CodexExecutable = ReturnType<typeof discoverCodex>
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
  checkManagedRequirements(lstatSync(path), lstatSync(dirname(path)))
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
