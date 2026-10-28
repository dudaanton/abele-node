import { expect, it } from 'vitest'
import { DapSession, JsSessionTree } from '../../packages/node-core/src/debugger/driver.js'
import { NativeJsRun } from '../../packages/node-core/src/debugger/js-profile.js'
import type { OwnedDebugProcess } from '../../packages/node-core/src/debugger/process.js'
import { target } from './helpers.js'
import { NodeCore } from '../../packages/node-core/src/index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { wire } from './dap-wire.js'

it('does not hand a configuring child to breakpoint callers before startup completes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'program-ready-'))
  const core = new NodeCore(dir, { debuggerEnabled: true })
  const rootWire = wire(),
    childWire = wire()
  const root = new DapSession(core.debugger, core.debugger.create(target), rootWire.dap, new Map())
  const child = new DapSession(
    core.debugger,
    core.debugger.create(target),
    childWire.dap,
    new Map()
  )
  const tree = new JsSessionTree(core.debugger, root, async () => {
    throw new Error('unused')
  })
  tree.children.set(child.id, child)
  const run = new NativeJsRun(tree, {} as OwnedDebugProcess, undefined, () => {})
  let published = false
  const program = run.program().then((session) => {
    published = true
    return session
  })
  try {
    const start = child.start('attach', {})
    childWire.reply(childWire.messages[0])
    childWire.send({ type: 'event', event: 'initialized' })
    for (let i = 0; i < 15; i++) {
      for (const message of childWire.messages.filter(
        (m) => m.command === 'setExceptionBreakpoints' && !m.replied
      )) {
        message.replied = true
        childWire.reply(message)
      }
      await Promise.resolve()
    }
    expect(published).toBe(false)
    childWire.reply(childWire.messages.find((m) => m.command === 'attach'))
    await start
    expect(await program).toBe(child)
    expect(child.snapshot.lifecycle).toBe('active')
  } finally {
    rootWire.dap.close()
    childWire.dap.close()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
