import { expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeCore } from '../../packages/node-core/src/index.js'
import { DapSession } from '../../packages/node-core/src/debugger/driver.js'
import { wire } from './dap-wire.js'
import { target } from './helpers.js'

it('reads the thread inventory when the startup pause predates run adoption', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'startup-inventory-'))
  const core = new NodeCore(dir, { debuggerEnabled: true })
  const w = wire()
  const session = new DapSession(core.debugger, core.debugger.create(target), w.dap, new Map())
  let unsubscribe = () => {}
  try {
    w.send({ type: 'event', event: 'thread', body: { reason: 'started', threadId: 0 } })
    w.send({
      type: 'event',
      event: 'stopped',
      body: { threadId: 0, allThreadsStopped: false, reason: 'pause' },
    })
    expect(session.snapshot.execution).toBe('unknown')
    unsubscribe = (core.debuggerLaunches as any).keepThreads(session)
    expect(w.messages.map((m) => m.command)).toEqual(['threads'])
    w.reply(w.messages[0], { threads: [{ id: 0, name: 'main' }] })
    await Promise.resolve()
    await Promise.resolve()
    expect(session.snapshot.execution).toBe('stopped')
  } finally {
    unsubscribe()
    w.dap.close()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
