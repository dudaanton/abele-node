import { mkdirSync, lstatSync, realpathSync, existsSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

export interface DeveloperEnvironment {
  root: string
  nodeBin: string
  nodeRoot: string
  gitBin: string
  gitRoot: string
  ref: string | null
  network: boolean
}
export function missingDeveloperDependencies(workspace: string): boolean {
  if (existsSync(join(workspace, 'node_modules'))) return false
  try {
    const manifest = join(workspace, 'package.json'),
      stat = lstatSync(manifest)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 131072) return false
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    return ['dependencies', 'devDependencies', 'optionalDependencies'].some(
      (key) => pkg[key] && typeof pkg[key] === 'object' && Object.keys(pkg[key]).length > 0
    )
  } catch {
    return false
  }
}
/** Only empty tool state is exposed here, never the provider's authenticated home. */
export function prepareDeveloperEnvironment(
  state: string,
  workspace: string,
  network = false
): DeveloperEnvironment {
  if (realpathSync(state) !== state || realpathSync(workspace) !== workspace)
    throw new Error('codex_unsafe_developer_environment')
  const root = join(state, 'codex-tools', createHash('sha256').update(workspace).digest('hex'))
  for (const path of [
    join(state, 'codex-tools'),
    root,
    join(root, 'home'),
    join(root, 'cache'),
    join(root, 'tmp'),
  ]) {
    if (!existsSync(path)) mkdirSync(path, { mode: 0o700 })
    const st = lstatSync(path)
    if (
      !st.isDirectory() ||
      st.isSymbolicLink() ||
      st.uid !== process.getuid?.() ||
      st.mode & 0o077 ||
      realpathSync(path) !== path
    )
      throw new Error('codex_unsafe_developer_environment')
  }
  const nodeBin = dirname(realpathSync(process.execPath)),
    nodeRoot = dirname(nodeBin)
  if (nodeRoot === '/' || !existsSync(join(nodeBin, 'npm')))
    throw new Error('codex_node_toolchain_unavailable')
  const found =
    process.platform === 'darwin'
      ? spawnSync('/usr/bin/xcrun', ['--find', 'git'], { encoding: 'utf8', timeout: 5000 })
      : undefined
  const git = realpathSync(found?.status === 0 ? found.stdout.trim() : '/usr/bin/git')
  const gitBin = dirname(git),
    gitRoot = dirname(gitBin)
  if (gitRoot === '/') throw new Error('codex_git_binding_unavailable')
  const branch = spawnSync(git, ['symbolic-ref', '-q', 'HEAD'], {
    cwd: workspace,
    encoding: 'utf8',
    timeout: 5000,
    env: {
      PATH: '/usr/bin:/bin',
      HOME: join(root, 'home'),
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
    },
  })
  if (branch.status !== 0 && branch.status !== 1) throw new Error('codex_git_binding_unavailable')
  const ref = branch.stdout.trim()
  if (
    ref &&
    (!ref.startsWith('refs/heads/') ||
      ref.split('/').some((p) => !p || p === '.' || p === '..') ||
      /[\x00-\x20\\]/.test(ref))
  )
    throw new Error('codex_git_binding_unavailable')
  return { root, nodeBin, nodeRoot, gitBin, gitRoot, ref: ref || null, network }
}
