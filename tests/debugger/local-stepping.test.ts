import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { NodeCore } from '../../packages/node-core/src/index.js'
import { JsDebugProfile } from '../../packages/node-core/src/debugger/js-profile.js'
import { JS_DEBUG_PIN } from '../../packages/node-core/src/debugger/js-install.js'
import { target } from './helpers.js'

const stateDirectory = resolve('.scratch/debugger-integration/state')
const installed =
  JS_DEBUG_PIN &&
  existsSync(
    join(stateDirectory, 'debugger/adapters/js-debug', JS_DEBUG_PIN.version, 'installation.json')
  )
async function stepping(out: boolean) {
  mkdirSync(resolve('.scratch/debugger-integration'), { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/debugger-integration/step-'))
  const program = join(dir, 'cart.cjs')
  writeFileSync(
    program,
    [
      'function quote(items) {',
      '  const input = items;',
      '  const lines = input.map((item) => {',
      '    const price = item * 2;',
      '    return price;',
      '  });',
      '  const total = lines.reduce((a, b) => a + b, 0);',
      '  return total;',
      '}',
      'quote([1, 2]);',
      'setInterval(() => {}, 1000);',
    ].join('\n')
  )
  const core = new NodeCore(join(dir, 'state'), { debuggerEnabled: true })
  const profile = new JsDebugProfile(core.debugger, { stateDirectory, enabled: true })
  try {
    const run = await profile.launch(
      { cwd: dir, executable: process.execPath, program, argv: [], env: {} },
      { ...target, build_identity: 'matched' }
    )
    const session = await run.program()
    const until = async (check: () => boolean) => {
      const deadline = Date.now() + 5000
      while (!check()) {
        if (Date.now() > deadline) throw new Error('D8: step lost its stop')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }
    await session.threads()
    await session.patchBreakpoints(
      0,
      [{ breakpoint_id: 'quote', source_id: 'program', line: 2 }],
      []
    )
    const thread = session.snapshot.selected_thread_id!
    let epoch = session.snapshot.stop_epoch
    await session.continue(thread)
    await until(
      () => session.snapshot.execution === 'stopped' && session.snapshot.stop_epoch > epoch
    )
    await session.patchBreakpoints(1, [], ['quote'])
    const steps: ('over' | 'in' | 'out')[] = out ? ['over', 'in', 'out'] : ['over', 'in']
    for (const kind of steps) {
      epoch = session.snapshot.stop_epoch
      await session.step(thread, kind)
      await until(
        () => session.snapshot.execution === 'stopped' && session.snapshot.stop_epoch > epoch
      )
      const stack = await session.stack(thread, 0, 5)
      expect(stack.items[0]?.source_id).toBe('program')
    }
    const stack = await session.stack(thread, 0, 5)
    if (out) expect(stack.items[0]?.name).toBe('quote')
    else expect(stack.items[0]?.line).toBe(4)
    await run.terminate()
  } finally {
    await profile.close()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
const native = it.skipIf(process.env.ABELE_DEBUGGER_LOCAL_TEST !== '1' || !installed)
native('D8: step over then step into preserves the callback stop', () => stepping(false), 30000)
native.fails(
  'BUG: D8 callback step out must stop in quote rather than run on or enter the next callback',
  () => stepping(true),
  30000
)
