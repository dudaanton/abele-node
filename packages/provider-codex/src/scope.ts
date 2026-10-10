import { mkdirSync, lstatSync, realpathSync, chmodSync, writeFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { isAbsolute, join, dirname, basename } from 'node:path'
import { newProcessMarker, validateProcessMarker } from './processes.js'
function rootFor(state: string) {
  if (!isAbsolute(state) || realpathSync(state) !== state)
    throw new Error('codex_unsafe_process_scope')
  const root = join(state, 'codex-runs')
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const stat = lstatSync(root)
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    realpathSync(root) !== root
  )
    throw new Error('codex_unsafe_process_scope')
  chmodSync(root, 0o700)
  return root
}
export function createProcessScope(state: string, runId: string) {
  const root = rootFor(state),
    directory = join(root, createHash('sha256').update(runId).digest('hex'))
  mkdirSync(directory, { mode: 0o700 })
  const marker = newProcessMarker()
  writeFileSync(join(directory, 'scope.json'), JSON.stringify({ version: 1, marker }) + '\n', {
    mode: 0o600,
    flag: 'wx',
  })
  return { directory, marker }
}
export function readProcessScope(state: string, directory: string) {
  const root = rootFor(state)
  if (
    dirname(directory) !== root ||
    !/^[a-f0-9]{64}$/.test(basename(directory)) ||
    realpathSync(directory) !== directory
  )
    throw new Error('codex_unsafe_process_scope')
  for (const path of [directory, join(directory, 'scope.json')]) {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
      throw new Error('codex_unsafe_process_scope')
  }
  const bytes = readFileSync(join(directory, 'scope.json'))
  if (bytes.length > 1024) throw new Error('codex_unsafe_process_scope')
  const value = JSON.parse(bytes.toString())
  if (value.version !== 1 || typeof value.marker !== 'string')
    throw new Error('codex_unsafe_process_scope')
  validateProcessMarker(value.marker)
  return value.marker as string
}
