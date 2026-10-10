import { afterEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'

const dirs: string[] = [],
  cores: NodeCore[] = []
function git(cwd: string, ...args: string[]) {
  const r = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return r.stdout.trim()
}
async function setup() {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/repository-pending-security-'))
  dirs.push(dir)
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-b', 'trunk')
  git(repo, 'config', 'user.name', 'Fixture')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(repo, 'file'), 'invented pending content\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'fixture')
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let operation = 0
  const request = async (method: string, params: unknown = {}) =>
    (await core.request(actor, method, params, `fixture-${++operation}`)) as any
  const project = await request('project.register', { path: repo, trust: 'untrusted' })
  const worktree_id = (await request('repository.v1.worktrees', { project_id: project.project_id }))
    .entries[0].worktree_id
  return { dir, repo, core, request, project, worktree_id }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of cores.splice(0)) {
    await c.resources.stop()
    c.close()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

it.each([false, true])(
  'cannot repopulate retained external bytes after pending-read opt-out (immediate reapproval: %s)',
  async (immediate) => {
    const s = await setup(),
      linked = join(s.dir, 'linked')
    git(s.repo, 'worktree', 'add', '-b', 'side', linked)
    const settings = (external_read: boolean) =>
      s.request('project.repository_settings', { project_id: s.project.project_id, external_read })
    await settings(true)
    const worktree_id = (
      await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
    ).entries.find((e: any) => e.kind === 'external').worktree_id
    const revision = await s.request('repository.v1.resolve', { worktree_id, ref: 'HEAD' })
    const run = s.core.resources.git.run.bind(s.core.resources.git)
    let interrupted = false
    vi.spyOn(s.core.resources.git, 'run').mockImplementation(
      async (cwd, command, before, deadline) => {
        const bytes = await run(cwd, command, before, deadline)
        if (command.kind === 'blob' && !interrupted) {
          interrupted = true
          await settings(false)
          if (immediate) await settings(true)
        }
        return bytes
      }
    )
    await expect(
      s.request('repository.v1.blob', { worktree_id, revision, path: 'file' })
    ).rejects.toThrow('unauthorized')
    if (!immediate) await settings(true)
    const content_id = createHash('sha256').update('invented pending content\n').digest('hex')
    await expect(s.request('repository.v1.content', { worktree_id, content_id })).rejects.toThrow(
      'content_expired'
    )
    const spy = vi.spyOn(s.core.resources.git, 'run')
    spy.mockClear()
    expect(
      await s.request('repository.v1.blob', { worktree_id, revision, path: 'file' })
    ).toMatchObject({ content_id })
    expect(spy.mock.calls.filter(([, command]) => command.kind === 'blob')).toHaveLength(1)
  }
)

it('fences an external catalogue pending across opt-out and immediate reapproval before retaining a cursor', async () => {
  const s = await setup()
  git(s.repo, 'worktree', 'add', '-b', 'side', join(s.dir, 'linked'))
  const settings = (external_read: boolean) =>
    s.request('project.repository_settings', { project_id: s.project.project_id, external_read })
  await settings(true)
  const run = s.core.resources.git.run.bind(s.core.resources.git)
  let interrupted = false
  vi.spyOn(s.core.resources.git, 'run').mockImplementation(
    async (cwd, command, before, deadline) => {
      const bytes = await run(cwd, command, before, deadline)
      if (command.kind === 'worktrees' && !interrupted) {
        interrupted = true
        await settings(false)
        await settings(true)
      }
      return bytes
    }
  )
  await expect(
    s.request('repository.v1.worktrees', { project_id: s.project.project_id, limit: 1 })
  ).rejects.toThrow('unauthorized')
  expect((s.core.resources.repository as any).cursors.size).toBe(0)
})

it('does not allocate external watchers after opt-out and immediate reapproval during setup', async () => {
  const s = await setup()
  git(s.repo, 'worktree', 'add', '-b', 'side', join(s.dir, 'linked'))
  const settings = (external_read: boolean) =>
    s.request('project.repository_settings', { project_id: s.project.project_id, external_read })
  await settings(true)
  const worktree_id = (
    await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  ).entries.find((e: any) => e.kind === 'external').worktree_id
  const repository = s.core.resources.repository as any
  const fingerprint = repository.watchFingerprint.bind(repository)
  vi.spyOn(repository, 'watchFingerprint').mockImplementation(async (...args: any[]) => {
    const result = await fingerprint(...args)
    await settings(false)
    await settings(true)
    return result
  })
  await expect(s.request('repository.v1.watch', { worktree_id })).rejects.toThrow('unauthorized')
  expect(repository.subscriptions.size).toBe(0)
})

it('does not read a file that would exceed the 32 MiB search scan budget', async () => {
  const s = await setup()
  const size = 1024 * 1024 - 1
  for (let i = 0; i < 33; i++)
    writeFileSync(
      join(s.repo, `bounded-${String(i).padStart(2, '0')}`),
      'needle\n' + 'x'.repeat(size - 7)
    )
  git(s.repo, 'add', '.')
  git(s.repo, 'commit', '-m', 'scan byte ceiling')
  const revision = await s.request('repository.v1.resolve', {
    worktree_id: s.worktree_id,
    ref: 'HEAD',
  })
  // Execution deadlines have separate real-clock tests; this fixture isolates the byte ceiling.
  vi.spyOn(Date, 'now').mockReturnValue(Date.now())
  const run = vi.spyOn(s.core.resources.git, 'run')
  const result = await s.request('repository.v1.search', {
    worktree_id: s.worktree_id,
    revision,
    query: 'needle',
    path_glob: 'bounded-*',
  })
  expect(result.entries).toHaveLength(32)
  expect(run.mock.calls.filter(([, command]) => command.kind === 'blob')).toHaveLength(32)
  expect(result.incomplete).toBe(true)
  expect(result.omissions.join(' ')).toContain('scan limit')
})

it('stops scanning after 2048 files with explicit incomplete coverage', async () => {
  const s = await setup(),
    oid = git(s.repo, 'rev-parse', 'HEAD:file')
  const tree = spawnSync('/usr/bin/git', ['mktree'], {
    cwd: s.repo,
    encoding: 'utf8',
    input: Array.from(
      { length: 2050 },
      (_, i) => `100644 blob ${oid}\tentry-${String(i).padStart(5, '0')}\n`
    ).join(''),
  })
  expect(tree.status, tree.stderr).toBe(0)
  const commit = spawnSync('/usr/bin/git', ['commit-tree', tree.stdout.trim()], {
    cwd: s.repo,
    encoding: 'utf8',
    input: 'scan fixture\n',
  })
  expect(commit.status, commit.stderr).toBe(0)
  vi.spyOn(Date, 'now').mockReturnValue(Date.now())
  const result = await s.request('repository.v1.search', {
    worktree_id: s.worktree_id,
    revision: { kind: 'commit', commit: commit.stdout.trim() },
    mode: 'filename',
    query: 'entry-02049',
  })
  expect(result.entries).toEqual([])
  expect(result.incomplete).toBe(true)
  expect(result.omissions.join(' ')).toContain('scan limit')
})
