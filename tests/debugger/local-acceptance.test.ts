import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { NodeCore } from '../../packages/node-core/src/index.js'
import { JsDebugProfile } from '../../packages/node-core/src/debugger/js-profile.js'
import { jsAdapterInstalled } from '../../packages/node-core/src/debugger/js-install.js'
import { OwnedDebugProcess } from '../../packages/node-core/src/debugger/process.js'
import { target } from './helpers.js'

const stateDirectory = resolve('.scratch/debugger-integration/state')

it.skipIf(process.env.ABELE_DEBUGGER_LOCAL_TEST !== '1' || !jsAdapterInstalled(stateDirectory))(
  'opt-in: watches reconcile a stopped frame and caught exceptions remain controllable',
  async () => {
    mkdirSync('.scratch/debugger-integration', { recursive: true })
    const dir = mkdtempSync(resolve('.scratch/debugger-integration/acceptance-'))
    const program = join(dir, 'app.cjs')
    const unused = join(dir, 'unused.cjs')
    writeFileSync(unused, 'module.exports = 1\n')
    writeFileSync(
      program,
      `function application() {
  const value = 41;
  debugger;
  try { throw new Error('caught acceptance failure'); } catch {}
  setInterval(() => {}, 1000);
}
application();
`
    )
    const core = new NodeCore(join(dir, 'core'), { debuggerEnabled: true })
    const profile = new JsDebugProfile(core.debugger, { stateDirectory, enabled: true })
    const spawn = OwnedDebugProcess.spawn.bind(OwnedDebugProcess)
    // Restricted runners cannot use ps; both processes remain real owned children.
    const spawned = vi.spyOn(OwnedDebugProcess, 'spawn').mockImplementation((exe, argv, options) =>
      spawn(
        exe,
        argv,
        {
          ...options,
          env: { ...options.env, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
        },
        process.env.ABELE_DEBUGGER_TEST_IDENTITY === 'fixture'
          ? async () => 'acceptance-fixture'
          : undefined
      )
    )
    const until = async (check: () => boolean) => {
      const end = Date.now() + 10000
      while (!check()) {
        if (Date.now() > end) throw new Error('acceptance_stop_timeout')
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
    }
    try {
      const run = await profile.launch(
        { executable: process.execPath, cwd: dir, program, argv: [], env: {} },
        target
      )
      const session = await run.program()
      await until(() => session.snapshot.threads.some((t) => t.status === 'stopped'))
      await session.threads()
      await session.exceptionBreakpoints(['all'])
      const entryEpoch = session.snapshot.stop_epoch
      await session.continue(session.snapshot.selected_thread_id!)
      await until(
        () =>
          session.snapshot.stop_epoch > entryEpoch &&
          session.snapshot.threads.some((t) => t.status === 'stopped')
      )
      const thread = session.snapshot.selected_thread_id!
      const stack = await session.stack(thread)
      expect(stack.items[0]?.name).toBe('global.application')
      expect(await session.runtimeSource(program)).toBe('loaded')
      expect(await session.runtimeSource(unused)).toBe('not_loaded')
      const physicalStop = session.snapshot
      expect((await session.evaluate(stack.items[0]!.handle, 'value + 1', 'watch')).value).toBe(
        '42'
      )
      expect(session.snapshot.stop_epoch).toBe(physicalStop.stop_epoch)
      expect(session.snapshot.state_revision).toBe(physicalStop.state_revision)
      expect((await session.scopes(stack.items[0]!.handle)).items.length).toBeGreaterThan(0)
      const fields = (state: typeof physicalStop) => ({
        event_seq: state.event_seq,
        state_revision: state.state_revision,
        stop_epoch: state.stop_epoch,
        selected_thread_id: state.selected_thread_id,
        execution: state.execution,
      })
      writeFileSync(
        resolve('.scratch/debugger-integration/acceptance-watch-state.json'),
        JSON.stringify(
          { before: fields(physicalStop), after_watch: fields(session.snapshot) },
          null,
          2
        )
      )
      let fence = session.snapshot.state_revision
      const guard = Object.assign(
        () => {
          if (session.snapshot.state_revision !== fence) throw new Error('stale_state')
        },
        {
          advanceIntent() {
            fence = session.snapshot.state_revision
          },
        }
      )
      const result = await session.coordinated(guard, () =>
        session.evaluate(stack.items[0]!.handle, 'value + 1')
      )
      expect(result.value).toBe('42')
      expect(session.snapshot.execution).toBe('stopped')
      await expect(session.scopes(stack.items[0]!.handle)).rejects.toThrow('stale_handle')
      const fresh = await session.stack(thread)
      expect((await session.scopes(fresh.items[0]!.handle)).items.length).toBeGreaterThan(0)
      const watchEpoch = session.snapshot.stop_epoch
      await session.continue(thread)
      await until(
        () =>
          session.snapshot.stop_epoch > watchEpoch &&
          session.snapshot.threads.some((t) => t.stop?.reason === 'exception')
      )
      expect(session.dap.closed).toBe(false)
      expect(session.snapshot.execution).toBe('stopped')
      await until(
        () =>
          !!session.snapshot.threads
            .find((t) => t.thread_id === thread)
            ?.stop?.description?.includes('caught acceptance failure')
      )
      expect((await session.stack(thread)).items[0]?.name).toBe('global.application')
      await session.exceptionBreakpoints([])
      await session.continue(thread)
      await until(() => session.snapshot.execution === 'running')
      await run.terminate()
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
  30000
)
