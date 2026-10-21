import { it, expect, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
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

it('budgets the complete language-server process tree above the observed 445 MB baseline', async () => {
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
      callback(null, `${pid} 1 153600\n999991 ${pid} 153600\n999992 ${pid} 148480\n`)
      return {} as any
    }) as any)
    const kill = vi.spyOn(slot.connection, 'kill')
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
