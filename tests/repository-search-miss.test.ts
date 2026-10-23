import { it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { NodeCore } from '../packages/node-core/src/index.js'
import { GitRunner } from '../packages/node-core/src/git.js'
const gitPath = existsSync('/Library/Developer/CommandLineTools/usr/bin/git')
  ? '/Library/Developer/CommandLineTools/usr/bin/git'
  : 'git'
async function scenario(
  glob: string,
  count: number,
  mode = 'literal',
  plain = false,
  linked = false
) {
  const dir = mkdtempSync(resolve('.scratch/search-miss-'))
  let repo = join(dir, 'repo')
  mkdirSync(repo)
  const git = (...args: string[]) =>
    execFileSync(gitPath, ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo })
  if (!plain) {
    git('init', '-b', 'trunk')
    writeFileSync(join(repo, 'README.md'), 'sample project\n')
    git('add', '.')
    git(
      '-c',
      'user.name=Sample',
      '-c',
      'user.email=sample@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'Initial sample'
    )
  }
  mkdirSync(join(repo, 'tests'))
  mkdirSync(join(repo, 'spec'))
  writeFileSync(join(repo, 'tests/sample.test.ts'), 'needle\n'.repeat(count))
  writeFileSync(join(repo, 'spec/sample.spec.ts'), 'needle\nneedle\n')
  if (linked) {
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
    mkdirSync(join(repo, 'aaa'))
    // Consume the byte budget before search reaches the committed tests.
    for (let i = 0; i < 33; i++)
      writeFileSync(join(repo, 'aaa', `${i}.ts`), 'x'.repeat(1024 * 1024))
    git('add', '.')
    git(
      '-c',
      'user.name=Sample',
      '-c',
      'user.email=sample@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'Tracked tests'
    )
    const checkout = join(dir, 'linked')
    git('worktree', 'add', '-b', 'linked', checkout)
    repo = checkout
    mkdirSync(join(repo, 'node_modules'))
    for (let i = 0; i < 1500; i++)
      writeFileSync(join(repo, 'node_modules', `${i}.js`), 'needle dependency')
    // The observed working file must win over the committed blob and main checkout.
    writeFileSync(join(repo, 'tests/sample.test.ts'), 'needle\n'.repeat(count + 1))
  }
  if (mode === 'filename')
    for (let i = 0; i < count; i++) writeFileSync(join(repo, 'tests', `needle-${i}.ts`), '')
  const core = new NodeCore(join(dir, 'state'), { git: new GitRunner(15000, 512 * 1024, gitPath) })
  try {
    const actor = core.authority.authenticate(core.createToken('sample').token)
    let op = 0
    const request = async (method: string, params: unknown) =>
      (await core.request(actor, method, params, 'sample-' + ++op)) as any
    const project = await request('project.register', { path: repo, trust: 'untrusted' })
    let target
    if (plain)
      target = {
        workspace_id: (await request('workspace.list', { project_id: project.project_id }))[0]
          .workspace_id,
      }
    else {
      const worktree_id = (
        await request('repository.v1.worktrees', { project_id: project.project_id })
      ).entries[0].worktree_id
      target = {
        worktree_id,
        revision: (await request('repository.v1.observe', { worktree_id })).revision,
        scope: 'repository',
      }
    }
    const params = {
      ...target,
      query: 'needle',
      mode,
      case_sensitive: false,
      limit: 100,
      ...(glob ? { path_glob: glob } : {}),
    }
    let cursor,
      rows: any[] = [],
      pages = 0
    do {
      const page = await request(plain ? 'workspace.search' : 'repository.v1.search', {
        ...params,
        cursor,
      })
      rows.push(...page.entries)
      if (linked && pages === 0) {
        expect(page.entries).toHaveLength(0)
        expect(page.incomplete).toBe(true)
        expect(page.cursor).toBeTruthy()
      }
      cursor = page.cursor
      if (++pages > 30) throw Error('nonterminating cursor')
    } while (cursor)
    expect(new Set(rows.map((r) => `${r.path}:${r.line}`)).size).toBe(rows.length)
    if (mode === 'filename') {
      expect(rows).toHaveLength(count)
      return
    }
    expect(rows.filter((r) => r.path === 'tests/sample.test.ts')).toHaveLength(
      count + (linked ? 1 : 0)
    )
    expect(rows.filter((r) => r.path === 'spec/sample.spec.ts')).toHaveLength(
      glob === 'tests/*.ts' ? 0 : 2
    )
  } finally {
    await core.resources.stop()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
it('finds uncommitted tests and spec files across pages without a glob', () => scenario('', 105))
// BUG: the matcher truncates a file and the repository cursor advances to the next file.
it.each(['literal', 'regex'])('retains matches beyond the per-scan row budget in %s', (mode) =>
  scenario('', 1105, mode)
)
// BUG: basename globs are anchored to the complete path, excluding nested files.
it.each(['literal', 'regex'])('finds nested tests with a basename glob in %s mode', (mode) =>
  scenario('*.ts', 105, mode)
)
it.each(['*.{ts,js}', '**/*.ts', 'tests/*.ts', '**'])('supports glob %s', (glob) =>
  scenario(glob, 105)
)
it.each([false, true])('pages filename matches with plain=%s', (plain) =>
  scenario('*.ts', 1005, 'filename', plain)
)
it.each(['literal', 'regex'])('pages plain-folder matches in %s', (mode) =>
  scenario('*.{ts,js}', 1105, mode, true)
)
it('continues an empty budget page in a linked checkout with private dependencies', () =>
  scenario('', 3, 'literal', false, true))
