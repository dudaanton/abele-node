import { existsSync, mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { OwnedDebugProcess } from '../../packages/node-core/src/debugger/process.js'
import { NodeCore } from '../../packages/node-core/src/index.js'
import { JsDebugProfile } from '../../packages/node-core/src/debugger/js-profile.js'
import { jsAdapterInstalled } from '../../packages/node-core/src/debugger/js-install.js'
import { target } from './helpers.js'

const stateDirectory = resolve('.scratch/debugger-integration/state')
it.skipIf(process.env.ABELE_DEBUGGER_LOCAL_TEST !== '1' || !jsAdapterInstalled(stateDirectory))(
  'opt-in: real js-debug keeps closure, async, generator and class frames alive during inspection',
  async () => {
    mkdirSync('.scratch/debugger-integration', { recursive: true })
    const dir = mkdtempSync(resolve('.scratch/debugger-integration/scopes-'))
    const program = join(dir, 'frames.cjs')
    const marker = join(dir, 'executed')
    writeFileSync(
      program,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')
function closure(value) { const read = () => value; debugger; return read() }
async function asynchronous(value) { await Promise.resolve(); debugger; return value }
function* generator(value) { debugger; yield value }
class Sample { run(value) { debugger; return value } }
async function main() {
  closure(41)
  await asynchronous(42)
  generator(43).next()
  new Sample().run(44)
  console.log('inspection-complete')
}
main()
`
    )
    const core = new NodeCore(join(dir, 'core'), { debuggerEnabled: true })
    const profile = new JsDebugProfile(core.debugger, { stateDirectory, enabled: true })
    // Only the restricted local runner opts out of ps-based identity discovery.
    // Both program and adapter remain real direct children, with normal cleanup.
    const spawn = OwnedDebugProcess.spawn.bind(OwnedDebugProcess)
    let owner: OwnedDebugProcess | undefined
    const spawned = vi
      .spyOn(OwnedDebugProcess, 'spawn')
      .mockImplementation(async (exe, argv, options) => {
        const child = await spawn(
          exe,
          argv,
          {
            ...options,
            env: { ...options.env, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
          },
          process.env.ABELE_DEBUGGER_TEST_IDENTITY === 'fixture'
            ? async () => 'scope-fixture'
            : undefined
        )
        if (argv.includes(program)) owner = child
        return child
      })
    const until = async (check: () => boolean) => {
      const end = Date.now() + 10000
      while (!check()) {
        if (Date.now() > end) throw new Error('scope_inspection_timeout')
        await new Promise((r) => setTimeout(r, 10))
      }
    }
    try {
      for (let attempt = 0; attempt < 24; attempt++) {
        rmSync(marker, { force: true })
        const run = await profile.launch(
          { executable: process.execPath, cwd: dir, program, argv: [], env: {} },
          target
        )
        try {
          const session = await run.program()
          let epoch = 0
          for (const name of ['', 'closure', 'asynchronous', 'generator', 'run']) {
            await until(
              () =>
                (session.snapshot.stop_epoch > epoch &&
                  session.snapshot.threads.some((t) => t.status === 'stopped')) ||
                session.dap.closed
            )
            expect(session.snapshot.lifecycle).toBe('active')
            await session.threads()
            expect(session.snapshot.execution).toBe('stopped')
            const thread = session.snapshot.selected_thread_id!
            const stack = await session.stack(thread)
            if (!name) expect(existsSync(marker)).toBe(false)
            if (name) expect(stack.items[0]!.name).toContain(name)
            const scopes = await session.scopes(stack.items[0]!.handle)
            const values = []
            for (const scope of scopes.items.filter((s) => !s.expensive && s.handle))
              values.push(...(await session.variables(scope.handle!, 0, 50)).items)
            if (name)
              expect(values.some((v) => v.name === 'value' && Number(v.value) >= 41)).toBe(true)
            epoch = session.snapshot.stop_epoch
            await session.continue(thread)
          }
          await until(() => session.dap.closed)
          await owner!.waitForExit()
          expect(owner!.diagnostics).toMatchObject({ exit_code: 0, signal: null })
        } finally {
          await run.close()
        }
      }
    } finally {
      try {
        await profile.close()
      } finally {
        spawned.mockRestore()
        core.close()
        rmSync(dir, { recursive: true, force: true })
      }
    }
  },
  120000
)
