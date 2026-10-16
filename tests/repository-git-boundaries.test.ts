import { afterAll, afterEach, beforeAll, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
import { OwnerGit, stripCredentials } from '../packages/node-core/src/git-owner.js'

const dirs: string[] = [],
  cores: NodeCore[] = []
const git = (cwd: string, ...args: string[]) => {
  const p = spawnSync('/usr/bin/git', ['-c', 'protocol.file.allow=always', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  })
  if (p.status) throw new Error(p.stderr)
  return p.stdout.trim()
}
// Owner git reads the user's global configuration; give these fixtures an empty one.
const home = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
beforeAll(() => {
  mkdirSync('.scratch', { recursive: true })
  const empty = mkdtempSync(resolve('.scratch/git-boundaries-home-'))
  dirs.push(empty)
  process.env.HOME = empty
  process.env.XDG_CONFIG_HOME = join(empty, '.config')
})
afterAll(() => {
  process.env.HOME = home.HOME
  if (home.XDG_CONFIG_HOME === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = home.XDG_CONFIG_HOME
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
afterEach(async () => {
  for (const c of cores.splice(0)) {
    await c.resources.stop()
    c.close()
  }
})
const identity = (cwd: string) => {
  git(cwd, 'config', 'user.name', 'Fixture Owner')
  git(cwd, 'config', 'user.email', 'owner@example.invalid')
}
const commit = (cwd: string, file: string, text: string) => {
  writeFileSync(join(cwd, file), text)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-qm', file)
  return git(cwd, 'rev-parse', 'HEAD')
}
async function setup() {
  const dir = mkdtempSync(resolve('.scratch/repository-git-boundaries-'))
  dirs.push(dir)
  const remote = join(dir, 'remote.git'),
    folder = join(dir, 'folder'),
    other = join(dir, 'other')
  git(dir, 'init', '-q', '--bare', '-b', 'trunk', remote)
  mkdirSync(folder)
  git(folder, 'init', '-q', '-b', 'trunk')
  identity(folder)
  commit(folder, 'sample', 'one\n')
  git(folder, 'remote', 'add', 'origin', remote)
  git(folder, 'push', '-q', '-u', 'origin', 'trunk')
  git(dir, 'clone', '-q', '-b', 'trunk', remote, other)
  identity(other)
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let op = 0
  const request = async (method: string, params: unknown, operation?: string) =>
    (await core.request(actor, method, params, operation ?? 'fixture-' + ++op)) as any
  const project = await request('project.register', { path: folder, trust: 'untrusted' })
  const root = (
    await request('repository.v1.worktrees', { project_id: project.project_id })
  ).entries.find((e: any) => e.kind === 'root').worktree_id
  const head = (cwd = folder) => git(cwd, 'rev-parse', 'HEAD')
  return { dir, folder, other, remote, core, root, request, head }
}

it('fetches and updates without entering submodules, whose git directories any worktree writer can replace', async () => {
  const s = await setup()
  const library = join(s.dir, 'library')
  mkdirSync(library)
  git(library, 'init', '-q', '-b', 'trunk')
  identity(library)
  commit(library, 'lib', 'lib\n')
  git(s.folder, 'submodule', '-q', 'add', library, 'lib')
  git(s.folder, 'config', '-f', '.gitmodules', 'submodule.lib.fetchRecurseSubmodules', 'true')
  git(s.folder, 'add', '.gitmodules')
  git(s.folder, 'commit', '-qm', 'library')
  git(s.folder, 'push', '-q', 'origin', 'trunk')
  git(s.folder, 'remote', 'set-head', 'origin', 'trunk')
  // Someone who can write ordinary files in the worktree points the submodule at a git
  // directory of their own, whose configuration names a program to run on fetch.
  const planted = join(s.folder, 'planted.git'),
    marker = join(s.dir, 'ran')
  git(s.dir, 'init', '-q', '--bare', planted)
  git(planted, 'config', 'remote.origin.url', 'file://' + library)
  git(planted, 'config', 'remote.origin.uploadpack', `touch '${marker}'; git-upload-pack`)
  git(planted, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
  writeFileSync(join(s.folder, 'lib', '.git'), `gitdir: ${planted}\n`)
  // Plain git would run it: this is the surface, not a contrived one.
  spawnSync('/usr/bin/git', ['fetch', '-q', 'origin'], {
    cwd: s.folder,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file' },
  })
  expect(existsSync(marker)).toBe(true)
  rmSync(marker)
  git(s.other, 'pull', '-q', '--ff-only')
  commit(s.other, 'theirs', 'theirs\n')
  git(s.other, 'push', '-q', 'origin', 'trunk')
  expect(await s.request('repository.v1.git.fetch', { worktree_id: s.root })).toMatchObject({
    state: 'fetched',
  })
  expect(existsSync(marker)).toBe(false)
  commit(s.other, 'more', 'more\n')
  git(s.other, 'push', '-q', 'origin', 'trunk')
  const updated = await s.request('repository.v1.git.update', {
    worktree_id: s.root,
    expected_head: s.head(),
  })
  expect(updated, JSON.stringify(updated)).toMatchObject({ state: 'updated', changed: true })
  expect(existsSync(marker)).toBe(false)
})

it('reads repository state for a reader without running hooks, filters or transports', async () => {
  const s = await setup()
  // A conflicted merge, so the read lists conflicted paths too.
  git(s.folder, 'switch', '-q', '-c', 'side')
  commit(s.folder, 'sample', 'side\n')
  git(s.folder, 'switch', '-q', 'trunk')
  commit(s.folder, 'sample', 'trunk\n')
  commit(s.folder, 'other', 'other\n')
  spawnSync('/usr/bin/git', ['merge', '-q', 'side'], { cwd: s.folder })
  const ran = join(s.dir, 'ran')
  mkdirSync(ran)
  for (const name of ['post-index-change', 'reference-transaction']) {
    const hook = join(s.folder, '.git', 'hooks', name)
    writeFileSync(hook, `#!/bin/sh\ntouch '${join(ran, name)}'\n`)
    chmodSync(hook, 0o755)
  }
  git(s.folder, 'config', 'filter.mark.clean', `touch '${join(ran, 'filter')}'; cat`)
  writeFileSync(join(s.folder, '.git', 'info', 'attributes'), '* filter=mark\n')
  // A file whose content git has to look at again.
  const later = new Date(Date.now() + 60000)
  utimesSync(join(s.folder, 'other'), later, later)
  const info = await s.request('repository.v1.git.info', { worktree_id: s.root })
  expect(info.operation).toEqual({ kind: 'merge', conflicted_paths: ['sample'] })
  expect(spawnSync('ls', [ran], { encoding: 'utf8' }).stdout.trim()).toBe('')
  // A probe never reaches a remote, whatever the repository allows.
  const probe = await new OwnerGit().run(s.folder, ['ls-remote', 'file://' + s.remote], {
    probe: true,
  })
  expect(probe.code).not.toBe(0)
  expect(probe.stdout.length).toBe(0)
})

it('removes credentials and token parameters from every git message it returns or keeps', async () => {
  expect(stripCredentials("fatal: unable to access 'https://user:p@ss@example.com/r.git/'")).toBe(
    "fatal: unable to access 'https://example.com/r.git/'"
  )
  expect(stripCredentials('To https://u:it\'s<"secret>@example.com/r')).toBe(
    'To https://example.com/r'
  )
  expect(
    stripCredentials(
      "unable to access 'https://example.com/r.git?access_token=abc&x=1/': failed\n" +
        'To https://example.com/r.git#private_token=def\n' +
        'remote: https://example.com/r?ok'
    )
  ).toBe(
    "unable to access 'https://example.com/r.git': failed\n" +
      'To https://example.com/r.git\n' +
      'remote: https://example.com/r'
  )
  const s = await setup()
  git(
    s.folder,
    'remote',
    'add',
    'bad',
    'https://someone:hunter2-secret@127.0.0.1:1/r.git?access_token=token-secret'
  )
  git(s.folder, 'branch', '--unset-upstream')
  const pushed = await s.request(
    'repository.v1.git.push',
    { worktree_id: s.root, expected_head: s.head(), remote: 'bad' },
    'push-bad'
  )
  expect(pushed.state).toBe('failed')
  const kept = JSON.stringify(s.core.db.prepare('SELECT * FROM operations').all())
  for (const text of [JSON.stringify(pushed), kept]) {
    expect(text).not.toContain('hunter2')
    expect(text).not.toContain('token-secret')
  }
})
