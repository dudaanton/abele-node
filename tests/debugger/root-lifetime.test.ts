import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { NodeCore } from '../../packages/node-core/src/index.js'
import { DapSession, JsSessionTree } from '../../packages/node-core/src/debugger/driver.js'
import { wire } from './dap-wire.js'
import { target } from './helpers.js'

const request = {
  seq: 1,
  type: 'request' as const,
  command: 'startDebugging',
  arguments: {
    request: 'attach',
    configuration: {
      type: 'pwa-node',
      name: 'sample',
      __pendingTargetId: 'sample',
    },
  },
}
type Wire = ReturnType<typeof wire>
type Fixture = {
  root: DapSession
  tree: JsSessionTree
  rootWire: Wire
  childWire: Wire
  admit(): Promise<DapSession>
}
async function fixture(work: (f: Fixture) => Promise<void>, connect?: () => Promise<Wire['dap']>) {
  const dir = mkdtempSync(join(tmpdir(), 'dap-root-'))
  const core = new NodeCore(dir, { debuggerEnabled: true })
  const rootWire = wire(),
    childWire = wire()
  const root = new DapSession(core.debugger, core.debugger.create(target), rootWire.dap, new Map())
  const tree = new JsSessionTree(core.debugger, root, connect ?? (async () => childWire.dap), {
    mode: 'attach',
    configuration: { type: 'pwa-node' },
    maxChildren: 1,
  })
  const admit = async () => {
    const started = tree.reverse(request, new AbortController().signal)
    const seen = new Set<number>()
    for (let i = 0; i < 12; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      for (const message of childWire.messages) {
        if (message.type !== 'request' || seen.has(message.seq)) continue
        seen.add(message.seq)
        childWire.reply(
          message,
          message.command === 'initialize' ? { supportsConfigurationDoneRequest: true } : {}
        )
        if (message.command === 'initialize')
          childWire.send({ type: 'event', event: 'initialized' })
      }
    }
    await started
    return tree.children.values().next().value!
  }
  try {
    await work({ root, tree, rootWire, childWire, admit })
  } finally {
    tree.close()
    childWire.dap.close()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

it('keeps the child first stop and final event when the root ends first', () =>
  fixture(async (f) => {
    const child = await f.admit()
    f.childWire.send({
      type: 'event',
      event: 'thread',
      body: { threadId: 0, reason: 'started' },
    })
    f.rootWire.send({ type: 'event', event: 'terminated' })
    f.childWire.send({
      type: 'event',
      event: 'stopped',
      body: { threadId: 0, reason: 'pause', allThreadsStopped: true },
    })
    expect(child.snapshot.execution).toBe('stopped')
    expect(f.rootWire.dap.closed).toBe(false)
    f.childWire.send({ type: 'event', event: 'terminated' })
    expect(child.snapshot.lifecycle).toBe('terminated')
    expect(f.rootWire.dap.closed).toBe(true)
  }))
it('still closes children on actual root transport loss', () =>
  fixture(async (f) => {
    const child = await f.admit()
    f.rootWire.dap.close(new Error('sample_transport_loss'))
    expect(child.snapshot.lifecycle).toBe('connection-lost')
    expect(f.childWire.dap.closed).toBe(true)
  }))
it('closes a terminated root with no children', () =>
  fixture(async (f) => {
    f.rootWire.send({ type: 'event', event: 'terminated' })
    expect(f.rootWire.dap.closed).toBe(true)
  }))
it('waits for a pending child connection and cleans up its failure', async () => {
  let fail!: (error: Error) => void
  await fixture(
    async (f) => {
      const pending = f.tree.reverse(request, new AbortController().signal)
      const rejected = expect(pending).rejects.toThrow('sample_connect_failure')
      f.rootWire.send({ type: 'event', event: 'terminated' })
      const closedEarly = f.rootWire.dap.closed
      fail(new Error('sample_connect_failure'))
      await rejected
      expect(closedEarly).toBe(false)
      expect(f.rootWire.dap.closed).toBe(true)
    },
    () =>
      new Promise((_, reject) => {
        fail = reject
      })
  )
})
