import { afterEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, symlinkSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'

const fixtures: { dir: string; core: NodeCore }[] = []
function git(cwd: string, ...args: string[]) {
  const r = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' })
  if (r.status) throw new Error(r.stderr)
  return r.stdout.trim()
}
async function setup(count = 8) {
  const dir = mkdtempSync(resolve('.scratch/repository-perf-'))
  const repo = join(dir, 'repo')
  mkdirSync(join(repo, 'deep'), { recursive: true })
  git(repo, 'init', '-b', 'trunk')
  git(repo, 'config', 'user.name', 'Fixture')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  for (let i = 0; i < count; i++)
    writeFileSync(
      join(repo, 'deep', `f${String(i).padStart(5, '0')}.txt`),
      i === count - 1 ? 'needle\n' : 'plain\n'
    )
  writeFileSync(join(repo, '.gitignore'), 'ignored\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'fixture')
  const core = new NodeCore(join(dir, 'state'))
  fixtures.push({ dir, core })
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let op = 0
  const request = async (method: string, params: unknown = {}) =>
    (await core.request(actor, method, params, 'perf-' + ++op)) as any
  const project = await request('project.register', { path: repo, trust: 'untrusted' })
  const worktree_id = (await request('repository.v1.worktrees', { project_id: project.project_id }))
    .entries[0].worktree_id
  const observe = async () => (await request('repository.v1.observe', { worktree_id })).revision
  return { repo, core, request, worktree_id, observe }
}
afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  for (const { dir, core } of fixtures.splice(0)) {
    await core.resources.stop()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
it('does not enumerate the repository or rebuild its snapshot for warm tree/blob/content reads', async () => {
  const s = await setup()
  const revision = await s.observe()
  const run = vi.spyOn(s.core.resources.git, 'run')
  const state = vi.spyOn(s.core.resources.repository as any, 'workingState')
  const p = { worktree_id: s.worktree_id, revision }
  await s.request('repository.v1.tree', p)
  await s.request('repository.v1.tree', { ...p, path: 'deep', limit: 2 })
  const blob = await s.request('repository.v1.blob', { ...p, path: 'deep/f00000.txt' })
  await s.request('repository.v1.content', {
    worktree_id: s.worktree_id,
    content_id: blob.content_id,
  })
  expect(
    run.mock.calls.filter(([, c]) =>
      ['tracked', 'status', 'untracked', 'visible.untracked'].includes(c.kind)
    )
  ).toEqual([])
  expect(state).not.toHaveBeenCalled()
  await s.observe()
  expect(
    run.mock.calls.filter(([, c]) =>
      ['tracked', 'status', 'untracked', 'visible.untracked'].includes(c.kind)
    )
  ).toEqual([])
})
it('browses and pages a 10,500-file worktree and finds content beyond the old 2048-file ceiling', async () => {
  const s = await setup(10500)
  const p = { worktree_id: s.worktree_id, revision: await s.observe() }
  expect((await s.request('repository.v1.tree', p)).entries.map((e: any) => e.path)).toContain(
    'deep'
  )
  let page = await s.request('repository.v1.tree', { ...p, path: 'deep', limit: 256 })
  let count = page.entries.length
  while (page.cursor) {
    page = await s.request('repository.v1.tree', {
      ...p,
      path: 'deep',
      limit: 256,
      cursor: page.cursor,
    })
    count += page.entries.length
  }
  expect(count).toBe(10500)
  const search = { ...p, query: 'needle' }
  page = await s.request('repository.v1.search', search)
  const found = [...page.entries]
  while (page.cursor) {
    page = await s.request('repository.v1.search', { ...search, cursor: page.cursor })
    found.push(...page.entries)
  }
  expect(found.map((e: any) => e.path)).toEqual(['deep/f10499.txt'])
})
it.each([
  'custom-relative',
  'custom-external',
  'custom-symlink',
  'custom-tilde',
  'default-global',
  'info-exclude',
  'root',
  'nested',
  'included-config',
  'included-missing',
  'worktree-config',
  'reconfigured',
])('invalidates effective ignore sources edited in place (%s)', async (kind) => {
  const s = await setup()
  const path = 'deep/private.txt'
  writeFileSync(join(s.repo, path), 'private\n')
  let source: string
  if (kind === 'nested') source = join(s.repo, 'deep/.gitignore')
  else if (kind === 'root') source = join(s.repo, '.gitignore')
  else if (kind === 'info-exclude') source = join(s.repo, '.git/info/exclude')
  else if (kind === 'custom-symlink') {
    const target = join(s.repo, '..', 'external-excludes')
    writeFileSync(target, '')
    source = join(s.repo, '.git/info/custom-excludes')
    symlinkSync(target, source)
    git(s.repo, 'config', 'core.excludesFile', source)
  } else if (kind === 'custom-tilde') {
    vi.stubEnv('HOME', resolve(s.repo, '..'))
    source = join(s.repo, '..', 'tilde-excludes')
    git(s.repo, 'config', 'core.excludesFile', '~/tilde-excludes')
  } else if (kind === 'default-global') {
    const xdg = join(s.repo, '..', 'xdg')
    mkdirSync(join(xdg, 'git'), { recursive: true })
    vi.stubEnv('XDG_CONFIG_HOME', xdg)
    source = join(xdg, 'git/ignore')
  } else if (kind === 'custom-relative') {
    source = join(s.repo, '.git/info/custom-excludes')
    git(s.repo, 'config', 'core.excludesFile', '.git/info/custom-excludes')
  } else {
    source = join(s.repo, '..', 'external-excludes')
    if (kind === 'included-config' || kind === 'included-missing') {
      if (kind === 'included-config') writeFileSync(source, '')
      git(s.repo, 'config', 'include.path', source)
    } else if (kind === 'worktree-config') {
      git(s.repo, 'config', 'extensions.worktreeConfig', 'true')
      git(s.repo, 'config', '--worktree', 'core.excludesFile', source)
    } else if (kind !== 'reconfigured') git(s.repo, 'config', 'core.excludesFile', source)
  }
  if (kind !== 'included-missing') writeFileSync(source, '')
  const revision = await s.observe()
  const p = { worktree_id: s.worktree_id, revision }
  await s.request('repository.v1.blob', { ...p, path })
  const monitor = (s.core.resources.repository as any).monitors.get(s.worktree_id)
  vi.spyOn(monitor, 'changed').mockImplementation(() => {})
  if (kind === 'included-config' || kind === 'included-missing')
    writeFileSync(source, '[core]\n excludesFile = ' + join(s.repo, '..', 'rules') + '\n')
  if (kind === 'included-config' || kind === 'included-missing')
    writeFileSync(join(s.repo, '..', 'rules'), 'private.txt\n')
  else writeFileSync(source, 'private.txt\n')
  if (kind === 'reconfigured') git(s.repo, 'config', 'core.excludesFile', source)
  // No wait for watcher delivery: metadata signatures must fence the next read.
  await expect(s.request('repository.v1.tree', { ...p, path: 'deep' })).rejects.toThrow(
    'stale_revision'
  )
  await expect(s.request('repository.v1.blob', { ...p, path })).rejects.toThrow('stale_revision')
  const fresh = await s.observe()
  const tree = await s.request('repository.v1.tree', { ...p, revision: fresh, path: 'deep' })
  expect(tree.entries.map((entry: any) => entry.path)).not.toContain(path)
  await expect(s.request('repository.v1.blob', { ...p, revision: fresh, path })).rejects.toThrow(
    'unsafe_path'
  )
  const allowed = (
    await s.request('repository.v1.observe', { worktree_id: s.worktree_id, include_ignored: true })
  ).revision
  expect(
    (await s.request('repository.v1.blob', { ...p, revision: allowed, path })).content_id
  ).toBeTruthy()
})
it.each(['status', 'search'])(
  'fences nested ignore edits before returning %s paths without a filesystem hint',
  async (method) => {
    const s = await setup()
    const source = join(s.repo, 'deep/.gitignore')
    writeFileSync(source, '')
    writeFileSync(join(s.repo, 'deep/private.txt'), 'private\n')
    const p = { worktree_id: s.worktree_id, revision: await s.observe() }
    const monitor = (s.core.resources.repository as any).monitors.get(s.worktree_id)
    vi.spyOn(monitor, 'changed').mockImplementation(() => {})
    writeFileSync(source, 'private.txt\n')
    await expect(
      s.request('repository.v1.' + method, {
        ...p,
        ...(method === 'search'
          ? { mode: 'filename', query: 'private', path_glob: 'deep/private.txt' }
          : {}),
      })
    ).rejects.toThrow('stale_revision')
  }
)
it('refreshes exclude dependencies when an onbranch config include becomes effective', async () => {
  const s = await setup()
  const config = join(s.repo, '..', 'side-config')
  const rules = join(s.repo, '..', 'side-rules')
  writeFileSync(config, '[core]\n excludesFile = ' + rules + '\n')
  writeFileSync(rules, '')
  writeFileSync(join(s.repo, 'deep/private.txt'), 'private\n')
  git(s.repo, 'config', 'includeIf.onbranch:side.path', config)
  await s.observe()
  git(s.repo, 'checkout', '-b', 'side')
  const p = { worktree_id: s.worktree_id, revision: await s.observe() }
  await s.request('repository.v1.blob', { ...p, path: 'deep/private.txt' })
  const monitor = (s.core.resources.repository as any).monitors.get(s.worktree_id)
  vi.spyOn(monitor, 'changed').mockImplementation(() => {})
  writeFileSync(rules, 'private.txt\n')
  await expect(s.request('repository.v1.blob', { ...p, path: 'deep/private.txt' })).rejects.toThrow(
    'stale_revision'
  )
  const fresh = await s.observe()
  await expect(
    s.request('repository.v1.blob', { ...p, revision: fresh, path: 'deep/private.txt' })
  ).rejects.toThrow('unsafe_path')
})
it('does not admit an index whose ignore rules changed during path enumeration', async () => {
  const s = await setup()
  const source = join(s.repo, 'deep/.gitignore')
  writeFileSync(source, '')
  writeFileSync(join(s.repo, 'deep/private.txt'), 'private\n')
  await s.observe()
  const monitor = (s.core.resources.repository as any).monitors.get(s.worktree_id)
  vi.spyOn(monitor, 'changed').mockImplementation(() => {})
  monitor.generation++
  const records = s.core.resources.git.records.bind(s.core.resources.git)
  let changed = false
  vi.spyOn(s.core.resources.git, 'records').mockImplementation(async (cwd, command, consume) => {
    await records(cwd, command, consume)
    if (command.kind === 'visible.untracked' && !changed) {
      changed = true
      writeFileSync(source, 'private.txt\n')
    }
  })
  const p = { worktree_id: s.worktree_id, revision: await s.observe() }
  const tree = await s.request('repository.v1.tree', { ...p, path: 'deep' })
  expect(tree.entries.map((entry: any) => entry.path)).not.toContain('deep/private.txt')
  await expect(s.request('repository.v1.blob', { ...p, path: 'deep/private.txt' })).rejects.toThrow(
    'unsafe_path'
  )
})
it('keeps deleted-path status and an empty tree usable when ignore files are themselves ignored', async () => {
  const s = await setup()
  git(s.repo, 'rm', '-rf', '.')
  writeFileSync(join(s.repo, '.gitignore'), '*\n')
  const p = { worktree_id: s.worktree_id, revision: await s.observe() }
  expect((await s.request('repository.v1.tree', p)).entries).toEqual([])
  const status = await s.request('repository.v1.status', p)
  expect(status.entries).toHaveLength(9)
  expect(status.entries.every((entry: any) => entry.index === 'D')).toBe(true)
})
it('rejects a genuinely oversized observation before publishing a revision', async () => {
  const s = await setup()
  const service = s.core.resources.repository as any
  const original = service.changeDetails.bind(service)
  vi.spyOn(service, 'changeDetails').mockImplementation(async (...args: any[]) => {
    const rows = await original(...args)
    return [...rows, { path: 'x'.repeat(8 * 1024 * 1024), index: '?', worktree: '?' }]
  })
  await expect(s.observe()).rejects.toThrow('scan_limit')
  expect(service.observations.size).toBe(0)
})
it('reconciles fresh observations when a tracked edit precedes filesystem delivery', async () => {
  const s = await setup()
  await s.observe()
  const monitor = (s.core.resources.repository as any).monitors.get(s.worktree_id)
  vi.spyOn(monitor, 'changed').mockImplementation(() => {})
  writeFileSync(join(s.repo, 'deep/f00000.txt'), 'new snapshot\n')
  const p = { worktree_id: s.worktree_id, revision: await s.observe() }
  const blob = await s.request('repository.v1.blob', { ...p, path: 'deep/f00000.txt' })
  const content = await s.request('repository.v1.content', {
    worktree_id: s.worktree_id,
    content_id: blob.content_id,
  })
  expect(Buffer.from(content.base64, 'base64').toString()).toBe('new snapshot\n')
})
it('rejects same-path edits immediately and unrelated nested edits after filesystem delivery', async () => {
  const s = await setup()
  const p = { worktree_id: s.worktree_id, revision: await s.observe() }
  writeFileSync(join(s.repo, 'deep/f00000.txt'), 'edited\n')
  await expect(s.request('repository.v1.blob', { ...p, path: 'deep/f00000.txt' })).rejects.toThrow(
    'stale_revision'
  )
  const revision = await s.observe()
  const fresh = await s.request('repository.v1.blob', { ...p, revision, path: 'deep/f00000.txt' })
  const content = await s.request('repository.v1.content', {
    worktree_id: s.worktree_id,
    content_id: fresh.content_id,
  })
  expect(Buffer.from(content.base64, 'base64').toString()).toBe('edited\n')
  const monitor = (s.core.resources.repository as any).monitors.get(s.worktree_id)
  const generation = monitor.generation
  writeFileSync(join(s.repo, 'deep/f00007.txt'), 'other\n')
  // FSEvents delivery is asynchronous; wait for the actual hint, not an assumed latency.
  await vi.waitFor(() => expect(monitor.generation).toBeGreaterThan(generation), { timeout: 2000 })
  await expect(
    s.request('repository.v1.blob', { ...p, revision, path: 'deep/f00000.txt' })
  ).rejects.toThrow('stale_revision')
})
it('normalizes macOS root-self hints without hiding deletion of a same-named child', async () => {
  const s = await setup()
  await s.observe()
  const monitor = (s.core.resources.repository as any).monitors.get(s.worktree_id)
  const generation = monitor.generation
  monitor.changed(s.repo, 'repo')
  expect(monitor.generation).toBe(generation)
  writeFileSync(join(s.repo, 'repo'), 'child\n')
  await s.observe()
  const captured = monitor.generation
  rmSync(join(s.repo, 'repo'))
  monitor.changed(s.repo, 'repo')
  expect(monitor.generation).toBeGreaterThan(captured)
})
it.each(['ignore', 'content'])(
  'fences cached working blame continuations after a nested %s edit without a hint',
  async (change) => {
    const s = await setup()
    const path = 'deep/private.txt'
    const rules = join(s.repo, 'deep/.gitignore')
    writeFileSync(rules, '')
    writeFileSync(
      join(s.repo, path),
      Array.from({ length: 500 }, (_, i) => `line-${i} ${'x'.repeat(150)}`).join('\n') + '\n'
    )
    const p = { worktree_id: s.worktree_id, revision: await s.observe(), path, count: 500 }
    const first = await s.request('repository.v1.blame', p)
    expect(first.cursor).toBeTruthy()
    const run = vi.spyOn(s.core.resources.git, 'run')
    const second = await s.request('repository.v1.blame', { ...p, cursor: first.cursor })
    expect(second.entries[0].line).toBe(first.entries.length + 1)
    expect(run.mock.calls.filter(([, command]) => command.kind === 'blame')).toEqual([])
    const monitor = (s.core.resources.repository as any).monitors.get(s.worktree_id)
    vi.spyOn(monitor, 'changed').mockImplementation(() => {})
    if (change === 'ignore') writeFileSync(rules, 'private.txt\n')
    else writeFileSync(join(s.repo, path), 'changed\n')
    await expect(s.request('repository.v1.blame', { ...p, cursor: first.cursor })).rejects.toThrow(
      'stale_revision'
    )
  }
)
it('rechecks working blame visibility after retrieving a cached continuation', async () => {
  const s = await setup()
  const rules = join(s.repo, 'deep/.gitignore')
  writeFileSync(rules, '')
  writeFileSync(join(s.repo, 'deep/private.txt'), ('x'.repeat(150) + '\n').repeat(500))
  const p = {
    worktree_id: s.worktree_id,
    revision: await s.observe(),
    path: 'deep/private.txt',
    count: 500,
  }
  const first = await s.request('repository.v1.blame', p)
  expect(first.cursor).toBeTruthy()
  const service = s.core.resources.repository as any
  vi.spyOn(service.monitors.get(s.worktree_id), 'changed').mockImplementation(() => {})
  const continuation = service.continuation.bind(service)
  vi.spyOn(service, 'continuation').mockImplementation((...args: any[]) => {
    const result = continuation(...args)
    if (args[1] === 'repository.v1.blame' && args[2].cursor) writeFileSync(rules, 'private.txt\n')
    return result
  })
  await expect(s.request('repository.v1.blame', { ...p, cursor: first.cursor })).rejects.toThrow(
    'stale_revision'
  )
})
it('rejects a parent symlink swap before serving cached working blame lines', async () => {
  const s = await setup()
  const folder = join(s.repo, 'deep/nested')
  mkdirSync(folder)
  writeFileSync(join(folder, 'private.txt'), ('x'.repeat(150) + '\n').repeat(500))
  const p = {
    worktree_id: s.worktree_id,
    revision: await s.observe(),
    path: 'deep/nested/private.txt',
    count: 500,
  }
  const first = await s.request('repository.v1.blame', p)
  expect(first.cursor).toBeTruthy()
  const monitor = (s.core.resources.repository as any).monitors.get(s.worktree_id)
  vi.spyOn(monitor, 'changed').mockImplementation(() => {})
  const moved = join(s.repo, 'deep/moved')
  renameSync(folder, moved)
  symlinkSync(moved, folder)
  await expect(s.request('repository.v1.blame', { ...p, cursor: first.cursor })).rejects.toThrow(
    'unsafe_path'
  )
})
it('keeps frozen commit blame continuations usable after a working ignore edit', async () => {
  const s = await setup()
  writeFileSync(join(s.repo, 'deep/f00000.txt'), ('x'.repeat(150) + '\n').repeat(500))
  git(s.repo, 'commit', '-am', 'long blame')
  const revision = await s.request('repository.v1.resolve', {
    worktree_id: s.worktree_id,
    ref: 'HEAD',
  })
  const p = { worktree_id: s.worktree_id, revision, path: 'deep/f00000.txt', count: 500 }
  const first = await s.request('repository.v1.blame', p)
  expect(first.cursor).toBeTruthy()
  writeFileSync(join(s.repo, 'deep/.gitignore'), '*\n')
  const second = await s.request('repository.v1.blame', { ...p, cursor: first.cursor })
  expect(second.content_id).toBe(first.content_id)
  expect(second.entries[0].line).toBe(first.entries.length + 1)
})
it('restores the charged baseline after conservative recapture returns the same cached snapshot', async () => {
  const s = await setup()
  await s.observe()
  const service = s.core.resources.repository as any
  const state = service.snapshots.get(s.worktree_id + ':false')
  state.monitor.reliable = false
  await s.observe()
  expect(state.monitor.baseline).toBe(state.stamps)
  expect(state.monitor.ignoreBaseline).toBe(state.ignoreStamps)
})
it('does not retain a baseline from an oversized rejected capture', async () => {
  const s = await setup()
  const service = s.core.resources.repository as any
  const size = service.retainedSizes.get.bind(service.retainedSizes)
  vi.spyOn(service.retainedSizes, 'get').mockImplementation((value: any) =>
    Array.isArray(value) && value.some((entry) => entry?.path === 'deep/f00000.txt')
      ? 33 * 1024 * 1024
      : size(value)
  )
  await expect(s.observe()).rejects.toThrow('scan_limit')
  const monitor = service.monitors.get(s.worktree_id)
  expect(monitor.baseline.size).toBe(0)
  expect(monitor.ignoreBaseline.size).toBe(0)
  expect(service.observations.size).toBe(0)
})
it('shares charged stamp maps and reattaches the baseline when a sibling visibility snapshot survives', async () => {
  const s = await setup()
  const revision = await s.observe()
  const service = s.core.resources.repository as any
  const first = service.snapshots.get(s.worktree_id + ':false')
  await s.request('repository.v1.observe', { worktree_id: s.worktree_id, include_ignored: true })
  const second = service.snapshots.get(s.worktree_id + ':true')
  const monitor = second.monitor
  expect(monitor.baseline).toBe(second.stamps)
  expect(monitor.ignoreBaseline).toBe(second.ignoreStamps)
  service.evictSnapshot(second)
  expect(monitor.baseline).toBe(first.stamps)
  expect(monitor.ignoreBaseline).toBe(first.ignoreStamps)
  expect(
    (await s.request('repository.v1.tree', { worktree_id: s.worktree_id, revision })).entries.length
  ).toBeGreaterThan(0)
})
it('releases the monitor baseline after its last snapshot is evicted and does not regrow it from hints', async () => {
  const s = await setup()
  await s.observe()
  const service = s.core.resources.repository as any
  const state = service.snapshots.get(s.worktree_id + ':false')
  const monitor = state.monitor
  expect(monitor.baseline.size).toBeGreaterThan(0)
  service.evictSnapshot(state)
  expect(monitor.baseline.size).toBe(0)
  monitor.changed(s.repo, 'deep/f00000.txt')
  expect(monitor.baseline.size).toBe(0)
  const fresh = await s.observe()
  expect(
    (await s.request('repository.v1.tree', { worktree_id: s.worktree_id, revision: fresh })).entries
      .length
  ).toBeGreaterThan(0)
})
it('returns a resumable hostile-regex deadline well before the client five-second timeout', async () => {
  const s = await setup()
  writeFileSync(join(s.repo, 'attack'), 'a'.repeat(64000) + '!')
  const revision = await s.observe()
  const start = performance.now()
  const result = await s.request('repository.v1.search', {
    worktree_id: s.worktree_id,
    revision,
    query: '(a+)+$',
    mode: 'regex',
    path_glob: 'attack',
  })
  expect(result.incomplete).toBe(true)
  expect(result.omissions.join(' ')).toContain('deadline')
  expect(result.cursor).toBeTruthy()
  expect(performance.now() - start).toBeLessThan(2000)
})
it('invalidates the index, ignores newly ignored paths, and never follows a replaced directory link', async () => {
  const s = await setup()
  writeFileSync(join(s.repo, 'deep/untracked.txt'), 'untracked\n')
  const revision = await s.observe()
  const deep = await s.request('repository.v1.tree', {
    worktree_id: s.worktree_id,
    revision,
    path: 'deep',
  })
  expect(deep.entries.map((entry: any) => entry.path)).toContain('deep/untracked.txt')
  writeFileSync(join(s.repo, 'deep/new.txt'), 'new\n')
  git(s.repo, 'add', 'deep/new.txt')
  await expect(
    s.request('repository.v1.tree', { worktree_id: s.worktree_id, revision })
  ).rejects.toThrow('stale_revision')
  writeFileSync(join(s.repo, 'ignored'), 'secret\n')
  const next = await s.observe()
  await expect(
    s.request('repository.v1.blob', { worktree_id: s.worktree_id, revision: next, path: 'ignored' })
  ).rejects.toThrow('unsafe_path')
  rmSync(join(s.repo, 'deep'), { recursive: true })
  symlinkSync(s.repo, join(s.repo, 'deep'))
  await expect(
    s.request('repository.v1.blob', {
      worktree_id: s.worktree_id,
      revision: next,
      path: 'deep/f00000.txt',
    })
  ).rejects.toThrow()
})
// Keep the high-churn fixture last so its teardown cannot flood a subsequent
// small fixture's macOS FSEvents delivery. The fixture and assertions stay real.
it('keeps freshly issued observations and tree cursors usable for 75,000 short tracked paths', async () => {
  const s = await setup(75000)
  const p = { worktree_id: s.worktree_id, revision: await s.observe() }
  const root = await s.request('repository.v1.tree', p)
  expect(root.entries.map((entry: any) => entry.path)).toContain('deep')
  const first = await s.request('repository.v1.tree', { ...p, path: 'deep', limit: 2 })
  expect(first.cursor).toBeTruthy()
  const second = await s.request('repository.v1.tree', {
    ...p,
    path: 'deep',
    limit: 2,
    cursor: first.cursor,
  })
  expect(second.entries.map((entry: any) => entry.path)).toEqual([
    'deep/f00002.txt',
    'deep/f00003.txt',
  ])
  expect(
    (await s.request('repository.v1.blob', { ...p, path: 'deep/f74999.txt' })).content_id
  ).toBeTruthy()
  const again = { ...p, revision: await s.observe() }
  expect((await s.request('repository.v1.tree', again)).entries).toEqual(root.entries)
  expect((await s.request('repository.v1.tree', p)).entries).toEqual(root.entries)
  // Two visibility variants exceed the shared index budget together. Evict the
  // older index/leases, not the newly issued include_ignored observation.
  const allowed = (
    await s.request('repository.v1.observe', { worktree_id: s.worktree_id, include_ignored: true })
  ).revision
  const next = { ...p, revision: allowed }
  expect((await s.request('repository.v1.tree', next)).entries).toEqual(root.entries)
  expect(
    (await s.request('repository.v1.blob', { ...next, path: 'deep/f74999.txt' })).content_id
  ).toBeTruthy()
}, 60000)
