import { it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LspService } from '../packages/node-core/src/lsp/service.js'
import { execFile, spawn } from 'node:child_process'

vi.mock('node:child_process', async (original) => ({
  ...(await original<any>()),
  spawn: vi.fn((await original<any>()).spawn),
  execFile: vi.fn(() => {
    throw new Error('spawn EPERM')
  }),
}))
vi.mock('node:os', async (original) => ({
  ...(await original<any>()),
  totalmem: () => 32 * 1024 ** 3,
}))

it('does not retain a half-created server slot when process launch is denied', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lsp-spawn-'))
  writeFileSync(join(root, 'a.ts'), '')
  const service = new LspService(root, {
    trusted: () => true,
    check: (base, path) => join(base, path),
    command: () => ({ command: process.execPath, args: [resolve('tests/fixtures/fake-lsp.mjs')] }),
  })
  vi.mocked(spawn).mockImplementationOnce(() => {
    throw new Error('spawn EPERM')
  })
  try {
    await expect(service.open(root, 'a.ts')).rejects.toThrow('spawn EPERM')
    await expect(service.stop()).resolves.toBeUndefined()
  } finally {
    await service.stop().catch(() => {})
    rmSync(root, { recursive: true, force: true })
  }
})

it('keeps serving when the OS refuses the optional RSS process inventory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lsp-monitor-'))
  writeFileSync(join(root, 'a.ts'), '')
  const service = new LspService(root, {
    trusted: () => true,
    check: (base, path) => join(base, path),
    command: () => ({ command: process.execPath, args: [resolve('tests/fixtures/fake-lsp.mjs')] }),
  })
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    await service.open(root, 'a.ts')
    expect(() => vi.advanceTimersByTime(5000)).not.toThrow()
    expect(await service.query(root, 'a.ts', 'hover', { line: 0, character: 0 })).toBeDefined()
  } finally {
    await service.stop()
    vi.useRealTimers()
    rmSync(root, { recursive: true, force: true })
  }
})

it('budgets a 3 GB monorepo process tree', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lsp-memory-'))
  writeFileSync(join(root, 'a.ts'), '')
  const service = new LspService(root, {
    trusted: () => true,
    check: (base, path) => join(base, path),
    command: () => ({ command: process.execPath, args: [resolve('tests/fixtures/fake-lsp.mjs')] }),
  })
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    await service.open(root, 'a.ts')
    const slot = [...(service as any).slots.values()][0],
      pid = slot.connection.child.pid
    vi.mocked(execFile).mockImplementation(((
      _cmd: any,
      _args: any,
      _options: any,
      callback: any
    ) => {
      callback(null, `${pid} 1 1048576\n999991 ${pid} 1048576\n999992 ${pid} 1048576\n`)
      return {} as any
    }) as any)
    const kill = vi.spyOn(slot.connection, 'kill')
    expect(vi.mocked(spawn).mock.calls.at(-1)?.[2]?.env?.NODE_OPTIONS).toBe(
      '--max-old-space-size=3072'
    )
    vi.advanceTimersByTime(5000)
    expect(kill).not.toHaveBeenCalled()
    expect(await service.query(root, 'a.ts', 'hover', { line: 0, character: 0 })).toBeDefined()
  } finally {
    await service.stop()
    vi.useRealTimers()
    vi.mocked(execFile).mockReset()
    rmSync(root, { recursive: true, force: true })
  }
})

it('reports watchdog stops separately and restarts a failed slot on explicit open', async () => {
  const root = mkdtempSync(resolve('.scratch/lsp-watchdog-'))
  writeFileSync(join(root, 'a.ts'), '')
  const service = new LspService(root, {
    memoryMB: 128,
    trusted: () => true,
    check: (base, path) => join(base, path),
    command: () => ({ command: process.execPath, args: [resolve('tests/fixtures/fake-lsp.mjs')] }),
  })
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  try {
    await service.open(root, 'a.ts')
    const slot = [...(service as any).slots.values()][0]
    const pid = slot.connection.child.pid
    vi.mocked(execFile).mockImplementation(((_c: any, _a: any, _o: any, cb: any) => {
      cb(null, `${pid} 1 1024\n999991 ${pid} 262144\n`)
      return {} as any
    }) as any)
    vi.advanceTimersByTime(5000)
    await expect.poll(() => service.lastFailure(root, 'typescript')).toBe('lsp_memory_limit')
    expect(service.failureMessage(root, 'typescript')).toContain('128 MB')
    expect(service.failureMessage(root, 'typescript')).toContain('ABELE_LSP_MEMORY_MB')
    expect(slot.crashes).toBe(0)
    const old = slot.connection
    await service.open(root, 'a.ts')
    expect(slot.connection).not.toBe(old)
    expect(service.lastFailure(root, 'typescript')).toBeUndefined()
  } finally {
    await service.stop()
    vi.useRealTimers()
    vi.mocked(execFile).mockReset()
    rmSync(root, { recursive: true, force: true })
  }
})

it.each([true, false])(
  'reports repeated worker crashes through a root alias (ps succeeds: %s)',
  async (inventoryAvailable) => {
    const dir = mkdtempSync(resolve('.scratch/lsp-root-alias-'))
    const actual = join(dir, 'actual'),
      root = join(dir, 'alias')
    mkdirSync(actual)
    symlinkSync(actual, root, 'dir')
    writeFileSync(join(actual, 'a.ts'), '')
    const service = new LspService(dir, {
      trusted: () => true,
      check: (base, path) => join(base, path),
      command: () => ({
        command: process.execPath,
        args: [resolve('tests/fixtures/fake-lsp.mjs')],
      }),
    })
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      await service.open(root, 'a.ts')
      const slot = [...(service as any).slots.values()][0]
      const inventory = vi.mocked(execFile).mockImplementation(((
        _c: any,
        _a: any,
        _o: any,
        cb: any
      ) => {
        cb(
          inventoryAvailable ? null : new Error('ps denied'),
          `${slot.connection.child.pid} 1 65536\n`
        )
        return {} as any
      }) as any)
      const before = inventory.mock.calls.length
      vi.advanceTimersByTime(5000)
      expect(inventory.mock.calls.length).toBe(before + 1)
      const previous = slot.connection
      previous.notify('workerCrash', {})
      await expect.poll(() => slot.connection !== previous, { timeout: 5000 }).toBe(true)
      await service.open(root, 'a.ts')
      vi.advanceTimersByTime(5000)
      expect(inventory.mock.calls.length).toBe(before + 2)
      const closed = once(slot.connection.child, 'close', { signal: AbortSignal.timeout(5000) })
      slot.connection.notify('workerCrash', {})
      await closed
      expect(service.lastFailure(realpathSync(root), 'typescript')).toBe('lsp_repeated_crash')
      expect(service.lastFailure(root, 'typescript')).toBe('lsp_repeated_crash')
      expect(service.failureMessage(root, 'typescript')).toContain('heap out of memory')
      expect(service.failureMessage(root, 'typescript')).toContain('SIGABRT')
      await expect(service.open(root, 'a.ts')).resolves.toEqual({ servers: ['typescript'] })
      expect(service.lastFailure(root, 'typescript')).toBeUndefined()
    } finally {
      await service.stop()
      vi.useRealTimers()
      vi.mocked(execFile).mockReset()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
