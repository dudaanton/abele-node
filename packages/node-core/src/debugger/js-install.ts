import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import {
  mkdir,
  mkdtemp,
  lstat,
  readFile,
  writeFile,
  rename,
  rm,
  realpath,
  readdir,
} from 'node:fs/promises'
import { join, dirname, resolve } from 'node:path'

export type JsAdapterPin = { version: string; sha256: string; license: 'MIT'; url: string }
/** Audit evidence behind the pin below. Never consult the B0 opt-in. */
export const JS_DEBUG_AUDIT = Object.freeze({
  checked_at: '2026-10-10',
  candidate: {
    version: '1.140.0',
    sha256: '27dab92937ec1ab35821ae955aac867544fe06a1b6307229049f2d789af10968',
    license: 'MIT',
  },
  production_findings: { high: 4, critical: 1 },
  advisories: [
    'GHSA-q2hr-2g5m-vwhr',
    'GHSA-qhr7-859c-m2p7',
    'GHSA-6j4f-fj2g-mc7p',
    'GHSA-vfj7-8cjw-p6xm',
    'GHSA-ch52-4w7c-c8xp',
    'GHSA-pqg4-j6r4-53mv',
  ],
})
// The owner accepted 1.140.0 despite the advisories above, on 2026-10-14: the node
// attaches over loopback with a fixed configuration and refuses terminal launches.
// A new version is a new decision, never a substituted number.
export const JS_DEBUG_PIN: JsAdapterPin | null = Object.freeze({
  version: '1.140.0',
  sha256: '27dab92937ec1ab35821ae955aac867544fe06a1b6307229049f2d789af10968',
  license: 'MIT',
  url: 'https://github.com/microsoft/vscode-js-debug/releases/download/v1.140.0/js-debug-dap-v1.140.0.tar.gz',
})
export function requireJsPin(): JsAdapterPin {
  if (!JS_DEBUG_PIN) throw new Error('js_debug_no_audited_release')
  return JS_DEBUG_PIN
}
type Installation = JsAdapterPin & { files: Record<string, string> }
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const MAX_ARCHIVE = 32 * 1024 * 1024
const MAX_UNPACKED = 64 * 1024 * 1024
function validPin(pin: JsAdapterPin) {
  if (
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[a-z0-9-]+)?$/.test(pin.version) ||
    !/^[a-f0-9]{64}$/.test(pin.sha256) ||
    pin.license !== 'MIT'
  )
    throw new Error('adapter_invalid_pin')
}
/** Reviewed tar subset: regular files/directories only; no links, device nodes,
 * PAX/GNU extensions, duplicate names, traversal, or installer scripts. */
function archiveFiles(archive: Buffer): Map<string, Buffer> {
  if (archive.length > MAX_ARCHIVE) throw new Error('adapter_archive_limit')
  let bytes: Buffer
  try {
    bytes = gunzipSync(archive, { maxOutputLength: MAX_UNPACKED })
  } catch {
    throw new Error('adapter_archive')
  }
  const files = new Map<string, Buffer>(),
    names = new Set<string>()
  const text = (header: Buffer, start: number, length: number) =>
    header
      .subarray(start, start + length)
      .toString('utf8')
      .split('\0')[0]!
  for (let offset = 0; offset < bytes.length;) {
    const header = bytes.subarray(offset, offset + 512)
    if (header.length !== 512) throw new Error('adapter_archive')
    if (header.every((b) => b === 0)) {
      if (!bytes.subarray(offset).every((b) => b === 0)) throw new Error('adapter_archive')
      break
    }
    const stored = text(header, 148, 8).trim()
    const checksum = [...header].reduce((sum, b, i) => sum + (i >= 148 && i < 156 ? 32 : b), 0)
    if (!/^[0-7]+$/.test(stored) || Number.parseInt(stored, 8) !== checksum)
      throw new Error('adapter_archive')
    const prefix = text(header, 345, 155),
      name = (prefix ? prefix + '/' : '') + text(header, 0, 100)
    const type = String.fromCharCode(header[156]!),
      sizeText = text(header, 124, 12).trim()
    if (!/^[0-7]+$/.test(sizeText)) throw new Error('adapter_archive')
    const size = Number.parseInt(sizeText, 8)
    if (
      !Number.isSafeInteger(size) ||
      size > MAX_UNPACKED ||
      offset + 512 + size > bytes.length ||
      names.size >= 1024
    )
      throw new Error('adapter_archive')
    if (
      !name.startsWith('js-debug/') ||
      name.includes('\\') ||
      name.split('/').some((part) => part === '..' || part === '.') ||
      name.includes('\ufffd') ||
      names.has(name)
    )
      throw new Error('adapter_archive')
    names.add(name)
    if (type === '5') {
      if (size !== 0) throw new Error('adapter_archive')
    } else if (type === '0' || type === '\0') {
      const relative = name.slice('js-debug/'.length)
      if (
        !relative ||
        relative.endsWith('/') ||
        relative.includes('//') ||
        relative.split('/').some((part) => !part)
      )
        throw new Error('adapter_archive')
      files.set(relative, bytes.subarray(offset + 512, offset + 512 + size))
    } else throw new Error('adapter_archive')
    offset += 512 + Math.ceil(size / 512) * 512
  }
  if (
    !files.has('src/dapDebugServer.js') ||
    !files.has('LICENSE') ||
    !files.get('LICENSE')!.toString('utf8').includes('MIT License')
  )
    throw new Error('adapter_archive_license')
  return files
}
/** Internal installer primitive, exercised with synthetic archives. The CLI never
 * accepts arbitrary pins or a dependency-audit override. */
export async function unpackJsAdapter(
  destination: string,
  pin: JsAdapterPin,
  archive: Buffer
): Promise<Installation> {
  validPin(pin)
  if (sha256(archive) !== pin.sha256) throw new Error('adapter_checksum')
  const files = archiveFiles(archive)
  if (files.has('installation.json') || files.has('archive.tar.gz'))
    throw new Error('adapter_archive')
  // Official bundle is CommonJS; never inherit the host project's module boundary.
  files.set('package.json', Buffer.from('{"private":true,"type":"commonjs"}\n'))
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
  try {
    await lstat(destination)
    throw new Error('adapter_already_installed')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const staging = await mkdtemp(join(dirname(destination), '.js-debug-install-'))
  try {
    const installation: Installation = { ...pin, files: {} }
    for (const [path, bytes] of files) {
      await mkdir(dirname(join(staging, path)), { recursive: true, mode: 0o700 })
      await writeFile(join(staging, path), bytes, { mode: 0o600, flag: 'wx' })
      installation.files[path] = sha256(bytes)
    }
    await writeFile(join(staging, 'installation.json'), JSON.stringify(installation), {
      mode: 0o600,
      flag: 'wx',
    })
    await writeFile(join(staging, 'archive.tar.gz'), archive, { mode: 0o600, flag: 'wx' })
    await rename(staging, destination)
    return installation
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}
export async function installJsAdapter(stateDirectory: string) {
  const pin = requireJsPin() // Before fetching or touching the filesystem.
  if (!['darwin', 'linux'].includes(process.platform)) throw new Error('unsupported_debugger_host')
  const response = await fetch(pin.url, { signal: AbortSignal.timeout(30000), redirect: 'follow' })
  if (!response.ok || !response.body || !response.url.startsWith('https://'))
    throw new Error('adapter_download_failed')
  const chunks: Buffer[] = []
  let size = 0
  const reader = response.body.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_ARCHIVE) throw new Error('adapter_archive_limit')
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel()
  }
  return unpackJsAdapter(jsAdapterDirectory(stateDirectory), pin, Buffer.concat(chunks))
}
export function jsAdapterDirectory(stateDirectory: string) {
  return join(stateDirectory, 'debugger/adapters/js-debug', requireJsPin().version)
}
/** Whether the pinned adapter was installed here; its bytes are verified on use. */
export function jsAdapterInstalled(stateDirectory: string) {
  try {
    return existsSync(join(jsAdapterDirectory(stateDirectory), 'installation.json'))
  } catch {
    return false
  }
}
export async function installedJsAdapter(stateDirectory: string) {
  const pin = requireJsPin()
  if (!jsAdapterInstalled(stateDirectory)) throw new Error('js_debug_not_installed')
  return verifyJsInstallation(jsAdapterDirectory(stateDirectory), pin)
}
export async function verifyJsInstallation(directory: string, pin: JsAdapterPin) {
  validPin(pin)
  const archivePath = join(directory, 'archive.tar.gz')
  if ((await lstat(archivePath)).size > MAX_ARCHIVE) throw new Error('adapter_install_mismatch')
  const archive = await readFile(archivePath)
  if (sha256(archive) !== pin.sha256) throw new Error('adapter_install_mismatch')
  const expectedFiles = archiveFiles(archive)
  expectedFiles.set('package.json', Buffer.from('{"private":true,"type":"commonjs"}\n'))
  const installation = JSON.parse(
    await readFile(join(directory, 'installation.json'), 'utf8')
  ) as Installation
  if (
    installation.version !== pin.version ||
    installation.sha256 !== pin.sha256 ||
    installation.license !== pin.license ||
    !installation.files ||
    typeof installation.files !== 'object'
  )
    throw new Error('adapter_install_mismatch')
  const entries = [...expectedFiles].map(([path, bytes]) => [path, sha256(bytes)] as const)
  if (
    Object.keys(installation.files).length !== entries.length ||
    entries.some(([path, hash]) => installation.files[path] !== hash)
  )
    throw new Error('adapter_install_mismatch')
  const expectedPaths = new Set([...expectedFiles.keys(), 'archive.tar.gz', 'installation.json'])
  const visit = async (relativePath: string) => {
    for (const entry of await readdir(join(directory, relativePath), { withFileTypes: true })) {
      const path = relativePath ? relativePath + '/' + entry.name : entry.name
      if (entry.isSymbolicLink()) throw new Error('adapter_install_mismatch')
      if (entry.isDirectory()) await visit(path)
      else if (!entry.isFile() || !expectedPaths.has(path))
        throw new Error('adapter_install_mismatch')
    }
  }
  await visit('')
  const physical = await realpath(directory)
  for (const [path, expected] of entries) {
    const absolute = resolve(directory, path)
    if (
      !absolute.startsWith(resolve(directory) + '/') ||
      (await realpath(absolute)) !== join(physical, path) ||
      sha256(await readFile(absolute)) !== expected
    )
      throw new Error('adapter_install_mismatch')
  }
  return { ...installation, entry: join(directory, 'src/dapDebugServer.js') }
}
