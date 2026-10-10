import { mkdirSync, chmodSync, realpathSync, lstatSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'

export interface CodexHome {
  home: string
  mode: 'inherited' | 'isolated'
}
export function resolveCodexHome(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
  userHome = homedir()
): CodexHome {
  const isolated = explicit || env.ABELE_CODEX_HOME
  return {
    home: resolve(isolated || env.CODEX_HOME || join(userHome, '.codex')),
    mode: isolated ? 'isolated' : 'inherited',
  }
}
export function ensureCodexState(stateDir: string) {
  if (!isAbsolute(stateDir)) throw new Error('codex_unsafe_home')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  if (realpathSync(stateDir) !== stateDir || lstatSync(stateDir).uid !== process.getuid?.())
    throw new Error('codex_unsafe_home')
}
export function prepareCodexHome(selection: CodexHome): string {
  if (selection.mode === 'isolated') return ensureCodexHome(selection.home)
  // Codex owns the user's configuration and credential storage. Do not read or
  // rewrite those files, force file-based auth, or tighten their existing modes.
  mkdirSync(selection.home, { recursive: true, mode: 0o700 })
  const home = realpathSync(selection.home)
  const stat = lstatSync(home)
  if (!stat.isDirectory() || stat.uid !== process.getuid?.()) throw new Error('codex_unsafe_home')
  return home
}
export function assertCodexLayout(state: string, workspace: string, allowWorktrees = true) {
  const contains = (root: string, path: string) => {
    const from = relative(root, path)
    return from === '' || (from !== '..' && !from.startsWith('..' + sep) && !isAbsolute(from))
  }
  if (
    !isAbsolute(state) ||
    !isAbsolute(workspace) ||
    contains(workspace, state) ||
    (contains(state, workspace) &&
      (!allowWorktrees ||
        !contains(join(state, 'worktrees'), workspace) ||
        workspace === join(state, 'worktrees')))
  )
    throw new Error('codex_state_workspace_overlap')
}
export function ensureCodexHome(home: string) {
  if (!isAbsolute(home)) throw new Error('codex_unsafe_home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  const stat = lstatSync(home)
  if (
    stat.isSymbolicLink() ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    realpathSync(home) !== home
  )
    throw new Error('codex_unsafe_home')
  chmodSync(home, 0o700)
  for (const name of ['sqlite', 'logs']) {
    const path = join(home, name)
    try {
      lstatSync(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      mkdirSync(path, { mode: 0o700 })
    }
  }
  for (const name of ['auth.json', 'config.toml', 'sqlite', 'logs']) {
    let entry
    try {
      entry = lstatSync(join(home, name))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (
      entry.isSymbolicLink() ||
      entry.uid !== process.getuid?.() ||
      (entry.mode & 0o077) !== 0 ||
      (['sqlite', 'logs'].includes(name) ? !entry.isDirectory() : !entry.isFile())
    )
      throw new Error('codex_unsafe_home')
  }
  return home
}
