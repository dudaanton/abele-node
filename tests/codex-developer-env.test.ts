import { expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  prepareDeveloperEnvironment,
  missingDeveloperDependencies,
} from '../packages/provider-codex/src/developer-environment.js'
import { codexSessionUpdates } from '../packages/node-protocol/src/codex-updates.js'
import { filesystem, buildConfig, shellEnvironment } from '../packages/provider-codex/src/policy.js'
import { NodeCore } from '@abele/node-core'

it('warns before testing when dependencies are absent and network is disabled', () => {
  const directory = mkdtempSync(resolve('.scratch/codex-deps-'))
  try {
    writeFileSync(
      join(directory, 'package.json'),
      JSON.stringify({ devDependencies: { fixture: '1.0.0' } })
    )
    expect(missingDeveloperDependencies(directory)).toBe(true)
    expect(codexSessionUpdates('codex.dependencies.warning', { network_enabled: false })).toEqual([
      expect.objectContaining({
        kind: 'notice',
        level: 'warning',
        code: 'missing_dependencies',
        text: expect.stringContaining('Network is disabled'),
      }),
    ])
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})

it('runs local npm tests and commits only its linked worktree branch with caches outside the checkout', async () => {
  const dir = mkdtempSync(resolve('.scratch/codex-developer-')),
    repo = join(dir, 'repo'),
    workspace = join(dir, 'worktree'),
    state = join(dir, 'state')
  mkdirSync(repo)
  mkdirSync(state)
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' })
    expect(r.status, r.stderr).toBe(0)
    return r.stdout.trim()
  }
  try {
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.name', 'Fixture')
    git(repo, 'config', 'user.email', 'fixture@example.invalid')
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ scripts: { test: 'node test.cjs' } })
    )
    writeFileSync(join(repo, 'file'), 'original')
    writeFileSync(
      join(repo, 'test.cjs'),
      "require('node:assert/strict').equal(require('node:fs').readFileSync('file','utf8'),'edited')"
    )
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'initial')
    const main = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'worktree', 'add', '-b', 'developer', workspace)
    const gitdir = git(workspace, 'rev-parse', '--absolute-git-dir'),
      repository = join(repo, '.git')
    const developer = prepareDeveloperEnvironment(state, workspace)
    const paths = {
      state,
      workspace,
      sibling: dir,
      home: join(state, 'codex'),
      repository,
      gitdir,
      developer,
    }
    const env = shellEnvironment(paths)
    expect(env.HOME.startsWith(workspace + '/')).toBe(false)
    expect(env.HOME).not.toBe(workspace)
    const red = spawnSync('/bin/sh', ['-c', 'node --version && npm test'], {
      cwd: workspace,
      env,
      encoding: 'utf8',
    })
    expect(red.status).not.toBe(0)
    expect(red.stderr).toContain('AssertionError')
    const cache = spawnSync(
      '/bin/sh',
      [
        '-c',
        'mkdir -p "$HOME/Library/Caches/tool" && printf cached > "$HOME/Library/Caches/tool/marker"',
      ],
      { cwd: workspace, env, encoding: 'utf8' }
    )
    expect(cache.status, cache.stderr).toBe(0)
    expect(readFileSync(join(env.HOME, 'Library/Caches/tool/marker'), 'utf8')).toBe('cached')
    writeFileSync(join(workspace, 'file'), 'edited')
    const green = spawnSync('/bin/sh', ['-c', 'npm test'], {
      cwd: workspace,
      env,
      encoding: 'utf8',
    })
    expect(green.status, green.stderr).toBe(0)
    const commit = spawnSync(
      '/bin/sh',
      [
        '-c',
        'git status --porcelain && git diff && git add file && git -c user.name=Fixture -c user.email=fixture@example.invalid commit -m edit',
      ],
      { cwd: workspace, env, encoding: 'utf8' }
    )
    expect(commit.status, commit.stderr).toBe(0)
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(main)
    expect(git(workspace, 'status', '--porcelain')).toBe('')
    expect(existsSync(join(workspace, 'Library'))).toBe(false)
    const fs = filesystem(paths)
    expect(fs[repository]).toBe('read')
    expect(fs[join(repository, 'objects')]).toBe('write')
    expect(fs[join(repository, 'refs/heads/developer')]).toBe('write')
    expect(fs[join(repository, 'refs/heads/main')]).not.toBe('write')
    expect(fs[join(gitdir, 'index')]).toBe('write')
    expect(fs[join(repository, 'worktrees')]).toBe('deny')
    expect(() => filesystem({ ...paths, gitdir: join(dir, 'other-git') })).toThrow(
      'codex_git_binding_unavailable'
    )
    expect(() => filesystem({ ...paths, home: developer.root })).toThrow(
      'codex_developer_home_overlap'
    )
    expect(buildConfig(paths)).toMatch(/\[permissions.abele.network\]\nenabled = false/)
    expect(buildConfig({ ...paths, developer: { ...developer, network: true } })).toMatch(
      /\[permissions.abele.network\]\nenabled = true/
    )
    let core = new NodeCore(join(dir, 'network-state'))
    try {
      const actor = core.authority.authenticate(core.createToken('owner').token)
      const project: any = await core.request(
        actor,
        'project.register',
        { path: repo, trust: 'trusted' },
        crypto.randomUUID()
      )
      expect(project.codex_network_enabled).toBe(false)
      const changed: any = await core.request(
        actor,
        'project.codex_permissions',
        { project_id: project.project_id, network_enabled: true },
        crypto.randomUUID()
      )
      expect(changed.codex_network_enabled).toBe(true)
      core.close()
      core = new NodeCore(join(dir, 'network-state'))
      const restored: any = await core.request(actor, 'project.get', {
        project_id: project.project_id,
      })
      expect(restored.codex_network_enabled).toBe(true)
    } finally {
      core.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
