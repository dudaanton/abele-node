import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { OwnedDebugProcess } from '../../packages/node-core/src/debugger/process.js'
import { NodeCore, DapDebuggerBackend } from '../../packages/node-core/src/index.js'
import { JsDebugProfile } from '../../packages/node-core/src/debugger/js-profile.js'
import { jsAdapterInstalled } from '../../packages/node-core/src/debugger/js-install.js'
import { target } from './helpers.js'

const stateDirectory = resolve('.scratch/debugger-integration/state')
it.skipIf(process.env.ABELE_DEBUGGER_LOCAL_TEST !== '1' || !jsAdapterInstalled(stateDirectory))(
  'real js-debug: undefined watches and throwing getters preserve the stop and controls',
  async () => {
    mkdirSync('.scratch/debugger-integration', { recursive: true })
    const dir = mkdtempSync(resolve('.scratch/debugger-integration/failed-evaluate-'))
    const program = join(dir, 'main.cjs')
    writeFileSync(
      program,
      [
        'const object = { get throwingGetter() { throw new Error("getter failed") } };',
        'debugger;',
        'const value = 1;',
        'console.log("console-once");',
        'console.warn("warning-once");',
        'process.stderr.write("direct-stderr-once\\n");',
        'debugger;',
        'setInterval(() => {}, 1000);',
      ].join('\n')
    )
    const core = new NodeCore(join(dir, 'state'), { debuggerEnabled: true })
    const profile = new JsDebugProfile(core.debugger, { stateDirectory, enabled: true })
    const outputs: string[] = []
    const observe = core.debugger.observe.bind(core.debugger)
    vi.spyOn(core.debugger, 'observe').mockImplementation((...args) => {
      if (args[2].kind === 'output') outputs.push(args[2].text)
      return observe(...args)
    })
    const spawn = OwnedDebugProcess.spawn.bind(OwnedDebugProcess)
    const spawned = vi.spyOn(OwnedDebugProcess, 'spawn').mockImplementation((exe, argv, options) =>
      spawn(
        exe,
        argv,
        {
          ...options,
          env: { ...options.env, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
        },
        process.env.ABELE_DEBUGGER_TEST_IDENTITY === 'fixture'
          ? async () => 'failed-evaluate-fixture'
          : undefined
      )
    )
    try {
      const run = await profile.launch(
        { cwd: dir, executable: process.execPath, program, argv: [], env: {} },
        target
      )
      const session = await run.program()
      const until = async (epoch: number) => {
        const deadline = Date.now() + 5000
        while (session.snapshot.execution !== 'stopped' || session.snapshot.stop_epoch <= epoch) {
          if (Date.now() > deadline) throw new Error('lost stop')
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      await session.threads()
      const thread = session.snapshot.selected_thread_id!
      let epoch = session.snapshot.stop_epoch
      await session.continue(thread)
      await until(epoch)
      const owner = core.authority.authenticate(core.createToken('failed-watch').token)
      const human = { kind: 'human' as const, authority: owner }
      core.debuggerControl.registerBackend(session.id, new DapDebuggerBackend(session))
      const stack = await session.stack(thread)
      const watchEpoch = session.snapshot.stop_epoch
      const proposal = await core.debuggerControl.command(human, 'evaluate', {
        operation_id: 'undefined-watch',
        debug_session_id: session.id,
        incarnation: session.incarnation,
        expected_state_revision: session.snapshot.state_revision,
        frame_handle: stack.items[0]!.handle,
        expression: 'missingSample',
        context: 'watch',
      })
      const failed = await core.debuggerControl.approve(owner, {
        principal_key: core.debuggerControl.principalKey(human),
        operation_id: 'undefined-watch',
        proposal_hash: proposal.proposal_hash,
        decision: 'approve',
      })
      expect(failed).toMatchObject({
        outcome: 'failed',
        dispatch: 'dispatched',
        code: 'adapter_rejected',
        snapshot: { execution: 'stopped', stop_epoch: watchEpoch },
      })
      expect(failed.message).toContain('missingSample is not defined')
      for (const context of ['watch', 'repl'] as const) {
        for (const expression of ['missingName.field', 'object.throwingGetter']) {
          const stack = await session.stack(thread)
          await expect(
            session.evaluate(stack.items[0]!.handle, expression, context)
          ).rejects.toThrow()
          await new Promise((resolve) => setTimeout(resolve, 300))
          expect(session.snapshot.execution).toBe('stopped')
        }
      }
      epoch = session.snapshot.stop_epoch
      await session.step(thread, 'over')
      await until(epoch)
      epoch = session.snapshot.stop_epoch
      await session.continue(thread)
      await until(epoch)
      // The same watches remain configured when the next physical stop arrives.
      for (const expression of ['missingName.field', 'object.throwingGetter']) {
        const stack = await session.stack(thread)
        await expect(
          session.evaluate(stack.items[0]!.handle, expression, 'watch')
        ).rejects.toThrow()
        expect(session.snapshot.execution).toBe('stopped')
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
      for (const text of ['console-once', 'warning-once', 'direct-stderr-once'])
        expect(outputs.join('').split(text)).toHaveLength(2)
      await run.terminate()
    } finally {
      await profile.close()
      spawned.mockRestore()
      core.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
  30000
)
