import { afterEach, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'

// A watched worktree announces a change only when what a reader can see of it changed: an
// index rewritten by another tool's `git status`, an ignored file, or an editor's temporary
// file that is gone again leave the files, their states and HEAD as they were.
const dirs: string[] = [],
  cores: NodeCore[] = []
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' })
  if (r.status) throw new Error(r.stderr)
  return r.stdout.trim()
}
async function setup() {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/repository-quiet-watch-'))
  dirs.push(dir)
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, 'notes'), { recursive: true })
  git(repo, 'init', '-b', 'trunk')
  git(repo, 'config', 'user.name', 'Fixture')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(repo, 'file'), 'before\n')
  writeFileSync(join(repo, 'notes', 'sample.md'), 'sample\n')
  writeFileSync(join(repo, '.gitignore'), '*.log\nbuild/\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'fixture')
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let operation = 0
  const request = async (method: string, params: unknown = {}) =>
    (await core.request(actor, method, params, `fixture-${++operation}`)) as any
  const project = await request('project.register', { path: repo, trust: 'untrusted' })
  const root = (
    await request('repository.v1.worktrees', { project_id: project.project_id })
  ).entries.find((e: any) => e.kind === 'root').worktree_id
  const invalidations = (after: number) =>
    core.read('catalog', after).filter((e) => e.type === 'repository.invalidated')
  return { repo, core, request, root, invalidations }
}
afterEach(async () => {
  for (const c of cores.splice(0)) {
    await c.resources.stop()
    c.close()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function wait(predicate: () => boolean) {
  const end = Date.now() + 10000
  while (!predicate()) {
    if (Date.now() > end) throw new Error('watcher deadline')
    await settle(20)
  }
}

it('announces nothing when only invisible files change, and still announces a real edit', async () => {
  const s = await setup()
  await s.request('repository.v1.watch', { worktree_id: s.root })
  // The subscription's own first announcement, then a quiet worktree.
  await settle(2500)
  const before = s.core.head('catalog')
  // Another tool's `git status` rewrites the index without changing anything shown.
  git(s.repo, 'read-tree', 'HEAD')
  git(s.repo, 'status', '--porcelain')
  // Ignored output and a log, written and rewritten.
  mkdirSync(join(s.repo, 'build'), { recursive: true })
  writeFileSync(join(s.repo, 'build', 'out.js'), 'one\n')
  writeFileSync(join(s.repo, 'debug.log'), 'one\n')
  writeFileSync(join(s.repo, 'debug.log'), 'two\n')
  // An editor's temporary file beside a note, gone again before anyone reads the folder.
  writeFileSync(join(s.repo, 'notes', '.sample.md.tmp'), 'draft\n')
  rmSync(join(s.repo, 'notes', '.sample.md.tmp'))
  // Long enough for the filesystem hints and two periodic reconciliations.
  await settle(4500)
  expect(s.invalidations(before)).toHaveLength(0)

  writeFileSync(join(s.repo, 'notes', 'sample.md'), 'edited\n')
  await wait(() => s.invalidations(before).length > 0)
}, 30000)
