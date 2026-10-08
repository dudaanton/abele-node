import { afterEach, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { GitRunner, decodeGit } from '../packages/node-core/src/git.js'
import { selectedContext } from '../packages/node-protocol/src/files.js'
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function repo() {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/git-review-'))
  dirs.push(dir)
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.name', 'Fixture')
  git(dir, 'config', 'user.email', 'fixture@example.invalid')
  return dir
}
function git(dir: string, ...args: string[]) {
  const r = spawnSync('/usr/bin/git', args, { cwd: dir, encoding: 'utf8' })
  if (r.status) throw Error(r.stderr)
  return r.stdout.trim()
}
it('never runs a configured signature verifier when reading a signed commit', async () => {
  const dir = repo(),
    marker = join(dir, 'verifier-ran'),
    program = join(dir, 'fixture-gpg')
  writeFileSync(join(dir, 'sample'), 'fixture\n')
  git(dir, 'add', '.')
  const tree = git(dir, 'write-tree')
  const object = `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n Zml4dHVyZQ==\n -----END PGP SIGNATURE-----\n\nInvented signed commit\n`
  const stored = spawnSync('/usr/bin/git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    cwd: dir,
    input: object,
    encoding: 'utf8',
  })
  expect(stored.status, stored.stderr).toBe(0)
  const commit = stored.stdout.trim()
  writeFileSync(
    program,
    `#!${process.execPath}\nimport {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'invoked');process.exit(1)\n`,
    { mode: 0o700 }
  )
  git(dir, 'config', 'log.showSignature', 'true')
  git(dir, 'config', 'gpg.program', program)
  const runner = new GitRunner()
  const patch = decodeGit(
    await runner.run(dir, { kind: 'view.diff', mode: 'commit', head: commit, commit })
  )
  expect(patch).toContain('+fixture')
  expect(existsSync(marker)).toBe(false)
})
it('pins ordinary context, colors, textconv and external diff independently of Git configuration', async () => {
  const dir = repo()
  writeFileSync(join(dir, 'sample'), 'first\n\nold\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'initial')
  writeFileSync(join(dir, 'sample'), 'first\n\nnew\n')
  git(dir, 'config', 'diff.suppressBlankEmpty', 'true')
  git(dir, 'config', 'color.ui', 'always')
  git(dir, 'config', 'diff.external', 'false')
  const head = git(dir, 'rev-parse', 'HEAD'),
    patch = decodeGit(await new GitRunner().run(dir, { kind: 'view.diff', mode: 'head', head }))
  expect(patch).toContain('\n \n')
  expect(patch).not.toContain('\u001b[')
  expect(selectedContext(patch, { path: 'sample', side: 'new', start_line: 1, end_line: 3 })).toBe(
    'first\n\nnew'
  )
})
it('captures merge commit changes as an explicit first-parent ordinary diff, including root commits', async () => {
  const dir = repo()
  writeFileSync(join(dir, 'sample'), 'base\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'initial')
  const root = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'checkout', '-b', 'side')
  writeFileSync(join(dir, 'sample'), 'side\n')
  git(dir, 'commit', '-am', 'side')
  git(dir, 'checkout', 'main')
  writeFileSync(join(dir, 'sample'), 'main\n')
  git(dir, 'commit', '-am', 'main')
  const merge = spawnSync('/usr/bin/git', ['merge', 'side'], { cwd: dir, encoding: 'utf8' })
  expect(merge.status).toBe(1)
  writeFileSync(join(dir, 'sample'), 'resolved\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'merge')
  const commit = git(dir, 'rev-parse', 'HEAD'),
    runner = new GitRunner()
  const patch = decodeGit(
    await runner.run(dir, { kind: 'view.diff', mode: 'commit', head: commit, commit })
  )
  expect(patch).toContain('diff --git ')
  expect(patch).not.toContain('diff --cc ')
  expect(selectedContext(patch, { path: 'sample', side: 'old', start_line: 1, end_line: 1 })).toBe(
    'main'
  )
  expect(selectedContext(patch, { path: 'sample', side: 'new', start_line: 1, end_line: 1 })).toBe(
    'resolved'
  )
  const initial = decodeGit(
    await runner.run(dir, { kind: 'view.diff', mode: 'commit', head: commit, commit: root })
  )
  expect(
    selectedContext(initial, { path: 'sample', side: 'new', start_line: 1, end_line: 1 })
  ).toBe('base')
})
