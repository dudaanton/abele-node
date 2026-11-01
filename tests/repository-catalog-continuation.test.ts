import { afterEach, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'

const fixtures: { core: NodeCore; dir: string }[] = []
const executable = existsSync('/Library/Developer/CommandLineTools/usr/bin/git')
  ? '/Library/Developer/CommandLineTools/usr/bin/git'
  : '/usr/bin/git'
function git(cwd: string, ...args: string[]) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
async function setup() {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/catalog-continuation-'))
  const repo = join(dir, 'repo'),
    linked = join(dir, 'linked')
  mkdirSync(repo)
  git(repo, 'init', '-b', 'trunk')
  git(repo, 'config', 'user.name', 'Fixture')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(repo, 'sample.txt'), 'initial\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')
  git(repo, 'worktree', 'add', '-b', 'side', linked)
  const core = new NodeCore(join(dir, 'state'))
  fixtures.push({ core, dir })
  Object.defineProperty(core.resources.git, 'executable', { value: executable })
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let operation = 0
  const request = async (method: string, params: unknown) =>
    (await core.request(actor, method, params, `fixture-${++operation}`)) as any
  const project = await request('project.register', { path: repo, trust: 'untrusted' })
  await request('project.repository_settings', {
    project_id: project.project_id,
    external_read: true,
  })
  const params = { project_id: project.project_id, limit: 1 }
  return { repo, linked, dir, request, params }
}
afterEach(async () => {
  for (const { core, dir } of fixtures.splice(0)) {
    await core.resources.stop()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
it('continues a catalogue when dirty metadata changes between pages', async () => {
  const s = await setup()
  const first = await s.request('repository.v1.worktrees', s.params)
  expect(first.cursor).toBeTruthy()
  expect(first.entries[0].dirty).toBe(false)
  writeFileSync(join(s.repo, 'sample.txt'), 'edited by another chat\n')
  const next = await s.request('repository.v1.worktrees', { ...s.params, cursor: first.cursor })
  expect(next.entries).toHaveLength(1)
  expect(next.entries[0].worktree_id).not.toBe(first.entries[0].worktree_id)
  expect(next.cursor).toBeNull()
})
it('continues a catalogue when availability metadata changes between pages', async () => {
  const s = await setup()
  const first = await s.request('repository.v1.worktrees', s.params)
  expect(first.cursor).toBeTruthy()
  renameSync(s.linked, join(s.dir, 'temporarily-unavailable'))
  const next = await s.request('repository.v1.worktrees', { ...s.params, cursor: first.cursor })
  expect(next.entries).toHaveLength(1)
  expect(next.cursor).toBeNull()
  // A frozen catalogue page never grants authority to read a missing directory.
  await expect(
    s.request('repository.v1.resolve', {
      worktree_id: next.entries[0].worktree_id,
      ref: 'HEAD',
    })
  ).rejects.toThrow()
})
it('rejects a catalogue continuation when membership changes', async () => {
  const s = await setup()
  const first = await s.request('repository.v1.worktrees', s.params)
  expect(first.cursor).toBeTruthy()
  git(s.repo, 'worktree', 'remove', s.linked)
  await expect(
    s.request('repository.v1.worktrees', {
      ...s.params,
      cursor: first.cursor,
    })
  ).rejects.toThrow('stale_cursor')
})
