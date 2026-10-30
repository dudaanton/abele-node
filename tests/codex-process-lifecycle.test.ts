import { afterEach, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import type { ProcessIdentity } from '@abele/provider-contract'
import { CodexProcessInventory } from '../packages/provider-codex/src/processes.js'
import { RpcPeer } from '../packages/provider-codex/src/rpc.js'

vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}))
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})
const root = { pid: 99999999, group: 99999999, fingerprint: 'root' }
const child = { pid: 99999998, group: root.group, fingerprint: 'child' }

it('persists the removal of an exited child and ignores an unrelated process reusing its PID', () => {
  const live = new Map<number, ProcessIdentity>([
    [root.pid, root],
    [child.pid, child],
  ])
  const persist = vi.fn()
  const inventory = new CodexProcessInventory(
    'a'.repeat(64),
    persist,
    {
      identity: (pid) => live.get(pid),
      groupMembers: () => [],
    },
    () => []
  )
  inventory.add([root, child])
  live.delete(child.pid)
  inventory.sample(root)
  expect(persist).toHaveBeenLastCalledWith([root])
  live.set(child.pid, { ...child, fingerprint: 'unrelated' })
  expect(() => inventory.sample(root)).not.toThrow()
  expect(persist).toHaveBeenLastCalledWith([root])
})

it('forgets a recycled child even when its exit was between samples, without signalling its replacement', async () => {
  vi.useFakeTimers()
  const unrelated = { ...child, group: child.pid, fingerprint: 'unrelated' }
  const detached = { pid: 99999997, group: 99999997, fingerprint: 'owned-detached' }
  const live = new Map<number, ProcessIdentity>([
    [root.pid, root],
    [child.pid, unrelated],
    [detached.pid, detached],
  ])
  const persist = vi.fn()
  const probe = {
    identity: (pid: number) => live.get(pid),
    groupMembers: (leader: ProcessIdentity) =>
      [...live.values()].filter((p) => p.group === leader.group),
  }
  const inventory = new CodexProcessInventory('a'.repeat(64), persist, probe, () =>
    live.has(detached.pid) ? [detached] : []
  )
  inventory.add([root, child])
  expect(() => inventory.sample(root)).not.toThrow()
  expect(persist).toHaveBeenLastCalledWith([root])
  const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
    for (const identity of live.values())
      if (pid === identity.pid || pid === -identity.group) live.delete(identity.pid)
    return true
  })
  const cleanup = inventory.cleanup()
  await vi.runAllTimersAsync()
  await cleanup
  expect(live.get(unrelated.pid)).toEqual(unrelated)
  expect(live.has(detached.pid)).toBe(false)
  expect(kill.mock.calls.every(([pid]) => pid !== unrelated.pid && pid !== -unrelated.group)).toBe(
    true
  )
})

it('keeps a detached child in the persisted inventory after its root exits', () => {
  const detached = { ...child, group: child.pid }
  const persist = vi.fn()
  const inventory = new CodexProcessInventory(
    'a'.repeat(64),
    persist,
    {
      identity: (pid) => (pid === child.pid ? detached : undefined),
      groupMembers: () => [],
    },
    () => []
  )
  inventory.add([root, child])
  inventory.sample(root)
  expect(persist).toHaveBeenLastCalledWith([detached])
})

it('still fences a changed root and strict pre-signal identity checks', () => {
  const inventory = new CodexProcessInventory(
    'a'.repeat(64),
    () => {},
    {
      identity: (pid) => ({ pid, group: root.group, fingerprint: 'replacement' }),
      groupMembers: () => [],
    },
    () => []
  )
  inventory.add([root, child])
  expect(() => inventory.sample(root)).toThrow('process_identity_changed')
  expect(() => inventory.refresh()).toThrow('process_identity_changed')
})

it('keeps the persisted inventory intact when a later probe fails during refresh', () => {
  const persist = vi.fn()
  const inventory = new CodexProcessInventory(
    'a'.repeat(64),
    persist,
    {
      identity: (pid) => {
        if (pid === child.pid) throw new Error('process_probe_unavailable')
        return { ...root, group: child.pid }
      },
      groupMembers: () => [],
    },
    () => []
  )
  inventory.add([root, child])
  expect(() => inventory.refresh()).toThrow('process_probe_unavailable')
  expect(persist).toHaveBeenCalledExactlyOnceWith([root, child])
})

async function peerFixture(test: (peer: RpcPeer) => Promise<void>) {
  vi.useFakeTimers()
  const dir = mkdtempSync(resolve('.scratch/codex-sampler-'))
  const child = Object.assign(new EventEmitter(), {
    pid: root.pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
  })
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>)
  // Supervision tests use a fake transport. Inventory signal containment is tested above.
  vi.spyOn(CodexProcessInventory.prototype, 'cleanup').mockImplementation(async () => {
    child.emit('close', 0, null)
  })
  let peer: RpcPeer | undefined
  try {
    peer = await RpcPeer.start({
      executable: {
        executable: '/tmp/sample-codex',
        interpreter: undefined,
        sha256: 'fixture',
        version: '0.160.1',
        recheck() {},
      },
      cwd: dir,
      home: dir,
      processes() {},
      probe: { identity: () => root, groupMembers: () => [root] },
    })
    await test(peer)
  } finally {
    vi.mocked(CodexProcessInventory.prototype.sample).mockRestore?.()
    await peer?.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

it.each([
  'process_probe_unavailable',
  'process_inventory_unavailable',
  'codex_process_inventory_unavailable',
])(
  'retries transient %s failures and resets the consecutive failure budget after recovery',
  async (message) => {
    await peerFixture(async (peer) => {
      const sample = vi
        .spyOn(CodexProcessInventory.prototype, 'sample')
        .mockImplementationOnce(() => {
          throw new Error(message)
        })
        .mockImplementationOnce(() => {
          throw new Error(message)
        })
      await vi.advanceTimersByTimeAsync(1000)
      expect(peer.signal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(500) // successful sample resets the retry budget
      sample.mockImplementation(() => {
        throw new Error(message)
      })
      await vi.advanceTimersByTimeAsync(1000)
      expect(peer.signal.aborted).toBe(false)
      await vi.advanceTimersByTimeAsync(500)
      expect(await peer.lost).toBe(`codex_process_inventory_unavailable:${message}`)
    })
  }
)

it.each(['process_identity_changed', 'injected_evidence_write_failed'])(
  'retains fatal inventory error %s without retrying',
  async (message) => {
    await peerFixture(async (peer) => {
      vi.spyOn(CodexProcessInventory.prototype, 'sample').mockImplementation(() => {
        throw new Error(message)
      })
      await vi.advanceTimersByTimeAsync(500)
      expect(await peer.lost).toBe(`codex_process_inventory_unavailable:${message}`)
    })
  }
)
