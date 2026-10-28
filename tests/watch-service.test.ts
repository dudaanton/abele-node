import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { WatchService } from '../packages/node-core/src/watch-service.js'
import { NodeCore } from '../packages/node-core/src/index.js'
import { WorktreeMonitor } from '../packages/node-core/src/worktree-monitor.js'

const fixtures: string[] = []
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'watch-factory-'))
  fixtures.push(dir)
  return { dir, counts: dir }
}
const load = (dir: string, index: number) => {
  try {
    return Number(readFileSync(join(dir, String(index)), 'utf8'))
  } catch {
    return 0
  }
}
const store = (dir: string, index: number, value: number) =>
  writeFileSync(join(dir, String(index)), String(value))
const add = (dir: string, index: number, value: number) =>
  store(dir, index, load(dir, index) + value)
afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true })
})

async function until(check: () => boolean) {
  const end = Date.now() + 5000
  while (!check()) {
    if (Date.now() > end) throw new Error('watcher_deadline')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
const factory = new URL('./fixtures/watch-factory.mjs', import.meta.url)
it('reports and terminates an owner blocked inside watch startup', async () => {
  const state = fixture()
  store(state.dir, 4, 1)
  const service = new WatchService({
    platform: 'darwin',
    factory,
    state: state.dir,
    startupTimeoutMs: 200,
  })
  try {
    let error: Error | undefined
    const handle = service
      .watch('/project', true, () => {})
      .on('error', (reason) => {
        error = reason
      })
    await until(() => !!error)
    expect(handle.ready).toBe(false)
    expect(error!.message).toContain('watch_owner_deadline')
    expect(error!.message).toContain('opening')
    expect(error!.message).toContain('/project')
    store(state.dir, 4, 0)
    const replacement = service.watch('/project', true, () => {})
    await until(() => replacement.ready)
    expect(handle.ready).toBe(false)
  } finally {
    await service.stop()
  }
})
it('reports the owner exit code and stderr instead of silently waiting for readiness', async () => {
  const service = new WatchService({
    platform: 'darwin',
    factory: new URL('./fixtures/watch-crash.mjs', import.meta.url),
  })
  try {
    let error: Error | undefined
    service
      .watch('/project', true, () => {})
      .on('error', (reason) => {
        error = reason
      })
    await until(() => !!error)
    expect(error!.message).toContain('code=7')
    expect(error!.message).toContain('watch fixture startup crashed')
  } finally {
    await service.stop()
  }
})
it('preserves an owner initialization error', async () => {
  const service = new WatchService({
    platform: 'darwin',
    factory: new URL('./fixtures/no-such-watch-factory.mjs', import.meta.url),
  })
  try {
    let error: Error | undefined
    service
      .watch('/project', true, () => {})
      .on('error', (reason) => {
        error = reason
      })
    await until(() => !!error)
    expect(error!.message).toContain('no-such-watch-factory.mjs')
  } finally {
    await service.stop()
  }
})
it.skipIf(process.env.ABELE_DEBUGGER_LOCAL_TEST !== '1').each([false, true])(
  'native owner reports readiness and real filesystem events (recursive: %s)',
  async (recursive) => {
    const state = fixture(),
      service = new WatchService({ platform: 'darwin', idleMs: 0 })
    mkdirSync(join(state.dir, 'nested'))
    try {
      const names: string[] = []
      let error: Error | undefined
      const watcher = service.watch(state.dir, recursive, (_event, name) =>
        names.push(String(name))
      )
      watcher.on('error', (reason) => {
        error = reason
      })
      await until(() => {
        if (error) throw error
        return watcher.ready
      })
      writeFileSync(join(state.dir, recursive ? 'nested/changed' : 'changed'), 'real event')
      await until(() => {
        if (error) throw error
        return names.some((name) => name.endsWith('changed'))
      })
      const before = performance.now()
      await service.stop()
      expect(performance.now() - before).toBeLessThan(250)
    } finally {
      await service.stop()
    }
  }
)
it('does not wait for non-interruptible native close during shutdown', async () => {
  const state = fixture(),
    counts = state.counts
  const service = new WatchService({ platform: 'darwin', idleMs: 0, factory, state: state.dir })
  try {
    const watcher = service.watch('/project', true, () => {})
    await until(() => watcher.ready)
    store(counts, 2, 2)
    watcher.close()
    await until(() => load(counts, 1) === 1)
    const before = performance.now()
    await service.stop()
    expect(performance.now() - before).toBeLessThan(250)
  } finally {
    await service.stop()
  }
})
it('opens OS watchers off the request loop as well as closing them', async () => {
  const state = fixture(),
    counts = state.counts
  store(counts, 4, 1)
  const service = new WatchService({ platform: 'darwin', factory, state: state.dir })
  try {
    const watcher = service.watch('/project', true, () => {})
    await until(() => load(counts, 0) === 1)
    expect(watcher.ready).toBe(false)
    const before = performance.now()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(performance.now() - before).toBeLessThan(250)
    expect(load(counts, 4)).toBe(1)
    store(counts, 4, 0)
    await until(() => watcher.ready)
    watcher.close()
  } finally {
    store(counts, 4, 0)
    await service.stop()
  }
})
it('shares macOS OS watchers across lease churn and fans out changes only to live leases', async () => {
  const state = fixture(),
    counts = state.counts
  const service = new WatchService({ platform: 'darwin', idleMs: 100, factory, state: state.dir })
  try {
    const first = vi.fn(),
      second = vi.fn()
    const a = service.watch('/project', true, first)
    const b = service.watch('/project', true, second)
    await until(() => a.ready && b.ready)
    a.close()
    for (let i = 0; i < 40; i++) service.watch('/project', true, () => {}).close()
    expect(load(counts, 0)).toBe(1)
    expect(load(counts, 1)).toBe(0)
    add(counts, 3, 1)
    await until(() => second.mock.calls.length > 0)
    expect(first).not.toHaveBeenCalled()
    b.close()
    const renewed = service.watch('/project', true, () => {})
    expect(renewed.ready).toBe(true)
    expect(load(counts, 0)).toBe(1)
    expect(load(counts, 1)).toBe(0)
    renewed.close()
    await until(() => load(counts, 1) === 1)
  } finally {
    await service.stop()
  }
})
it('answers a concurrent channel request while the OS watcher close is blocked', async () => {
  const state = fixture(),
    counts = state.counts
  const service = new WatchService({ platform: 'darwin', idleMs: 0, factory, state: state.dir })
  const dir = mkdtempSync(join(tmpdir(), 'watch-close-')),
    core = new NodeCore(dir)
  try {
    const watcher = service.watch('/project', true, () => {})
    await until(() => watcher.ready)
    store(counts, 2, 1)
    watcher.close()
    await until(() => load(counts, 1) === 1)
    const actor = core.authority.authenticate(core.createToken('fixture').token)
    const before = performance.now()
    await core.request(actor, 'session.list', {})
    expect(performance.now() - before).toBeLessThan(250)
    expect(load(counts, 2)).toBe(1)
  } finally {
    store(counts, 2, 0)
    await service.stop()
    await core.resources.stop()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
it('retains immediate native watcher ownership on Linux', async () => {
  const close = vi.fn(),
    native = vi.fn(() => Object.assign(new EventEmitter(), { close, ready: true }))
  const service = new WatchService({ platform: 'linux', native })
  const a = service.watch('/project', true, () => {}),
    b = service.watch('/project', true, () => {})
  expect(native).toHaveBeenCalledTimes(2)
  a.close()
  b.close()
  expect(close).toHaveBeenCalledTimes(2)
  await service.stop()
})
it('keeps snapshots conservative until every process-owned watch is installed', () => {
  const handles: (EventEmitter & { ready: boolean; close: () => void })[] = []
  const monitor = new WorktreeMonitor('/project', '/git', '/common', () => {
    const handle = Object.assign(new EventEmitter(), { ready: false, close: vi.fn() })
    handles.push(handle)
    return handle
  })
  const invalidate = vi.fn()
  monitor.listen(invalidate)
  expect(monitor.reliable).toBe(false)
  handles[0]!.emit('ready')
  expect(monitor.reliable).toBe(false)
  for (const handle of handles.slice(1)) handle.emit('ready')
  expect(monitor.reliable).toBe(true)
  expect(monitor.generation).toBeGreaterThan(0)
  // Installation is a reconciliation hint, not evidence that events overflowed.
  expect(invalidate).toHaveBeenCalledWith(false)
  monitor.close()
  for (const handle of handles) expect(handle.close).toHaveBeenCalledOnce()
})
