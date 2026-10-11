import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
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
// No installer, real adapter, network, application or model runs in ordinary CI.
// The audit gate deliberately leaves this test skipped until a clean pin exists.
it.skipIf(process.env.ABELE_DEBUGGER_LOCAL_TEST !== '1' || !installed)(
  'opt-in: pinned js-debug stops, inspects and steps a node-owned synthetic program',
  async () => {
    mkdirSync(resolve('.scratch/debugger-integration'), { recursive: true })
    const dir = mkdtempSync(resolve('.scratch/debugger-integration/run-'))
    const program = join(dir, 'tiny.cjs')
    writeFileSync(
      program,
      'const input = 40;\nconst answer = input + 2;\nconsole.log(answer);\nsetInterval(() => {}, 1000);\n'
    )
    const core = new NodeCore(join(dir, 'core'), { debuggerEnabled: true })
    const profile = new JsDebugProfile(core.debugger, { stateDirectory, enabled: true })
    try {
      const run = await profile.launch(
        { executable: process.execPath, cwd: dir, program, argv: [], env: {} },
        target
      )
      const until = async (check: () => boolean) => {
        const end = Date.now() + 10000
        while (!check()) {
          if (Date.now() > end) throw new Error('local_debugger_timeout')
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
      }
      await until(() =>
        [...run.tree.children.values()].some((s) => s.snapshot.execution === 'stopped')
      )
      const session = [...run.tree.children.values()].find(
        (s) => s.snapshot.execution === 'stopped'
      )!
      const thread = session.snapshot.selected_thread_id!
      const stack = await session.stack(thread, 0, 1)
      expect(stack.items[0]?.source_id).toBe('program')
      const scopes = await session.scopes(stack.items[0]!.handle)
      const object = scopes.items.find((scope) => scope.handle)
      expect(object).toBeDefined()
      const values = await session.variables(object!.handle!, 0, 10)
      expect(values.snapshot.execution).toBe('stopped')
      const epoch = session.snapshot.stop_epoch
      await session.step(thread, 'over')
      await until(
        () => session.snapshot.execution === 'stopped' && session.snapshot.stop_epoch > epoch
      )
      await expect(session.scopes(stack.items[0]!.handle)).rejects.toThrow('stale_handle')
      await run.terminate()
      expect(run.tree.root.snapshot.lifecycle).toBe('terminated')
    } finally {
      await profile.close()
      core.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
  30000
)
