import { afterEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { AsyncLocalStorage } from 'node:async_hooks'
import { EventEmitter } from 'node:events'
import { closeRepositoryFixtures } from './helpers/close-repository-fixtures.js'
import { watch } from 'node:fs'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
import { existsSync } from 'node:fs'
import { RepositoryClient } from '../packages/node-client/src/repository.js'
import { diffBaselines, type ChangeBaseline } from '../packages/node-core/src/repository-changes.js'
import {
  RepositoryChangeBatchSchema,
  RepositoryMethodSchemas,
  RepositoryWatchSchema,
  NodeEventSchema,
} from '../packages/node-protocol/src/index.js'

const dirs: string[] = [],
  cores: NodeCore[] = []
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs, watch: vi.fn(fs.watch) }
})
const gitExecutable = existsSync('/Library/Developer/CommandLineTools/usr/bin/git')
  ? '/Library/Developer/CommandLineTools/usr/bin/git'
  : '/usr/bin/git'
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync(gitExecutable, args, { cwd, encoding: 'utf8' })
  if (r.status) throw new Error(r.stderr)
  return r.stdout.trim()
}
async function setup() {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/repository-changes-'))
  dirs.push(dir)
  const repo = join(dir, 'repo'),
    linked = join(dir, 'linked')
  mkdirSync(join(repo, 'src'), { recursive: true })
  git(repo, 'init', '-b', 'trunk')
  git(repo, 'config', 'user.name', 'Fixture')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(repo, 'file'), 'before\n')
  writeFileSync(join(repo, 'src', 'sample.ts'), 'export {}\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'fixture')
  git(repo, 'worktree', 'add', '-b', 'side', linked)
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  Object.defineProperty(core.resources.git, 'executable', { value: gitExecutable })
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let operation = 0
  const request = async (method: string, params: unknown = {}, id?: string) =>
    (await core.request(
      actor,
      method,
      method === 'repository.v1.watch' ? { ...(params as object), explicit_renewal: true } : params,
      id ?? `fixture-${++operation}`
    )) as any
  const project = await request('project.register', { path: repo, trust: 'untrusted' })
  await request('project.repository_settings', {
    project_id: project.project_id,
    external_read: true,
  })
  const entries = (await request('repository.v1.worktrees', { project_id: project.project_id }))
    .entries
  const root = entries.find((e: any) => e.kind === 'root').worktree_id
  const external = entries.find((e: any) => e.kind === 'external').worktree_id
  const batches = (after: number) =>
    core
      .read('catalog', after)
      .filter((e) => e.type === 'repository.changed')
      .map((e) => e.data as any)
  return { dir, repo, linked, core, actor, request, project, root, external, batches }
}
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(watch).mockReset()
  await closeRepositoryFixtures(cores, dirs)
}, 60000)
// A batch follows a hint within one reconciliation, which a slow machine may stretch to its
// whole 15 s git budget, plus the 2 s reconciliation tick; a lost batch still fails here.
async function wait(predicate: () => boolean) {
  const end = Date.now() + 20000
  while (!predicate()) {
    if (Date.now() > end) throw new Error('change stream deadline')
    await new Promise((r) => setTimeout(r, 20))
  }
}
const entry = (path: string, kind: 'file' | 'directory', size: number | null = 1) => ({
  path,
  name: path.split('/').at(-1)!,
  kind,
  oid: null,
  size: kind === 'directory' ? null : size,
})

it.each([false, true])(
  'delivers immediate nested edits to independent leases within a second (lost hints: %s)',
  async (lostHints) => {
    if (lostHints)
      vi.mocked(watch).mockImplementation(() => {
        const watcher = new EventEmitter()
        return Object.assign(watcher, { close() {} }) as ReturnType<typeof watch>
      })
    const s = await setup()
    const a = new RepositoryClient(s.request),
      b = new RepositoryClient(s.request)
    let first = await a.watch({ worktree_id: s.root, changes: null })
    const second = await b.watch({ worktree_id: s.root, changes: null })
    const repository = s.core.resources.repository as any
    const latencies: number[] = []
    for (let i = 0; i < 4; i++) {
      if (i)
        first = await a.watch({
          worktree_id: s.root,
          subscription_id: first.subscription_id,
          changes: { stream_id: first.changes!.stream_id, revision: i },
        })
      // Also exercise a quiet, already-armed lease after its initial reconciliation.
      if (i % 2) await new Promise((resolve) => setTimeout(resolve, 350))
      const before = s.core.head('catalog'),
        started = performance.now()
      writeFileSync(join(s.repo, 'src', 'sample.ts'), `edit ${i}\n`)
      await wait(
        () =>
          s
            .batches(before)
            .some((batch) =>
              batch.entries?.some(
                (row: any) => row.change === 'modified' && row.entry.path === 'src/sample.ts'
              )
            ) || performance.now() - started > 1200
      )
      const elapsed = performance.now() - started
      latencies.push(elapsed)
      expect(s.batches(before), `delivery latency ${elapsed.toFixed(1)} ms`).toHaveLength(1)
      expect(elapsed).toBeLessThan(1000)
      expect(repository.subscriptions.has(first.subscription_id)).toBe(true)
      expect(repository.subscriptions.has(second.subscription_id)).toBe(true)
    }
    console.info('repository watch delivery ms', { lostHints, latencies })
  },
  60000
)
function baseline(
  rows: [string, 'file' | 'directory', string, number?][],
  extra: Partial<ChangeBaseline> = {}
): ChangeBaseline {
  return {
    entries: new Map(
      rows.map(([path, kind, identity, size]) => [
        path,
        { entry: entry(path, kind, size ?? 1), identity, signature: `${identity}:${size ?? 1}` },
      ])
    ),
    status: new Map(),
    head: null,
    branch: 'trunk',
    detached: false,
    ...extra,
  }
}

it('shares native watch handles across acquisition and legacy renewal until the last lease closes', async () => {
  vi.mocked(watch).mockImplementation((...args) => {
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn() })
    const listener = args.at(-1)
    if (typeof listener === 'function') watcher.on('change', listener)
    return watcher as unknown as ReturnType<typeof watch>
  })
  const s = await setup()
  const first = await s.request('repository.v1.watch', { worktree_id: s.root, changes: null })
  const repository = s.core.resources.repository as any
  const handles = [...repository.subscriptions.get(first.subscription_id).watchers]
  const allocated = vi.mocked(watch).mock.calls.length
  const legacy = s.core.authority.authenticate(s.core.createToken('legacy').token)
  let renewed: any
  for (let i = 0; i < 5; i++)
    renewed = await s.core.request(
      legacy,
      'repository.v1.watch',
      {
        worktree_id: s.root,
        changes: null,
      },
      'shared-' + i
    )
  expect(vi.mocked(watch).mock.calls.length).toBe(allocated)
  for (const handle of handles) expect(handle.close).not.toHaveBeenCalled()
  await s.request('repository.v1.unwatch', {
    worktree_id: s.root,
    subscription_id: first.subscription_id,
  })
  for (const handle of handles) expect(handle.close).not.toHaveBeenCalled()
  // The remaining lease also transfers ownership across a renewal on its own.
  renewed = await s.core.request(
    legacy,
    'repository.v1.watch',
    { worktree_id: s.root, changes: null },
    'shared-last'
  )
  expect(vi.mocked(watch).mock.calls.length).toBe(allocated)
  const scheduling = vi.spyOn(repository.subscriptions.get(renewed.subscription_id), 'schedule')
  handles[0].emit('change', 'change', 'file')
  expect(scheduling).toHaveBeenCalledTimes(1)
  await s.core.request(
    legacy,
    'repository.v1.unwatch',
    {
      worktree_id: s.root,
      subscription_id: renewed.subscription_id,
    },
    'shared-stop'
  )
  for (const handle of handles) expect(handle.close).toHaveBeenCalledTimes(1)
})

it('replaces 50 legacy renewals without stealing an explicit lease', async () => {
  const s = await setup(),
    repository = s.core.resources.repository as any
  let modern = await s.request('repository.v1.watch', { worktree_id: s.root, changes: null })
  modern = await s.request('repository.v1.watch', {
    worktree_id: s.root,
    changes: null,
    subscription_id: modern.subscription_id,
  })
  const legacy = s.core.authority.authenticate(s.core.createToken('legacy').token)
  // Leave one slot for the old plugin; renewals must work even at capacity.
  for (let i = 0; i < 14; i++)
    await s.request('repository.v1.watch', { worktree_id: s.root, changes: null })
  for (let i = 0; i < 50; i++) {
    await s.core.request(
      legacy,
      'repository.v1.watch',
      {
        worktree_id: s.root,
        changes: null,
      },
      'legacy-' + i
    )
    expect(repository.subscriptions.size).toBe(16)
    expect(
      [...repository.subscriptions.values()].filter(
        (lease: any) => lease.owner.installation_id === legacy.installation_id
      )
    ).toHaveLength(1)
    expect(repository.subscriptions.has(modern.subscription_id)).toBe(true)
  }
  const before = s.core.head('catalog')
  writeFileSync(join(s.repo, 'file'), 'legacy edit')
  await wait(() => s.batches(before).length >= 2)
  const events = s.core.read('catalog', before).filter((e) => e.type === 'repository.changed')
  expect(new Set(events.map((e) => JSON.stringify(e.actor))).size).toBe(2)
}, 60000)

it('protects a legacy lease once its caller uses explicit renewal', async () => {
  const s = await setup(),
    repository = s.core.resources.repository as any
  const call = (params: object) =>
    repository.request(s.actor, 'repository.v1.watch', {
      worktree_id: s.root,
      ...params,
    })
  const initial = await call({})
  const renewed = await call({ subscription_id: initial.subscription_id })
  await call({})
  await call({})
  expect(repository.subscriptions.has(renewed.subscription_id)).toBe(true)
  expect(repository.subscriptions.size).toBe(3)
})

it('retains consumer A when B stops and reads a same-size dirty edit', async () => {
  const s = await setup()
  writeFileSync(join(s.repo, 'file'), 'stage1\n')
  git(s.repo, 'add', 'file')
  writeFileSync(join(s.repo, 'file'), 'dirty3\n')
  const a = new RepositoryClient(s.request),
    b = new RepositoryClient(s.request)
  const first = await a.watch({ worktree_id: s.root, changes: null })
  const second = await b.watch({ worktree_id: s.root, changes: null })
  await b.unwatch({ worktree_id: s.root, subscription_id: second.subscription_id })
  expect((s.core.resources.repository as any).subscriptions.has(first.subscription_id)).toBe(true)
  const before = s.core.head('catalog')
  writeFileSync(join(s.repo, 'file'), 'dirty4\n')
  await wait(() => s.batches(before).length > 0)
  expect(RepositoryChangeBatchSchema.safeParse(s.batches(before)[0]).success).toBe(true)
  const observation = await a.observe({ worktree_id: s.root })
  const blob = await a.blob({ worktree_id: s.root, revision: observation.revision, path: 'file' })
  const content = await a.content({ worktree_id: s.root, content_id: blob.content_id! })
  expect(Buffer.from(content.base64, 'base64').toString()).toBe('dirty4\n')
}, 60000)

it('isolates failed acquisition and renewal and rejects foreign or missing renewal IDs', async () => {
  const s = await setup(),
    repository = s.core.resources.repository as any
  expect(s.core.discovery().supported_capabilities).toContain('repository_watch_renewal_v1')
  const a = await s.request('repository.v1.watch', { worktree_id: s.root, changes: null })
  const b = await s.request('repository.v1.watch', { worktree_id: s.root })
  const other = s.core.authority.authenticate(s.core.createToken('other').token)
  for (let attempt = 0; attempt < 10; attempt++) {
    await expect(
      s.core.request(
        other,
        'repository.v1.watch',
        {
          worktree_id: s.root,
          subscription_id: a.subscription_id,
        },
        `foreign-renewal-${attempt}`
      )
    ).rejects.toThrow('unauthorized')
    await expect(
      s.request('repository.v1.watch', {
        worktree_id: s.external,
        subscription_id: a.subscription_id,
      })
    ).rejects.toThrow('unauthorized')
    await expect(
      s.request('repository.v1.watch', {
        worktree_id: s.root,
        subscription_id: 'missing',
      })
    ).rejects.toThrow('unauthorized')
  }
  // watchFingerprint is shared with background reconciliation. A one-shot mock can
  // be consumed by a watcher instead of the request whose failure we are testing.
  const failure = new AsyncLocalStorage<Error>()
  const original = repository.watchFingerprint.bind(repository)
  const fingerprint = vi.spyOn(repository, 'watchFingerprint').mockImplementation((target) => {
    const error = failure.getStore()
    return error ? Promise.reject(error) : original(target)
  })
  for (let attempt = 0; attempt < 10; attempt++) {
    const calls = fingerprint.mock.calls.length
    repository.subscriptions
      .get(a.subscription_id)
      .watchers[0].emit('error', new Error('fixture hint'))
    await wait(() => fingerprint.mock.calls.length > calls)
    const error = new Error('fixture acquisition')
    await expect(
      failure.run(error, () =>
        s.request('repository.v1.watch', {
          worktree_id: s.root,
        })
      )
    ).rejects.toBe(error)
    expect(repository.subscriptions.size).toBe(2)
  }
  const error = new Error('fixture renewal')
  await expect(
    failure.run(error, () =>
      s.request('repository.v1.watch', {
        worktree_id: s.root,
        subscription_id: b.subscription_id,
      })
    )
  ).rejects.toBe(error)
  expect([...repository.subscriptions.keys()]).toEqual([a.subscription_id])
})

it('rechecks a held renewal after expiry, unwatch or a competing replacement', async () => {
  const s = await setup(),
    repository = s.core.resources.repository as any
  const a = await s.request('repository.v1.watch', { worktree_id: s.root })
  const other = s.core.authority.authenticate(s.core.createToken('other').token)
  const held = new AsyncLocalStorage<{ entered: boolean; release: Promise<void> }>()
  const original = repository.watchFingerprint.bind(repository)
  vi.spyOn(repository, 'watchFingerprint').mockImplementation(async (target) => {
    const gate = held.getStore()
    if (gate) {
      gate.entered = true
      await gate.release
    }
    return original(target)
  })
  for (let attempt = 0; attempt < 3; attempt++) {
    for (const action of ['expiry', 'unwatch', 'replacement']) {
      const b = await s.request('repository.v1.watch', { worktree_id: s.root })
      let release!: () => void
      const gate = {
        entered: false,
        release: new Promise<void>((r) => {
          release = r
        }),
      }
      const renewing = held.run(gate, () =>
        s.request('repository.v1.watch', {
          worktree_id: s.root,
          subscription_id: b.subscription_id,
        })
      )
      const rejected = expect(renewing).rejects.toThrow('unauthorized')
      let replacement: { subscription_id: string } | undefined
      try {
        await wait(() => gate.entered)
        // Invalid renewals must not bypass ownership while another acquisition is
        // suspended. These all cross request parsing and the real dispatch path.
        await expect(
          s.core.request(
            other,
            'repository.v1.watch',
            {
              worktree_id: s.root,
              subscription_id: b.subscription_id,
            },
            `foreign-held-${attempt}-${action}`
          )
        ).rejects.toThrow('unauthorized')
        await expect(
          s.request('repository.v1.watch', {
            worktree_id: s.external,
            subscription_id: b.subscription_id,
          })
        ).rejects.toThrow('unauthorized')
        await expect(
          s.request('repository.v1.watch', {
            worktree_id: s.root,
            subscription_id: 'missing',
          })
        ).rejects.toThrow('unauthorized')
        if (action === 'expiry')
          repository.subscriptions.get(b.subscription_id).expires = Date.now() - 1
        else if (action === 'unwatch')
          await s.request('repository.v1.unwatch', {
            worktree_id: s.root,
            subscription_id: b.subscription_id,
          })
        else
          replacement = await s.request('repository.v1.watch', {
            worktree_id: s.root,
            subscription_id: b.subscription_id,
          })
      } finally {
        release()
        await rejected
      }
      expect(repository.subscriptions.has(a.subscription_id)).toBe(true)
      expect(repository.subscriptions.has(b.subscription_id)).toBe(false)
      if (replacement) {
        expect(repository.subscriptions.has(replacement.subscription_id)).toBe(true)
        await s.request('repository.v1.unwatch', {
          worktree_id: s.root,
          subscription_id: replacement.subscription_id,
        })
      }
      expect([...repository.subscriptions.keys()]).toEqual([a.subscription_id])
    }
  }
}, 60000)

it('bounds old-client leases and replaces only the explicit lease at capacity without leaks', async () => {
  const s = await setup(),
    repository = s.core.resources.repository as any
  let lease = await s.request('repository.v1.watch', { worktree_id: s.root, changes: null })
  for (let i = 1; i < 16; i++) await s.request('repository.v1.watch', { worktree_id: s.root })
  await expect(s.request('repository.v1.watch', { worktree_id: s.root })).rejects.toThrow(
    'resource_busy'
  )
  for (let i = 0; i < 4; i++) {
    const old = repository.subscriptions.get(lease.subscription_id)
    lease = await s.request('repository.v1.watch', {
      worktree_id: s.root,
      subscription_id: lease.subscription_id,
      changes: lease.changes,
    })
    expect(repository.subscriptions.size).toBe(16)
    expect([...repository.subscriptions.values()]).not.toContain(old)
    expect(old.timer?._destroyed).toBeTruthy()
  }
  repository.subscriptions.get(lease.subscription_id).expires = Date.now() - 1
  await expect(
    s.request('repository.v1.watch', {
      worktree_id: s.root,
      subscription_id: lease.subscription_id,
    })
  ).rejects.toThrow('unauthorized')
  await s.request('repository.v1.watch', { worktree_id: s.root })
  expect(repository.subscriptions.size).toBe(16)
})

it('sends one batch per installation with independent stream and legacy leases', async () => {
  const s = await setup()
  await s.request('repository.v1.watch', { worktree_id: s.root, changes: null })
  await s.request('repository.v1.watch', { worktree_id: s.root, changes: null })
  await s.request('repository.v1.watch', { worktree_id: s.root })
  const other = s.core.authority.authenticate(s.core.createToken('other').token)
  await s.core.request(
    other,
    'repository.v1.watch',
    { worktree_id: s.root, changes: null },
    'other'
  )
  const before = s.core.head('catalog')
  writeFileSync(join(s.repo, 'file'), 'edited\n')
  await wait(() => s.batches(before).length >= 2)
  const events = s.core.read('catalog', before).filter((e) => e.type === 'repository.changed')
  expect(events).toHaveLength(2)
  expect(new Set(events.map((e) => JSON.stringify(e.actor))).size).toBe(2)
  expect((s.core.resources.repository as any).subscriptions.size).toBe(4)
  await wait(() => s.core.read('catalog', before).some((e) => e.type === 'repository.invalidated'))
}, 60000)

it('retries a batch on another lease after append fails for the first', async () => {
  const s = await setup(),
    repository = s.core.resources.repository as any
  const first = await s.request('repository.v1.watch', { worktree_id: s.root, changes: null })
  const second = await s.request('repository.v1.watch', { worktree_id: s.root, changes: null })
  const append = s.core.append.bind(s.core)
  let failed = false
  vi.spyOn(s.core, 'append').mockImplementation((...args) => {
    if (args[1] === 'repository.changed' && !failed) {
      failed = true
      throw new Error('fixture append failure')
    }
    return append(...args)
  })
  const before = s.core.head('catalog')
  writeFileSync(join(s.repo, 'file'), 'edited\n')
  await wait(() => s.batches(before).length > 0)
  expect(failed).toBe(true)
  expect(repository.subscriptions.has(first.subscription_id)).toBe(false)
  expect(repository.subscriptions.has(second.subscription_id)).toBe(true)
}, 60000)

it('describes a stream batch and keeps the legacy watch lease shape', () => {
  const lease = { subscription_id: 'lease', expires_at: new Date().toISOString() }
  expect(RepositoryWatchSchema.parse({ ...lease, refresh_required: true })).toEqual({
    ...lease,
    refresh_required: true,
  })
  expect(
    RepositoryWatchSchema.parse({
      ...lease,
      refresh_required: false,
      changes: { stream_id: 'stream', revision: 4 },
    }).changes
  ).toEqual({ stream_id: 'stream', revision: 4 })
  const watch = RepositoryMethodSchemas['repository.v1.watch']
  expect(watch.parse({ worktree_id: 'w' })).toEqual({ worktree_id: 'w' })
  expect(watch.parse({ worktree_id: 'w', subscription_id: 'lease' }).subscription_id).toBe('lease')
  expect(watch.parse({ worktree_id: 'w', changes: null }).changes).toBeNull()
  expect(watch.parse({ worktree_id: 'w', changes: { stream_id: 's', revision: 2 } })).toBeTruthy()
  const batch = {
    project_id: 'p',
    worktree_id: 'w',
    stream_id: 's',
    revision: 3,
    complete: true,
    entries: [
      { change: 'added', entry: entry('src/new.ts', 'file') },
      { change: 'renamed', from: 'old.ts', entry: entry('new.ts', 'file') },
      { change: 'deleted', path: 'gone', kind: 'directory' },
    ],
    git: { head: null, branch: 'trunk', detached: false, status: [] },
  }
  expect(RepositoryChangeBatchSchema.parse(batch)).toEqual(batch)
  expect(
    RepositoryChangeBatchSchema.parse({
      project_id: 'p',
      worktree_id: 'w',
      stream_id: 's',
      revision: 4,
      complete: false,
      reason: 'overflow',
    }).complete
  ).toBe(false)
  expect(() =>
    RepositoryChangeBatchSchema.parse({ ...batch, entries: [{ change: 'added', path: '.git/x' }] })
  ).toThrow()
  const event = {
    kind: 'event',
    node_id: 'n',
    stream_id: 'catalog',
    seq: 1,
    type: 'repository.changed',
    actor: { kind: 'installation', installation_id: 'i' },
    at: new Date().toISOString(),
    data: { ...batch, revision: -1 },
  }
  expect(NodeEventSchema.safeParse(event).success).toBe(false)
})

it('diffs two observations into added, modified, renamed and deleted rows', () => {
  const before = baseline([
    ['src', 'directory', 'd1'],
    ['src/a.ts', 'file', 'f1'],
    ['src/b.ts', 'file', 'f2'],
    ['old', 'directory', 'd2'],
    ['old/x.ts', 'file', 'f3'],
    ['old/deep', 'directory', 'd3'],
    ['old/deep/y.ts', 'file', 'f4'],
    ['moved', 'directory', 'd4'],
    ['moved/z.ts', 'file', 'f5'],
  ])
  const after = baseline([
    ['src', 'directory', 'd1'],
    ['src/a.ts', 'file', 'f1', 2],
    ['src/c.ts', 'file', 'f2'],
    ['fresh', 'directory', 'd5'],
    ['fresh/n.ts', 'file', 'f6'],
    ['fresh/inner', 'directory', 'd6'],
    ['fresh/inner/m.ts', 'file', 'f7'],
    ['renamed', 'directory', 'd4'],
    ['renamed/z.ts', 'file', 'f5'],
  ])
  const diff = diffBaselines(before, after, 100)
  expect(diff).not.toBeNull()
  expect(diff!.entries).toEqual([
    { change: 'renamed', from: 'moved', entry: entry('renamed', 'directory') },
    { change: 'renamed', from: 'src/b.ts', entry: entry('src/c.ts', 'file') },
    // A removed or added folder stands for everything under it.
    { change: 'deleted', path: 'old', kind: 'directory' },
    { change: 'added', entry: entry('fresh', 'directory') },
    { change: 'modified', entry: entry('src/a.ts', 'file', 2) },
  ])
  expect(diff!.git).toBeNull()
  expect(diffBaselines(before, before, 100)).toEqual({ entries: [], git: null })
  expect(diffBaselines(before, after, 3)).toBeNull()
})

it('reports HEAD, branch and status changes as their own git part', () => {
  const before = baseline([['file', 'file', 'f1']], {
    status: new Map([['file', { index: ' ', worktree: 'M', path: 'file' }]]),
  })
  const after = baseline([['file', 'file', 'f1']], {
    head: 'a'.repeat(40),
    branch: null,
    detached: true,
    status: new Map([['other', { index: '?', worktree: '?', path: 'other' }]]),
  })
  expect(diffBaselines(before, after, 100)!.git).toEqual({
    head: 'a'.repeat(40),
    branch: null,
    detached: true,
    status: [
      { path: 'file', entry: null },
      { path: 'other', entry: { index: '?', worktree: '?', path: 'other' } },
    ],
  })
})

it('advertises the change stream and streams in-place tree batches to a watcher', async () => {
  const s = await setup()
  expect(s.core.discovery().supported_capabilities).toContain('repository_changes_v1')
  const lease = await s.request('repository.v1.watch', { worktree_id: s.root, changes: null })
  expect(lease.refresh_required).toBe(true)
  expect(lease.changes).toEqual({ stream_id: expect.any(String), revision: 0 })
  const stream = lease.changes.stream_id
  let before = s.core.head('catalog')
  const next = async (change: () => void) => {
    before = s.core.head('catalog')
    change()
    await wait(() => s.batches(before).length > 0)
    const [batch] = s.batches(before)
    expect(RepositoryChangeBatchSchema.parse(batch)).toEqual(batch)
    expect(batch.stream_id).toBe(stream)
    return batch
  }
  let batch = await next(() => writeFileSync(join(s.repo, 'src', 'added.ts'), 'new\n'))
  expect(batch.revision).toBe(1)
  expect(batch.complete).toBe(true)
  expect(batch.entries).toEqual([
    {
      change: 'added',
      entry: { path: 'src/added.ts', name: 'added.ts', kind: 'file', oid: null, size: 4 },
    },
  ])
  expect(batch.git.status).toEqual([
    { path: 'src/added.ts', entry: { index: '?', worktree: '?', path: 'src/added.ts' } },
  ])
  batch = await next(() => writeFileSync(join(s.repo, 'src', 'added.ts'), 'longer\n'))
  expect(batch.revision).toBe(2)
  expect(batch.entries).toEqual([
    { change: 'modified', entry: expect.objectContaining({ path: 'src/added.ts', size: 7 }) },
  ])
  batch = await next(() => renameSync(join(s.repo, 'src', 'added.ts'), join(s.repo, 'moved.ts')))
  expect(batch.revision).toBe(3)
  expect(batch.entries).toEqual([
    {
      change: 'renamed',
      from: 'src/added.ts',
      entry: expect.objectContaining({ path: 'moved.ts' }),
    },
  ])
  batch = await next(() => rmSync(join(s.repo, 'moved.ts')))
  expect(batch.entries).toEqual([{ change: 'deleted', path: 'moved.ts', kind: 'file' }])
  batch = await next(() => git(s.repo, 'checkout', '-q', '-b', 'topic'))
  expect(batch.entries).toEqual([])
  expect(batch.git).toMatchObject({ branch: 'refs/heads/topic', detached: false })
  // A change-stream watcher is never told to reread for ordinary edits or its own lease.
  expect(
    s.core
      .read('catalog', 0)
      .filter((e) => e.type === 'repository.invalidated' && (e.data as any).worktree_id === s.root)
  ).toEqual([])
}, 60000)

it('continues a renewed lease without a reread and asks for one after a gap', async () => {
  const s = await setup()
  const first = await s.request('repository.v1.watch', { worktree_id: s.root, changes: null })
  const before = s.core.head('catalog')
  writeFileSync(join(s.repo, 'later'), 'x\n')
  await wait(() => s.batches(before).length > 0)
  const revision = s.batches(before).at(-1).revision
  const renewed = await s.request('repository.v1.watch', {
    worktree_id: s.root,
    subscription_id: first.subscription_id,
    changes: { stream_id: first.changes.stream_id, revision },
  })
  expect(renewed).toMatchObject({
    refresh_required: false,
    changes: { stream_id: first.changes.stream_id, revision },
  })
  // A client one batch behind has that batch on its way: it was sent to this installation.
  const behind = await s.request('repository.v1.watch', {
    worktree_id: s.root,
    changes: { stream_id: first.changes.stream_id, revision: revision - 1 },
  })
  expect(behind.refresh_required).toBe(false)
  const ahead = await s.request('repository.v1.watch', {
    worktree_id: s.root,
    changes: { stream_id: first.changes.stream_id, revision: revision + 1 },
  })
  expect(ahead.refresh_required).toBe(true)
  const restarted = await s.request('repository.v1.watch', {
    worktree_id: s.root,
    changes: { stream_id: 'a-previous-node-run', revision },
  })
  expect(restarted).toMatchObject({ refresh_required: true, changes: { revision } })
}, 60000)

it('asks for a reread when a batch was made while this client was not watching', async () => {
  const s = await setup()
  const other = s.core.authority.authenticate(s.core.createToken('other').token)
  const first = await s.request('repository.v1.watch', { worktree_id: s.root, changes: null })
  await s.request('repository.v1.unwatch', {
    worktree_id: s.root,
    subscription_id: first.subscription_id,
  })
  // Another client keeps the stream moving; nothing of it reaches the first one.
  await s.core.request(
    other,
    'repository.v1.watch',
    { worktree_id: s.root, changes: null },
    'other-watch'
  )
  const before = s.core.head('catalog')
  writeFileSync(join(s.repo, 'unseen'), 'x\n')
  await wait(() => s.batches(before).length > 0)
  const renewed = await s.request('repository.v1.watch', {
    worktree_id: s.root,
    changes: first.changes,
  })
  expect(renewed.refresh_required).toBe(true)
}, 60000)
it('keeps sending batches while a lease is renewed', async () => {
  const s = await setup(),
    repository = s.core.resources.repository as any
  const first = await s.request('repository.v1.watch', { worktree_id: s.root, changes: null })
  const before = s.core.head('catalog')
  // Hold the renewal after it has observed the tree and before it takes over, however long
  // that takes on this machine: an edit in that window is the old lease's to send.
  const open = repository.changes.open.bind(repository.changes)
  let held!: () => void,
    reached = false
  const release = new Promise<void>((r) => (held = r))
  vi.spyOn(repository.changes, 'open').mockImplementation(async (...args: any[]) => {
    reached = true
    await release
    return open(...args)
  })
  const renewing = s.request('repository.v1.watch', {
    worktree_id: s.root,
    subscription_id: first.subscription_id,
    changes: first.changes,
  })
  await wait(() => reached)
  writeFileSync(join(s.repo, 'during'), 'x\n')
  await wait(() => s.batches(before).length > 0)
  held()
  const renewed = await renewing
  expect(renewed.refresh_required).toBe(false)
  expect(renewed.changes).toEqual({
    stream_id: first.changes.stream_id,
    revision: first.changes.revision + 1,
  })
  // The renewed lease carries on from there.
  writeFileSync(join(s.repo, 'after'), 'x\n')
  await wait(() => s.batches(before).length > 1)
  expect(s.batches(before).map((b) => b.revision)).toEqual([
    first.changes.revision + 1,
    first.changes.revision + 2,
  ])
  expect(s.batches(before)[0].entries).toEqual([
    { change: 'added', entry: expect.objectContaining({ path: 'during' }) },
  ])
}, 60000)
it('keeps a lease streaming after the request that opened it would have run out of time', async () => {
  const s = await setup()
  const repository = s.core.resources.repository as any
  await s.request('repository.v1.watch', { worktree_id: s.root, changes: null })
  // The watch request's own 15 s git budget is long over; the lease's 60 s is not. A
  // reconciliation already under way would see its own budget pass too, so none is.
  await wait(() => repository.reconciliations.size === 0)
  const now = Date.now.bind(Date)
  vi.spyOn(Date, 'now').mockImplementation(() => now() + 16000)
  const before = s.core.head('catalog')
  writeFileSync(join(s.repo, 'later'), 'x\n')
  await wait(() => s.batches(before).length > 0)
  expect(s.batches(before)).toEqual([
    expect.objectContaining({
      revision: 1,
      complete: true,
      entries: [{ change: 'added', entry: expect.objectContaining({ path: 'later' }) }],
    }),
  ])
}, 60000)
it('marks a batch incomplete after a watcher overflow and keeps counting', async () => {
  const s = await setup(),
    repository = s.core.resources.repository as any
  const lease = await s.request('repository.v1.watch', { worktree_id: s.root, changes: null })
  const subscription = repository.subscriptions.get(lease.subscription_id)
  let before = s.core.head('catalog')
  subscription.watchers[0].emit('error', new Error('fixture overflow'))
  await wait(() => s.batches(before).length > 0)
  expect(s.batches(before)[0]).toEqual({
    project_id: s.project.project_id,
    worktree_id: s.root,
    stream_id: lease.changes.stream_id,
    revision: 1,
    complete: false,
    reason: 'overflow',
  })
  before = s.core.head('catalog')
  writeFileSync(join(s.repo, 'after-overflow'), 'x\n')
  await wait(() => s.batches(before).some((b) => b.complete))
  expect(s.batches(before).find((b) => b.complete)).toMatchObject({ revision: 2 })
}, 60000)

it('asks for a reread when one batch would be too large', async () => {
  const s = await setup(),
    repository = s.core.resources.repository as any
  repository.changes.limit = 3
  await s.request('repository.v1.watch', { worktree_id: s.root, changes: null })
  const before = s.core.head('catalog')
  for (let i = 0; i < 5; i++) writeFileSync(join(s.repo, `bulk-${i}`), 'x\n')
  await wait(() => s.batches(before).length > 0)
  expect(s.batches(before)[0]).toMatchObject({ complete: false, reason: 'limit' })
}, 60000)

it('keeps a legacy watcher on invalidations only', async () => {
  const s = await setup()
  const lease = await s.request('repository.v1.watch', { worktree_id: s.root })
  expect(Object.keys(lease).sort()).toEqual(['expires_at', 'refresh_required', 'subscription_id'])
  expect(lease.refresh_required).toBe(true)
  const before = s.core.head('catalog')
  writeFileSync(join(s.repo, 'legacy'), 'x\n')
  await wait(() => s.core.read('catalog', before).some((e) => e.type === 'repository.invalidated'))
  expect(s.batches(0)).toEqual([])
}, 60000)

it('fences change batches of an external worktree once external reading is revoked', async () => {
  const s = await setup()
  await s.request('repository.v1.watch', { worktree_id: s.external, changes: null })
  const before = s.core.head('catalog')
  writeFileSync(join(s.linked, 'private-name'), 'x\n')
  await wait(() => s.batches(before).length > 0)
  const event = s.core.read('catalog', before).find((e) => e.type === 'repository.changed')!
  expect(s.core.canPublishEvent(s.actor, event)).toBe(true)
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: false,
  })
  expect(s.core.canPublishEvent(s.actor, event)).toBe(false)
}, 60000)
