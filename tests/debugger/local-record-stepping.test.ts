import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { OwnedDebugProcess } from '../../packages/node-core/src/debugger/process.js'
import { NodeCore } from '../../packages/node-core/src/index.js'
import { JsDebugProfile } from '../../packages/node-core/src/debugger/js-profile.js'
import { jsAdapterInstalled } from '../../packages/node-core/src/debugger/js-install.js'
import { TracePoints, TraceRecorder } from '../../packages/node-core/src/trace/recorder.js'
import { TraceStore } from '../../packages/node-core/src/trace/store.js'
import { target } from './helpers.js'

const stateDirectory = resolve('.scratch/debugger-integration/state')
it
  .skipIf(process.env.ABELE_DEBUGGER_LOCAL_TEST !== '1' || !jsAdapterInstalled(stateDirectory))
  .each([
    'callee-record',
    'callee-breakpoint',
    'next-line-record',
    'out-remainder-record',
    'in-skipped-record',
  ])(
  'real js-debug: completes a step with %s',
  async (kind) => {
    mkdirSync('.scratch/debugger-integration', { recursive: true })
    const dir = mkdtempSync(resolve('.scratch/debugger-integration/record-step-'))
    const program = join(dir, 'main.cjs')
    const skipped = join(dir, 'skipped.cjs')
    writeFileSync(
      skipped,
      'module.exports = function skipped() {\n  const value = 5;\n  return value;\n};\n'
    )
    writeFileSync(
      program,
      [
        'function callee() {',
        '  const value = 42;',
        '  return value;',
        '}',
        'function caller() {',
        '  debugger;',
        kind === 'out-remainder-record'
          ? '  const result = callee() + extra();'
          : kind === 'in-skipped-record'
            ? '  const result = require("./skipped.cjs")();'
            : '  const result = callee();',
        '  const after = result + 1;',
        '  return after;',
        '}',
        'require("./skipped.cjs")(); callee(); caller();',
        'setInterval(() => {}, 1000);',
        'function extra() {',
        '  const extraValue = 1;',
        '  return extraValue;',
        '}',
      ].join('\n')
    )
    const core = new NodeCore(join(dir, 'state'), { debuggerEnabled: true })
    const profile = new JsDebugProfile(core.debugger, { stateDirectory, enabled: true })
    const points = new TracePoints()
    const store = new TraceStore(join(dir, 'runs'))
    const recorder = new TraceRecorder({
      service: core.debugger,
      points,
      storeFor: () => store,
      rootFor: () => dir,
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
          ? async () => 'record-step-fixture'
          : undefined
      )
    )
    try {
      const run = await profile.launch(
        { cwd: dir, executable: process.execPath, program, argv: [], env: {} },
        { ...target, build_identity: 'matched' },
        new Map([
          ['program', program],
          ['skipped', skipped],
        ])
      )
      const session = await run.program()
      const stops: unknown[] = []
      session.dap.onEvent((event) => {
        if (event.event === 'stopped') stops.push(event.body)
      })
      const until = async (epoch: number) => {
        const deadline = Date.now() + 5000
        while (session.snapshot.execution !== 'stopped' || session.snapshot.stop_epoch <= epoch) {
          if (Date.now() > deadline) throw new Error('lost step stop')
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
      }
      await session.threads()
      const thread = session.snapshot.selected_thread_id!
      let epoch = session.snapshot.stop_epoch
      await session.continue(thread)
      await until(epoch)
      epoch = session.snapshot.stop_epoch
      await session.step(thread, 'over')
      await until(epoch)
      expect((await session.stack(thread)).items[0]?.line).toBe(7)
      if (kind === 'out-remainder-record') {
        epoch = session.snapshot.stop_epoch
        await session.step(thread, 'in')
        await until(epoch)
        expect((await session.stack(thread)).items[0]?.line).toBe(2)
      }
      if (kind === 'in-skipped-record') {
        const refreshed = new Promise<void>((resolve) => {
          const off = session.dap.onEvent((event) => {
            if (event.event === 'stopped') {
              off()
              resolve()
            }
          })
        })
        await session.dap.request('toggleSkipFileStatus', { resource: skipped })
        await refreshed
      }
      await session.patchBreakpoints(
        0,
        [
          {
            breakpoint_id: 'point',
            source_id: kind === 'in-skipped-record' ? 'skipped' : 'program',
            line: kind === 'next-line-record' ? 8 : kind === 'out-remainder-record' ? 15 : 3,
          },
          ...(kind === 'callee-breakpoint'
            ? [{ breakpoint_id: 'elsewhere', source_id: 'program', line: 8 }]
            : []),
        ],
        []
      )
      const take =
        kind === 'next-line-record'
          ? 'result'
          : kind === 'out-remainder-record'
            ? 'extraValue'
            : 'value'
      if (kind !== 'callee-breakpoint')
        points.set(session.id, [{ breakpoint_id: 'point', take: [take] }], [])
      else points.set(session.id, [{ breakpoint_id: 'elsewhere', take: ['result'] }], [])
      recorder.attach(session)
      await recorder.settled(session.id)
      const recording = recorder.recording(session.id)
      if (kind !== 'callee-breakpoint') expect(recording).toBeDefined()
      epoch = session.snapshot.stop_epoch
      await session.step(
        thread,
        kind === 'out-remainder-record' ? 'out' : kind === 'in-skipped-record' ? 'in' : 'over'
      )
      await until(epoch)
      await recorder.settled(session.id)
      const deadline = Date.now() + 5000
      while (
        session.snapshot.execution !== 'stopped' ||
        (await session.recordStop(thread, [], 1)).frames[0]?.line !==
          (kind === 'callee-breakpoint' ? 3 : 8)
      ) {
        if (Date.now() > deadline)
          throw new Error(
            'step did not reach its destination: ' +
              JSON.stringify({ stops, breakpoints: session.snapshot.breakpoints })
          )
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(session.snapshot.execution).toBe('stopped')
      expect((await session.stack(thread)).items[0]?.line).toBe(
        kind === 'callee-breakpoint' ? 3 : 8
      )
      if (kind === 'callee-breakpoint')
        expect(session.snapshot.threads.find((t) => t.thread_id === thread)?.stop?.reason).toBe(
          'breakpoint'
        )
      if (kind === 'callee-breakpoint') expect(store.read(recording!.run_id).steps).toHaveLength(0)
      if (kind !== 'callee-breakpoint') {
        const steps = store.read(recording!.run_id).steps
        expect(steps).toHaveLength(1)
        expect(steps[0]!.values).toMatchObject([
          {
            name: take,
            inline:
              kind === 'in-skipped-record' ? '5' : kind === 'out-remainder-record' ? '1' : '42',
          },
        ])
      }
      await run.terminate()
    } finally {
      await recorder.close()
      await profile.close()
      spawned.mockRestore()
      core.close()
      rmSync(dir, { recursive: true, force: true })
    }
  },
  30000
)
