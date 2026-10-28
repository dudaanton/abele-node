import { afterEach, expect, it, vi } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  readFileSync,
  existsSync,
  watch,
  type FSWatcher,
} from 'node:fs'
import { EventEmitter } from 'node:events'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
import { WatchService } from '../packages/node-core/src/watch-service.js'

import { createHash } from 'node:crypto'

vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, watch: vi.fn(fs.watch) }
})

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  vi.useRealTimers()
  for (const close of cleanup.splice(0)) await close()
  vi.restoreAllMocks()
})

function setup() {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/read-queue-'))
  const core = new NodeCore(dir)
  // Inject direct Linux hints so the fake fs.watch callbacks remain controllable.
  Object.defineProperty(core.resources, 'watchers', {
    value: new WatchService({ platform: 'linux' }),
  })
  cleanup.push(async () => {
    await core.resources.stop()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  const service = core.resources.repository
  vi.spyOn(core.authority, 'check').mockImplementation(() => {})
  vi.spyOn(service as any, 'checkPublication').mockImplementation(() => {})
  const started: number[] = []
  const finish: (() => void)[] = []
  let running = 0,
    peak = 0
  vi.spyOn(service as any, 'catalog').mockImplementation(async (...args: any[]) => {
    started.push(args[2].id)
    peak = Math.max(peak, ++running)
    await new Promise<void>((resolve) => finish.push(resolve))
    running--
    return {}
  })
  const read = (id: number) => service.request(actor, 'repository.v1.worktrees', { id })
  return { core, actor, dir, service, read, started, finish, peak: () => peak }
}

it('admits waiting reads in FIFO order and keeps four active jobs', async () => {
  const s = setup()
  const tasks = Array.from({ length: 8 }, (_, i) => s.read(i))
  await vi.waitFor(() => expect(s.started).toEqual([0, 1, 2, 3]))
  for (let i = 0; i < 4; i++) {
    s.finish.shift()!()
    await vi.waitFor(() => expect(s.started).toHaveLength(5 + i))
  }
  expect(s.started).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  s.finish.splice(0).forEach((finish) => finish())
  await Promise.all(tasks)
  expect(s.peak()).toBe(4)
})

it('expires queued reads with git_timeout and never runs expired work', async () => {
  const s = setup()
  vi.useFakeTimers()
  const active = Array.from({ length: 4 }, (_, i) => s.read(i))
  await Promise.resolve()
  const expired = expect(s.read(4)).rejects.toMatchObject({ code: 'git_timeout' })
  await vi.advanceTimersByTimeAsync(15_000)
  await expired
  s.finish.splice(0).forEach((finish) => finish())
  await Promise.all(active)
  expect(s.started).toEqual([0, 1, 2, 3])
  const next = s.read(5)
  await Promise.resolve()
  s.finish.shift()!()
  await next
})

it('cancels queued reads when the service stops', async () => {
  const s = setup()
  const active = Array.from({ length: 4 }, (_, i) => s.read(i))
  await Promise.resolve()
  const cancelled = expect(s.read(4)).rejects.toMatchObject({ code: 'resource_busy' })
  await s.service.stop()
  await cancelled
  s.finish.splice(0).forEach((finish) => finish())
  await Promise.all(active)
  expect(s.started).toEqual([0, 1, 2, 3])
})

it('queues edits fairly with reads and serializes edits', async () => {
  const s = setup(),
    service = s.service as any
  const active = Array.from({ length: 4 }, (_, i) => s.read(i))
  await Promise.resolve()
  const order: string[] = []
  let finishEdit!: () => void
  const first = service.editJob(async () => {
    order.push('edit1')
    await new Promise<void>((resolve) => (finishEdit = resolve))
  })
  first.catch(() => {})
  const later = s.read(4)
  const second = service.editJob(async () => {
    order.push('edit2')
  })
  second.catch(() => {})
  s.finish.shift()!()
  await vi.waitFor(() => expect(order).toEqual(['edit1']))
  s.finish.shift()!()
  await vi.waitFor(() => expect(s.started).toContain(4))
  expect(order).toEqual(['edit1'])
  expect(service.active).toBeLessThanOrEqual(4)
  finishEdit()
  await Promise.all([first, second])
  expect(order).toEqual(['edit1', 'edit2'])
  s.finish.splice(0).forEach((finish) => finish())
  await Promise.all([...active, later])
  expect(service.active).toBe(0)
})

it('expires queued edits without late execution and accepts a fresh edit', async () => {
  const s = setup(),
    service = s.service as any
  vi.useFakeTimers()
  const active = Array.from({ length: 4 }, (_, i) => s.read(i))
  await Promise.resolve()
  const work = vi.fn(async () => {})
  const expired = expect(service.editJob(work)).rejects.toMatchObject({ code: 'git_timeout' })
  await vi.advanceTimersByTimeAsync(15_000)
  await expired
  s.finish.splice(0).forEach((finish) => finish())
  await Promise.all(active)
  expect(work).not.toHaveBeenCalled()
  await service.editJob(work)
  expect(work).toHaveBeenCalledTimes(1)
  expect(service.readers).toHaveLength(0)
  expect(service.active).toBe(0)
})

it('cancels queued edits on stop and refuses fresh edits', async () => {
  const s = setup(),
    service = s.service as any
  const active = Array.from({ length: 4 }, (_, i) => s.read(i))
  await Promise.resolve()
  const work = vi.fn(async () => {})
  const cancelled = expect(service.editJob(work)).rejects.toMatchObject({ code: 'resource_busy' })
  expect(service.readers).toHaveLength(1)
  await service.stop()
  await cancelled
  await expect(service.editJob(work)).rejects.toMatchObject({ code: 'resource_busy' })
  s.finish.splice(0).forEach((finish) => finish())
  await Promise.all(active)
  expect(work).not.toHaveBeenCalled()
  expect(service.active).toBe(0)
  expect(service.readers).toHaveLength(0)
})

it('waits for owner editing and file effects under read saturation, including both move gates', async () => {
  const fixture = setup()
  const { core, actor, dir } = fixture
  const linked = join(dir, 'files')
  mkdirSync(linked)
  const target = { worktree_id: 'fixture', project_id: 'project', kind: 'external', path: linked }
  const repository = fixture.service as any
  // Git metadata is fixed here: this tests admission and actual file effects,
  // without process discovery, a daemon, or a real Git subprocess.
  core.db
    .prepare('INSERT INTO repository_targets VALUES(?,?,?,?,?,?,?)')
    .run('fixture', 'project', linked, 'external', null, 'fingerprint', 1)
  vi.spyOn(repository, 'get').mockReturnValue(target)
  vi.spyOn(repository, 'validate').mockImplementation(async () => target)
  vi.spyOn(repository, 'fileRoot').mockReturnValue(linked)
  vi.spyOn(repository, 'readRoot').mockReturnValue(linked)
  vi.spyOn(repository, 'workingState').mockResolvedValue({ files: [] })
  vi.spyOn(repository, 'config').mockReturnValue({ external_read: 1 })
  const s = {
    core,
    actor,
    linked,
    external: 'fixture',
    request: (method: string, params: any, operation = 'enable-editing') => {
      if (method === 'repository.v1.editing') return repository.editing(actor, params, operation)
      if (method === 'repository.v1.write')
        return core.resources.mutations.writeRepository(actor, params, operation)
      return core.resources.mutations.fileOperation(actor, method as any, params, operation)
    },
  }
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  const service = s.core.resources.repository as any
  const held = async (work: () => Promise<any>) => {
    await Promise.all(Array.from({ length: 4 }, () => service.acquireRead()))
    const pending = work()
    pending.catch(() => {})
    try {
      await vi.waitFor(() => expect(service.readers).toHaveLength(1))
    } finally {
      for (let i = 0; i < 4; i++) service.releaseJob()
    }
    return pending
  }
  const permission = { worktree_id: s.external, enabled: false }
  await held(() => s.request('repository.v1.editing', permission, 'queued-permission'))
  expect(
    s.core.operationReceipt(s.actor, 'repository.v1.editing', permission, 'queued-permission')
  ).toBeTruthy()
  await s.request('repository.v1.editing', permission, 'queued-permission')
  expect(core.db.prepare('SELECT enabled FROM repository_edit_permissions').all()).toEqual([
    { enabled: 0 },
  ])
  await s.request('repository.v1.editing', { ...permission, enabled: true })
  const write = {
    worktree_id: s.external,
    path: 'created',
    expected_content_id: null,
    text: 'keep',
  }
  await held(() => s.request('repository.v1.write', write, 'queued-create'))
  expect(core.operationReceipt(actor, 'repository.v1.write', write, 'queued-create')).toBeTruthy()
  expect(readFileSync(join(s.linked, 'created'), 'utf8')).toBe('keep')
  const mkdir = { worktree_id: s.external, path: 'folder' }
  expect(
    await held(() => s.request('repository.v1.file.mkdir', mkdir, 'queued-mkdir'))
  ).toMatchObject({ state: 'applied' })
  expect(
    core.operationReceipt(actor, 'repository.v1.file.mkdir', mkdir, 'queued-mkdir')
  ).toBeTruthy()
  // Refill the read slots after source preparation, so destination preparation
  // must independently wait before the move can touch the filesystem.
  const prepare = service.prepareEdit.bind(service)
  let gates = 0
  const spy = vi.spyOn(service, 'prepareEdit').mockImplementation(async (...args: any[]) => {
    await prepare(...args)
    if (++gates === 1) {
      await Promise.all(Array.from({ length: 4 }, () => service.acquireRead()))
    }
  })
  const move = {
    worktree_id: s.external,
    from: 'created',
    to: 'folder/moved',
    expected_content_id: hash('keep'),
  }
  const moving = held(() => s.request('repository.v1.file.move', move, 'queued-move'))
  moving.catch(() => {})
  await vi.waitFor(() => expect(gates).toBe(1))
  await vi.waitFor(() => expect(service.readers).toHaveLength(1))
  expect(existsSync(join(s.linked, 'created'))).toBe(true)
  for (let i = 0; i < 4; i++) service.releaseJob()
  expect(await moving).toMatchObject({ state: 'applied' })
  spy.mockRestore()
  expect(gates).toBe(2)
  expect(readFileSync(join(s.linked, 'folder/moved'), 'utf8')).toBe('keep')
  const remove = {
    worktree_id: s.external,
    path: 'folder/moved',
    expected_content_id: hash('keep'),
  }
  const removed = await held(() => s.request('repository.v1.file.remove', remove, 'queued-remove'))
  expect(removed).toMatchObject({ state: 'applied', recovery_path: expect.any(String) })
  expect(readFileSync(join(core.stateDir, removed.recovery_path), 'utf8')).toBe('keep')
  expect(existsSync(join(s.linked, 'folder/moved'))).toBe(false)
  expect(
    s.core.operationReceipt(s.actor, 'repository.v1.file.remove', remove, 'queued-remove')
  ).toBeTruthy()
  expect(await s.request('repository.v1.file.move', move, 'queued-move')).toMatchObject({
    state: 'applied',
  })
})

it('counts admission time against the edit budget and rechecks authorization after waiting', async () => {
  const s = setup(),
    service = s.service as any
  vi.useFakeTimers()
  const active = Array.from({ length: 4 }, (_, i) => s.read(i))
  await Promise.resolve()
  const bounded = vi.spyOn(s.core.resources.git, 'bounded')
  const work = vi.fn(async () => {})
  const edit = service.editJob(work)
  await vi.advanceTimersByTimeAsync(4_000)
  s.finish.shift()!()
  await edit
  expect(bounded).toHaveBeenCalledWith(11_000, work)
  // prepareEdit must check the current grant, rather than one captured at enqueue.
  await service.acquireRead()
  const preparing = service.prepareEdit(s.actor, 'fixture', 'file')
  const rejected = expect(preparing).rejects.toThrow('revoked')
  vi.mocked(s.core.authority.check).mockImplementation(() => {
    throw new Error('revoked')
  })
  s.finish.shift()!()
  await rejected
  s.finish.splice(0).forEach((finish) => finish())
  service.releaseJob()
  await Promise.all(active)
  expect(service.active).toBe(0)
})

it('keeps watcher reconciliation behind queued foreground edits and reads', async () => {
  const s = setup(),
    service = s.service as any
  vi.useFakeTimers()
  const target = { worktree_id: 'fixture', project_id: 'project', kind: 'root', path: s.dir }
  vi.spyOn(service, 'checkRead').mockImplementation(() => {})
  vi.spyOn(service, 'config').mockReturnValue({ external_read: 1 })
  vi.spyOn(s.core.resources.projects, 'get').mockReturnValue({ git_common_dir: s.dir } as any)
  vi.spyOn(service, 'validate').mockResolvedValue(target)
  const fingerprint = vi
    .spyOn(service, 'watchFingerprint')
    .mockResolvedValue({ cheap: 'same', refs: [] })
  vi.spyOn(service, 'watchVisible').mockResolvedValue('same')
  const filesystemHints: (() => void)[] = []
  vi.mocked(watch).mockImplementation(((_path: unknown, listener: () => void) => {
    filesystemHints.push(listener)
    return Object.assign(new EventEmitter(), {
      close: vi.fn(),
      ref: vi.fn(),
      unref: vi.fn(),
    }) as FSWatcher
  }) as typeof watch)
  await service.subscribe(s.actor, target)
  expect(filesystemHints).toHaveLength(2)
  fingerprint.mockClear()
  const active = Array.from({ length: 4 }, (_, i) => s.read(i))
  await Promise.resolve()
  const work = vi.fn(async () => {})
  const edit = service.editJob(work)
  const later = s.read(4)
  // Exercise both hint sources while foreground work owns the queue.
  filesystemHints[0]!()
  await vi.advanceTimersByTimeAsync(2_000)
  expect(fingerprint).not.toHaveBeenCalled()
  s.finish.shift()!()
  await edit
  expect(work).toHaveBeenCalledOnce()
  await Promise.resolve()
  expect(s.started).toEqual([0, 1, 2, 3, 4])
  expect(fingerprint).not.toHaveBeenCalled()
  s.finish.splice(0).forEach((finish) => finish())
  await Promise.all([...active, later])
  await vi.advanceTimersByTimeAsync(2_000)
  expect(fingerprint).toHaveBeenCalledOnce()
  // A later filesystem hint may legitimately reconcile again; no native
  // watcher is attached, so its timing is entirely under this test's control.
  filesystemHints[0]!()
  await vi.advanceTimersByTimeAsync(100)
  expect(fingerprint).toHaveBeenCalledTimes(2)
  expect(service.active).toBe(0)
})
