import { mkdirSync, lstatSync, realpathSync, chmodSync, writeFileSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { isAbsolute, join, dirname } from 'node:path'

const ignoreContents = '# Abele workspace-local temporary files\n*\n'
/** A self-ignored directory works for linked worktrees without modifying shared Git metadata. */
export function prepareWorkspaceTemp(workspace: string) {
  if (!isAbsolute(workspace) || realpathSync(workspace) !== workspace)
    throw new Error('codex_unsafe_temp')
  const directory = join(workspace, '.abele-tmp'),
    ignore = join(directory, '.gitignore')
  let gitEntry
  try {
    gitEntry = lstatSync(join(workspace, '.git'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (gitEntry) {
    if (gitEntry.isSymbolicLink()) throw new Error('codex_unsafe_temp')
    const tracked = spawnSync(
      '/usr/bin/git',
      [
        '--no-optional-locks',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'core.fsmonitor=false',
        'ls-files',
        '-z',
        '--',
        '.abele-tmp',
      ],
      {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 65536,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: workspace,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_CEILING_DIRECTORIES: dirname(workspace),
        },
      }
    )
    if (tracked.status !== 0) throw new Error('codex_unsafe_temp')
    if (tracked.stdout.length) throw new Error('codex_tracked_temp')
  }
  try {
    lstatSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    mkdirSync(directory, { mode: 0o700 })
  }
  const stat = lstatSync(directory)
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    realpathSync(directory) !== directory
  )
    throw new Error('codex_unsafe_temp')
  let ignoreStat
  try {
    ignoreStat = lstatSync(ignore)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (ignoreStat) {
    if (
      !ignoreStat.isFile() ||
      ignoreStat.isSymbolicLink() ||
      ignoreStat.uid !== process.getuid?.() ||
      ignoreStat.nlink !== 1 ||
      ignoreStat.size > 1024 ||
      readFileSync(ignore, 'utf8') !== ignoreContents
    )
      throw new Error('codex_unsafe_temp')
  } else writeFileSync(ignore, ignoreContents, { mode: 0o600, flag: 'wx' })
  chmodSync(directory, 0o700)
  return directory
}
