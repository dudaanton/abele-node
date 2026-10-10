import { mkdirSync, chmodSync, realpathSync, lstatSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
export function assertCodexLayout(state: string, workspace: string) {
  const contains = (root: string, path: string) => {
    const from = relative(root, path)
    return from === '' || (from !== '..' && !from.startsWith('..' + sep) && !isAbsolute(from))
  }
  if (
    !isAbsolute(state) ||
    !isAbsolute(workspace) ||
    contains(workspace, state) ||
    (contains(state, workspace) &&
      (!contains(join(state, 'worktrees'), workspace) || workspace === join(state, 'worktrees')))
  )
    throw new Error('codex_state_workspace_overlap')
}
export function ensureCodexHome(stateDir: string) {
  if (!isAbsolute(stateDir)) throw new Error('codex_unsafe_home')
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  if (realpathSync(stateDir) !== stateDir || lstatSync(stateDir).uid !== process.getuid?.())
    throw new Error('codex_unsafe_home')
  const home = join(stateDir, 'codex')
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
