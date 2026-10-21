import { afterEach, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'

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
  return { service, read, started, finish, peak: () => peak }
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
