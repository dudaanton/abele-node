import { cpSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
/** Copy the workspace's declared runtime assets without developer dependencies. */
export function copyWorkspaceRuntime(source, destination) {
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
  if (
    !Array.isArray(manifest.files) ||
    !manifest.files.includes('dist') ||
    manifest.files.some((file) => typeof file !== 'string' || !/^[A-Za-z0-9_-]+$/.test(file))
  )
    throw new Error('invalid_workspace_runtime_files')
  mkdirSync(destination, { recursive: true })
  cpSync(join(source, 'package.json'), join(destination, 'package.json'))
  for (const file of manifest.files)
    cpSync(join(source, file), join(destination, file), { recursive: true })
}
