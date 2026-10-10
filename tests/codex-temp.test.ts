import { it, expect } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  lstatSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { prepareWorkspaceTemp } from '../packages/provider-codex/src/temp.js'

function fixture(test: (directory: string, git: (...args: string[]) => string) => void) {
  const directory = mkdtempSync(resolve('.scratch/codex-temp-'))
  const git = (...args: string[]) => {
    const r = spawnSync('/usr/bin/git', args, {
      cwd: directory,
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: directory,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    })
    expect(r.status, r.stderr).toBe(0)
    return r.stdout
  }
  try {
    git('init', '-b', 'main')
    test(directory, git)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
it('creates a private canonical writable TMPDIR and keeps its contents out of ordinary Git status', () =>
  fixture((workspace, git) => {
    const temp = prepareWorkspaceTemp(workspace)
    expect(temp).toBe(join(workspace, '.abele-tmp'))
    expect(lstatSync(temp).mode & 0o777).toBe(0o700)
    const command = spawnSync('/usr/bin/mktemp', ['-p', temp], {
      cwd: workspace,
      encoding: 'utf8',
      env: { PATH: '/usr/bin:/bin', TMPDIR: temp },
    })
    expect(command.status, command.stderr).toBe(0)
    expect(command.stdout.trim()).toContain(temp)
    writeFileSync(join(temp, 'build-output'), 'fixture')
    expect(git('status', '--porcelain=v1', '--untracked-files=all')).toBe('')
    expect(git('ls-files', '--', '.abele-tmp')).toBe('')
    expect(prepareWorkspaceTemp(workspace)).toBe(temp)
  }))
it.each(['directory-link', 'ignore-link', 'tracked', 'foreign-ignore'])(
  'refuses unsafe or user-owned temp metadata %s before dispatch',
  (condition) =>
    fixture((workspace, git) => {
      const temp = join(workspace, '.abele-tmp')
      if (condition === 'directory-link') symlinkSync(workspace, temp)
      else {
        mkdirSync(temp)
        if (condition === 'ignore-link')
          symlinkSync(join(workspace, 'other'), join(temp, '.gitignore'))
        if (condition === 'foreign-ignore') writeFileSync(join(temp, '.gitignore'), 'user rule\n')
        if (condition === 'tracked') {
          writeFileSync(join(temp, 'user-file'), 'original')
          git('add', '.abele-tmp/user-file')
        }
      }
      expect(() => prepareWorkspaceTemp(workspace)).toThrow(/codex_(unsafe|tracked)_temp/)
      if (condition === 'tracked')
        expect(readFileSync(join(temp, 'user-file'), 'utf8')).toBe('original')
    })
)
it('ignores temp independently in linked worktrees without editing tracked or common Git metadata', () =>
  fixture((root, git) => {
    writeFileSync(join(root, 'file'), 'fixture')
    git('add', 'file')
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'fixture'
    )
    const workspace = join(root, 'linked')
    git('worktree', 'add', '-b', 'linked', workspace)
    const before = readFileSync(join(root, '.git/info/exclude'), 'utf8')
    prepareWorkspaceTemp(workspace)
    writeFileSync(join(workspace, '.abele-tmp/output'), 'fixture')
    const status = spawnSync(
      '/usr/bin/git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { cwd: workspace, encoding: 'utf8' }
    )
    expect(status.status, status.stderr).toBe(0)
    expect(status.stdout).toBe('')
    expect(readFileSync(join(root, '.git/info/exclude'), 'utf8')).toBe(before)
  }))
