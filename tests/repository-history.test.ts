import { afterEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
import { GitRunner, type GitCommand } from '../packages/node-core/src/git.js'

const dirs: string[] = [],
  cores: NodeCore[] = []
function git(cwd: string, ...args: string[]) {
  const r = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' })
  if (r.status) throw new Error(r.stderr)
  return r.stdout.trim()
}
async function setup(commits: { file: string; message: string }[]) {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/history-'))
  dirs.push(dir)
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-b', 'trunk')
  git(repo, 'config', 'user.name', 'Fixture')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  commits.forEach((c, i) => {
    writeFileSync(join(repo, c.file), `revision ${i}\n`)
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', c.message)
  })
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let op = 0
  const request = async (method: string, params: unknown = {}) =>
    (await core.request(actor, method, params, 'fixture-' + ++op)) as any
  const project = await request('project.register', { path: repo, trust: 'untrusted' })
  const worktree_id = (await request('repository.v1.worktrees', { project_id: project.project_id }))
    .entries[0].worktree_id
  const revision = await request('repository.v1.resolve', { worktree_id, ref: 'HEAD' })
  return { repo, request, worktree_id, revision }
}
function countHistoryReads() {
  const run = GitRunner.prototype.run,
    reads: GitCommand[] = []
  vi.spyOn(GitRunner.prototype, 'run').mockImplementation(function (
    this: GitRunner,
    ...args: Parameters<GitRunner['run']>
  ) {
    if (args[1].kind === 'history') reads.push(args[1])
    return run.apply(this, args)
  })
  return reads
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const core of cores.splice(0)) {
    await core.resources.stop()
    core.close()
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

it('reads a page of history with one Git process, continuing where the page stopped', async () => {
  const s = await setup(
    Array.from({ length: 30 }, (_, i) => ({
      file: i % 3 ? 'other.txt' : 'sample.txt',
      message: `change ${i}\n\nbody line one of ${i}\nbody line two`,
    }))
  )
  const reads = countHistoryReads()
  const first = await s.request('repository.v1.history', {
    worktree_id: s.worktree_id,
    revision: s.revision,
    limit: 12,
  })
  expect(reads).toHaveLength(1)
  expect(first.entries.map((e: any) => e.subject)).toEqual(
    Array.from({ length: 12 }, (_, i) => `change ${29 - i}`)
  )
  expect(first.entries[0]).toMatchObject({
    message: 'change 29\n\nbody line one of 29\nbody line two\n',
    author: 'Fixture',
    email: 'fixture@example.invalid',
  })
  expect(first.entries[0].parents).toEqual([first.entries[1].commit])
  expect(first.cursor).toBeTruthy()
  const next = await s.request('repository.v1.history', {
    worktree_id: s.worktree_id,
    revision: s.revision,
    limit: 12,
    cursor: first.cursor,
  })
  expect(reads).toHaveLength(2)
  expect(next.entries.map((e: any) => e.subject)).toEqual(
    Array.from({ length: 12 }, (_, i) => `change ${17 - i}`)
  )
  const rest = await s.request('repository.v1.history', {
    worktree_id: s.worktree_id,
    revision: s.revision,
    limit: 12,
    cursor: next.cursor,
  })
  expect(rest.entries.map((e: any) => e.subject)).toEqual(
    Array.from({ length: 6 }, (_, i) => `change ${5 - i}`)
  )
  expect(rest.cursor).toBeNull()
  const byPath = await s.request('repository.v1.history', {
    worktree_id: s.worktree_id,
    revision: s.revision,
    path: 'sample.txt',
    limit: 100,
  })
  expect(reads).toHaveLength(4)
  expect(byPath.entries.map((e: any) => e.subject)).toEqual(
    Array.from({ length: 10 }, (_, i) => `change ${27 - 3 * i}`)
  )
  expect(byPath.cursor).toBeNull()
  const commit = await s.request('repository.v1.commit', {
    worktree_id: s.worktree_id,
    revision: s.revision,
  })
  expect(reads).toHaveLength(5)
  expect(commit.subject).toBe('change 29')
})

it('keeps the page byte bound and the per-commit size refusal', async () => {
  const s = await setup([
    { file: 'a.txt', message: 'small' },
    ...Array.from({ length: 3 }, (_, i) => ({
      file: 'a.txt',
      message: `wide ${i}\n\n${'w'.repeat(12000)}`,
    })),
  ])
  const page = await s.request('repository.v1.history', {
    worktree_id: s.worktree_id,
    revision: s.revision,
    limit: 100,
  })
  expect(page.entries.map((e: any) => e.subject)).toEqual(['wide 2', 'wide 1'])
  expect(page.cursor).toBeTruthy()
  git(s.repo, 'commit', '-q', '--allow-empty', '-m', 'huge\n\n' + 'h'.repeat(40000))
  const head = await s.request('repository.v1.resolve', { worktree_id: s.worktree_id, ref: 'HEAD' })
  await expect(
    s.request('repository.v1.history', { worktree_id: s.worktree_id, revision: head, limit: 5 })
  ).rejects.toThrow('output_limit')
})
