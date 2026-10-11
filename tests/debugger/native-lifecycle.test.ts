import { createServer, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { NodeCore } from '../../packages/node-core/src/index.js'
import { JsDebugProfile, NativeJsRun } from '../../packages/node-core/src/debugger/js-profile.js'
import { OwnedDebugProcess } from '../../packages/node-core/src/debugger/process.js'
import * as installation from '../../packages/node-core/src/debugger/js-install.js'
import { DapSession, JsSessionTree } from '../../packages/node-core/src/debugger/driver.js'
import { wire } from './dap-wire.js'
import { target } from './helpers.js'

describe('native profile resource lifetimes (fake adapter)', () => {
  it('closes a newly connected adapter if initial audit storage fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-dap-')),
      core = new NodeCore(dir, { debuggerEnabled: true })
    const sockets = new Set<Socket>(),
      server = createServer((socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port,
      terminate = vi.fn(async () => {})
    const spawn = vi
      .spyOn(OwnedDebugProcess, 'spawn')
      .mockResolvedValue({ waitForText: async () => /:(\d+)/.exec(':' + port), terminate } as any)
    const installed = vi.spyOn(installation, 'installedJsAdapter').mockResolvedValue({
      version: 'fixture',
      sha256: 'a'.repeat(64),
      license: 'MIT',
      url: 'https://example.invalid',
      files: {},
      entry: 'fixture',
    })
    try {
      const profile = new JsDebugProfile(core.debugger, { stateDirectory: dir })
      vi.spyOn(core.debugger, 'create').mockImplementation(() => {
        throw new Error('fixture_storage_failure')
      })
      // Exercise the trusted resource builder directly; never bypass the production
      // audit gate to install or run an actual unreviewed adapter.
      await expect((profile as any).open({}, target, new Map())).rejects.toThrow(
        'fixture_storage_failure'
      )
      await new Promise((resolve) => setTimeout(resolve, 30))
      expect(sockets.size).toBe(0)
      expect(terminate).toHaveBeenCalledOnce()
    } finally {
      spawn.mockRestore()
      installed.mockRestore()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      core.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('detaches without killing a launched target and cleans the adapter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-dap-')),
      core = new NodeCore(dir, { debuggerEnabled: true })
    const owner = await OwnedDebugProcess.spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      {}
    )
    const adapter = await OwnedDebugProcess.spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      {}
    )
    const w = wire(),
      state = core.debugger.create({
        ...target,
        process_ownership: 'owned',
        process_evidence: owner.evidence,
      })
    const root = new DapSession(core.debugger, state, w.dap, new Map()),
      tree = new JsSessionTree(core.debugger, root, async () => {
        throw new Error('denied')
      })
    const removed = vi.fn(),
      run = new NativeJsRun(tree, adapter, owner, removed)
    try {
      const detach = run.detach()
      await Promise.resolve()
      expect(w.messages[0].arguments.terminateDebuggee).toBe(false)
      w.reply(w.messages[0])
      await detach
      expect(owner.alive).toBe(true)
      expect(adapter.alive).toBe(false)
      expect(removed).toHaveBeenCalledOnce()
      expect(root.snapshot.lifecycle).toBe('detached')
    } finally {
      await owner.terminate()
      await adapter.terminate()
      w.dap.close()
      core.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it.each(['root_rejected', 'child_rejected', 'timeout', 'transport_lost'] as const)(
    'releases a still-alive target after uncertain detach: %s',
    async (kind) => {
      const dir = mkdtempSync(join(tmpdir(), 'native-dap-')),
        core = new NodeCore(dir, { debuggerEnabled: true })
      const owner = await OwnedDebugProcess.spawn(
        process.execPath,
        ['-e', 'setInterval(()=>{},1000)'],
        {}
      )
      const adapter = await OwnedDebugProcess.spawn(
        process.execPath,
        ['-e', 'setInterval(()=>{},1000)'],
        {}
      )
      const release = vi.spyOn(owner, 'release'),
        kill = vi.spyOn(owner, 'terminate')
      const w = wire({ requestTimeoutMs: 20 }),
        childWire = wire({ requestTimeoutMs: 20 })
      const root = new DapSession(core.debugger, core.debugger.create(target), w.dap, new Map())
      const tree = new JsSessionTree(core.debugger, root, async () => {
        throw new Error('denied')
      })
      if (kind === 'child_rejected') {
        const child = new DapSession(
          core.debugger,
          core.debugger.create(target),
          childWire.dap,
          new Map()
        )
        tree.children.set(child.id, child)
      }
      const run = new NativeJsRun(tree, adapter, owner, () => {})
      try {
        const pending = run.detach()
        const rejected = expect(pending).rejects.toThrow(
          kind === 'timeout' ? 'dap_timeout' : kind === 'transport_lost' ? 'lost' : 'dap_rejected'
        )
        await Promise.resolve()
        if (kind === 'root_rejected') w.reply(w.messages[0], {}, false)
        else if (kind === 'child_rejected') childWire.reply(childWire.messages[0], {}, false)
        else if (kind === 'transport_lost') w.dap.close(new Error('lost'))
        await rejected
        expect(owner.alive).toBe(true)
        expect(release).toHaveBeenCalledOnce()
        expect(kill).not.toHaveBeenCalled()
        expect(adapter.alive).toBe(false)
      } finally {
        await owner.terminate()
        await adapter.terminate()
        w.dap.close()
        childWire.dap.close()
        core.close()
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
  it.each([false, true])(
    'all concurrent run/profile close calls await the same cleanup outcome (failure=%s)',
    async (failure) => {
      let settleOwner!: () => void
      const ownerDone = new Promise<void>((resolve) => {
        settleOwner = resolve
      })
      const owner = { terminate: vi.fn(() => ownerDone) } as unknown as OwnedDebugProcess
      let settleAdapter!: () => void
      const adapterDone = new Promise<void>((resolve) => {
        settleAdapter = resolve
      })
      const adapter = {
        terminate: vi.fn(async () => {
          await adapterDone
          if (failure) throw new Error('cleanup_failed')
        }),
      } as unknown as OwnedDebugProcess
      const tree = { close: vi.fn() } as unknown as JsSessionTree
      const removed = vi.fn(),
        run = new NativeJsRun(tree, adapter, owner, removed)
      const profile = new JsDebugProfile({} as any, { stateDirectory: 'unused' })
      ;(profile as any).runs.add(run)
      let secondSettled = false,
        profileSettled = false
      const first = run.close(),
        second = run.close()
      void first.catch(() => {})
      void second.catch(() => {})
      const shutdown = profile.close()
      void shutdown.catch(() => {})
      void second.then(
        () => {
          secondSettled = true
        },
        () => {
          secondSettled = true
        }
      )
      void shutdown.then(
        () => {
          profileSettled = true
        },
        () => {
          profileSettled = true
        }
      )
      try {
        await Promise.resolve()
        await Promise.resolve()
        expect(secondSettled).toBe(false)
        expect(profileSettled).toBe(false)
        settleOwner()
        await Promise.resolve()
        await Promise.resolve()
        expect(adapter.terminate).toHaveBeenCalledOnce()
        expect(secondSettled).toBe(false)
        settleAdapter()
        const outcomes = await Promise.allSettled([first, second, shutdown])
        expect(
          outcomes.every((outcome) => outcome.status === (failure ? 'rejected' : 'fulfilled'))
        ).toBe(true)
        expect(owner.terminate).toHaveBeenCalledOnce()
        expect(tree.close).toHaveBeenCalledOnce()
        expect(removed).toHaveBeenCalledOnce()
      } finally {
        settleOwner()
        settleAdapter()
        await Promise.allSettled([first, second, shutdown])
      }
    }
  )
  it('shutdown cleanup remains independent of failed audit writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'native-dap-')),
      core = new NodeCore(dir, { debuggerEnabled: true })
    const owner = await OwnedDebugProcess.spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      {}
    )
    const adapter = await OwnedDebugProcess.spawn(
      process.execPath,
      ['-e', 'setInterval(()=>{},1000)'],
      {}
    )
    const w = wire(),
      root = new DapSession(core.debugger, core.debugger.create(target), w.dap, new Map()),
      tree = new JsSessionTree(core.debugger, root, async () => {
        throw new Error('denied')
      })
    const run = new NativeJsRun(tree, adapter, owner, () => {})
    try {
      core.db.exec(
        "CREATE TRIGGER debug_failure BEFORE INSERT ON debug_events BEGIN SELECT RAISE(FAIL, 'fixture_storage_failure'); END;"
      )
      await run.close()
      expect(owner.alive).toBe(false)
      expect(adapter.alive).toBe(false)
      expect(w.dap.closed).toBe(true)
    } finally {
      await owner.terminate()
      await adapter.terminate()
      w.dap.close()
      core.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
