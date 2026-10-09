import { afterEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
import { parseWorktrees, GitRunner } from '../packages/node-core/src/git.js'
const dirs: string[] = [],
  cores: NodeCore[] = []
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' })
  if (r.status) throw new Error(r.stderr)
  return r.stdout.trim()
}
async function setup(unborn = false) {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/repository-boundary-'))
  dirs.push(dir)
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-b', 'trunk')
  git(repo, 'config', 'user.name', 'Fixture')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(repo, 'file'), 'unchanged\n')
  writeFileSync(join(repo, 'other'), 'other\n')
  writeFileSync(join(repo, '.gitignore'), 'ignored\n')
  if (!unborn) {
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'fixture')
  }
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let operation = 0
  const request = async (method: string, params: unknown = {}) =>
    (await core.request(actor, method, params, `fixture-${++operation}`)) as any
  const project = await request('project.register', { path: repo, trust: 'untrusted' })
  const worktree_id = (await request('repository.v1.worktrees', { project_id: project.project_id }))
    .entries[0].worktree_id
  return { dir, repo, core, actor, request, project, worktree_id }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const core of cores.splice(0)) {
    await core.resources.stop()
    core.close()
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
it('represents bare, detached, locked and prunable records without requiring a HEAD for bare repositories', () => {
  expect(
    parseWorktrees(
      Buffer.from(
        'worktree /fixture/bare\0bare\0\0worktree /fixture/linked\0HEAD ' +
          'a'.repeat(40) +
          '\0detached\0locked reason\nwith newline\0prunable missing\0\0'
      )
    )
  ).toMatchObject([
    { path: '/fixture/bare', bare: true, head: '', locked: false },
    { path: '/fixture/linked', detached: true, locked: true, prunable: true },
  ])
})
it('reads unborn worktrees without inventing HEAD or historical attribution', async () => {
  const s = await setup(true),
    p = { worktree_id: s.worktree_id }
  const catalog = await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  expect(catalog.entries[0].head).toBeNull()
  const observation = await s.request('repository.v1.observe', p),
    revision = observation.revision
  expect(revision.head).toBeNull()
  expect(
    (await s.request('repository.v1.tree', { ...p, revision })).entries.map((e: any) => e.path)
  ).toContain('file')
  expect(
    (await s.request('repository.v1.blame', { ...p, revision, path: 'file' })).entries[0].commit
  ).toBeNull()
  expect((await s.request('repository.v1.history', { ...p, revision })).entries).toEqual([])
  await expect(s.request('repository.v1.commit', { ...p, revision })).rejects.toThrow('unborn_head')
  await expect(s.request('repository.v1.resolve', { ...p, ref: 'HEAD' })).rejects.toThrow(
    'git_failed'
  )
})
it('makes ignored-file scans explicit and supports changed-file and wildcard searches', async () => {
  const s = await setup(),
    p = { worktree_id: s.worktree_id }
  writeFileSync(join(s.repo, 'file'), 'changed\n')
  writeFileSync(join(s.repo, 'ignored'), 'private ignored\n')
  const ordinary = (await s.request('repository.v1.observe', p)).revision
  expect(
    (
      await s.request('repository.v1.search', {
        ...p,
        revision: ordinary,
        query: 'private ignored',
      })
    ).entries
  ).toEqual([])
  const explicit = (await s.request('repository.v1.observe', { ...p, include_ignored: true }))
    .revision
  expect(
    (
      await s.request('repository.v1.search', {
        ...p,
        revision: explicit,
        query: 'private ignored',
      })
    ).entries[0].path
  ).toBe('ignored')
  expect(
    (
      await s.request('repository.v1.search', {
        ...p,
        revision: ordinary,
        scope: 'changed',
        query: 'other',
      })
    ).entries
  ).toEqual([])
  expect(
    (
      await s.request('repository.v1.search', {
        ...p,
        revision: ordinary,
        scope: 'changed',
        query: 'changed',
        path_glob: 'f?le',
      })
    ).entries[0].path
  ).toBe('file')
})
it.each([1, 256])(
  'rejects catalogue reads opted out during enumeration (page limit %i)',
  async (limit) => {
    const s = await setup(),
      linked = join(s.dir, 'linked')
    git(s.repo, 'worktree', 'add', '-b', 'private-side', linked)
    await s.request('project.repository_settings', {
      project_id: s.project.project_id,
      external_read: true,
    })
    const run = s.core.resources.git.run.bind(s.core.resources.git)
    let reached!: () => void,
      release!: () => void,
      blocked = false
    const enumerated = new Promise<void>((resolve) => {
      reached = resolve
    })
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.spyOn(s.core.resources.git, 'run').mockImplementation(
      async (cwd, command, before, deadline) => {
        const bytes = await run(cwd, command, before, deadline)
        if (command.kind === 'worktrees' && !blocked) {
          blocked = true
          reached()
          await gate
        }
        return bytes
      }
    )
    const pending = s.request('repository.v1.worktrees', {
      project_id: s.project.project_id,
      limit,
    })
    try {
      await enumerated
      await s.request('project.repository_settings', {
        project_id: s.project.project_id,
        external_read: false,
      })
    } finally {
      release()
    }
    await expect(pending).rejects.toThrow('unauthorized')
    expect((s.core.resources.repository as any).cursors.size).toBe(0)
    expect(
      (
        await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
      ).entries.map((e: any) => e.kind)
    ).toEqual(['root'])
  }
)
it('rechecks catalogue opt-in at the queued publication boundary without denying root-only catalogues', async () => {
  const s = await setup(),
    linked = join(s.dir, 'linked'),
    params = { project_id: s.project.project_id }
  git(s.repo, 'worktree', 'add', '-b', 'private-side', linked)
  const roots = await s.request('repository.v1.worktrees', params)
  const publish = (result: unknown) =>
    s.core.checkPublication(s.actor, 'repository.v1.worktrees', params, result)
  expect(() => publish(roots)).not.toThrow()
  await s.request('project.repository_settings', { ...params, external_read: true })
  const external = await s.request('repository.v1.worktrees', params)
  expect(external.entries.some((entry: any) => entry.kind === 'external')).toBe(true)
  await s.request('project.repository_settings', { ...params, external_read: false })
  expect(() => publish(external)).toThrow('unauthorized')
  expect(() => publish(roots)).not.toThrow()
})
it.each(['commit', 'working'])(
  'applies path globs before the scan budget at a %s revision',
  async (kind) => {
    const s = await setup(),
      worktree_id = s.worktree_id
    for (let i = 0; i < 2048; i++)
      writeFileSync(join(s.repo, `excluded-${String(i).padStart(4, '0')}.txt`), 'excluded match\n')
    writeFileSync(join(s.repo, 'wanted.txt'), 'wanted match\n')
    git(s.repo, 'add', '.')
    git(s.repo, 'commit', '-m', 'search filter fixture')
    const revision =
      kind === 'commit'
        ? await s.request('repository.v1.resolve', { worktree_id, ref: 'HEAD' })
        : (await s.request('repository.v1.observe', { worktree_id })).revision
    const run = vi.spyOn(s.core.resources.git, 'run')
    for (const mode of ['literal', 'regex', 'filename']) {
      run.mockClear()
      const page = await s.request('repository.v1.search', {
        worktree_id,
        revision,
        mode,
        query: mode === 'filename' ? 'wanted.txt' : 'wanted match',
        path_glob: 'wanted.txt',
      })
      expect(page.entries.map((entry: any) => entry.path)).toEqual(['wanted.txt'])
      expect(page.incomplete).toBe(false)
      expect(page.omissions).toEqual([])
      expect(run.mock.calls.filter(([, command]) => command.kind === 'blob')).toHaveLength(
        kind === 'commit' && mode !== 'filename' ? 1 : 0
      )
    }
  }
)
it('expires observations and cursors explicitly, and evicts retained bytes under the global LRU bound', async () => {
  const s = await setup(),
    p = { worktree_id: s.worktree_id }
  const revision = await s.request('repository.v1.resolve', { ...p, ref: 'HEAD' })
  const page = await s.request('repository.v1.tree', { ...p, revision, limit: 1 })
  const working = (await s.request('repository.v1.observe', p)).revision
  const now = Date.now()
  vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000)
  await expect(
    s.request('repository.v1.tree', { ...p, revision, cursor: page.cursor })
  ).rejects.toThrow('stale_cursor')
  await expect(s.request('repository.v1.tree', { ...p, revision: working })).rejects.toThrow(
    'stale_revision'
  )
  vi.restoreAllMocks()
  // Populate old retained bytes directly, then exercise actual retention/eviction through the API.
  s.core.db
    .prepare('INSERT INTO repository_contents VALUES(?,?,?,?)')
    .run(s.worktree_id, 'old', Buffer.alloc(64 * 1024 * 1024), 0)
  const blob = await s.request('repository.v1.blob', { ...p, revision, path: 'file' })
  expect(blob.content_id).toBeTruthy()
  await expect(s.request('repository.v1.content', { ...p, content_id: 'old' })).rejects.toThrow(
    'content_expired'
  )
  const size = (
    s.core.db.prepare('SELECT SUM(length(content)) AS size FROM repository_contents').get() as any
  ).size
  expect(size).toBeLessThanOrEqual(64 * 1024 * 1024)
})
it('invalidates replaced directory identities and prevents authority from surviving opt-out and opt-in', async () => {
  const s = await setup(),
    linked = join(s.dir, 'linked')
  git(s.repo, 'worktree', 'add', '-b', 'side', linked)
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: true,
  })
  const catalog = () => s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  const old = (await catalog()).entries.find((e: any) => e.kind === 'external')
  const p = { worktree_id: old.worktree_id },
    revision = (await s.request('repository.v1.observe', p)).revision
  const blob = await s.request('repository.v1.blob', { ...p, revision, path: 'file' })
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: false,
  })
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: true,
  })
  await expect(s.request('repository.v1.tree', { ...p, revision })).rejects.toThrow(
    'stale_revision'
  )
  await expect(
    s.request('repository.v1.content', { ...p, content_id: blob.content_id })
  ).rejects.toThrow('content_expired')
  const gitfile = readFileSync(join(linked, '.git'))
  renameSync(linked, join(s.dir, 'old-linked'))
  mkdirSync(linked)
  writeFileSync(join(linked, '.git'), gitfile)
  const replaced = (await catalog()).entries.find((e: any) => e.kind === 'external')
  expect(replaced.worktree_id).not.toBe(old.worktree_id)
  await expect(s.request('repository.v1.resolve', { ...p, ref: 'HEAD' })).rejects.toThrow(
    'stale_resource'
  )
})
it('rechecks publication when revocation happens during an otherwise successful repository read', async () => {
  const s = await setup(),
    run = s.core.resources.git.run.bind(s.core.resources.git)
  let revoked = false
  vi.spyOn(s.core.resources.git, 'run').mockImplementation(
    async (cwd, command, before, deadline) => {
      const result = await run(cwd, command, before, deadline)
      if (command.kind === 'blob' && !revoked) {
        revoked = true
        s.core.revokeToken(s.actor.installation_id)
      }
      return result
    }
  )
  const revision = await s.request('repository.v1.resolve', {
    worktree_id: s.worktree_id,
    ref: 'HEAD',
  })
  await expect(
    s.request('repository.v1.blob', { worktree_id: s.worktree_id, revision, path: 'file' })
  ).rejects.toThrow('unauthorized')
})
it('coalesces watcher leases and reports overflow and disappearing worktrees before stopping them', async () => {
  const s = await setup(),
    linked = join(s.dir, 'linked')
  git(s.repo, 'worktree', 'add', '-b', 'side', linked)
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: true,
  })
  const worktree_id = (
    await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  ).entries.find((e: any) => e.kind === 'external').worktree_id
  const repository = s.core.resources.repository as any
  const old = await s.request('repository.v1.watch', { worktree_id })
  const active = await s.request('repository.v1.watch', { worktree_id })
  expect(repository.subscriptions.size).toBe(1)
  expect(repository.subscriptions.has(old.subscription_id)).toBe(false)
  const subscription = repository.subscriptions.get(active.subscription_id)
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      if (predicate()) return
      await new Promise((r) => setTimeout(r, 25))
    }
    throw new Error('watcher boundary deadline')
  }
  subscription.watchers[0].emit('error', new Error('fixture overflow'))
  await wait(() =>
    s.core
      .read('catalog', 0)
      .some((e) => e.type === 'repository.invalidated' && (e.data as any).reason === 'overflow')
  )
  const before = s.core.head('catalog')
  renameSync(linked, join(s.dir, 'moved'))
  await wait(() => s.core.read('catalog', before).some((e) => e.type === 'repository.invalidated'))
  await wait(() => repository.subscriptions.size === 0)
}, 15000)
it('continues byte-bounded blame windows without losing or duplicating lines', async () => {
  const s = await setup(),
    worktree_id = s.worktree_id
  writeFileSync(
    join(s.repo, 'file'),
    Array.from({ length: 600 }, (_v, i) => `${i} ${'x'.repeat(100)}`).join('\n') + '\n'
  )
  git(s.repo, 'commit', '-am', 'blame window')
  const revision = await s.request('repository.v1.resolve', { worktree_id, ref: 'HEAD' })
  const p = { worktree_id, revision, path: 'file', start: 1, count: 600 }
  const first = await s.request('repository.v1.blame', p)
  expect(first.cursor).toBeTruthy()
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(32768)
  const next = await s.request('repository.v1.blame', { ...p, cursor: first.cursor })
  expect(next.entries.length).toBeGreaterThan(0)
  expect(next.entries[0].line).toBe(first.entries.at(-1).line + 1)
})
it('deduplicates registered workspaces independently of the legacy workspace-list page limit', async () => {
  const s = await setup()
  const workspace = (await s.request('workspace.list', { project_id: s.project.project_id }))[0]
  for (let i = 0; i < 260; i++) {
    const workspace_id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`
    const body = { ...workspace, workspace_id, kind: 'managed', path: join(s.dir, workspace_id) }
    s.core.db
      .prepare('INSERT INTO workspaces VALUES(?,?,?,?)')
      .run(workspace_id, s.project.project_id, 'ready', JSON.stringify(body))
  }
  const catalog = await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  expect(catalog.entries).toHaveLength(1)
  expect(catalog.entries[0]).toMatchObject({ kind: 'root', workspace_id: workspace.workspace_id })
})
it('uses one deadline for a multi-command Git read, not a fresh deadline per child', async () => {
  const dir = mkdtempSync(resolve('.scratch/git-budget-'))
  dirs.push(dir)
  const executable = join(dir, 'git-fixture')
  writeFileSync(
    executable,
    `#!${process.execPath}\nsetTimeout(()=>process.stdout.write('ok'),80)\n`,
    { mode: 0o700 }
  )
  const runner = new GitRunner(1000, 1024, executable)
  await expect(
    runner.bounded(150, async () => {
      await runner.run(dir, { kind: 'root' })
      await runner.run(dir, { kind: 'root' })
    })
  ).rejects.toThrow('git_timeout')
})
