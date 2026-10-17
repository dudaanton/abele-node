import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { runInNewContext } from 'node:vm'
import { join } from 'node:path'
import { NodeCore } from '../../packages/node-core/src/index.js'
import { describe, expect, it, vi } from 'vitest'
import { DapSession, JsSessionTree } from '../../packages/node-core/src/debugger/driver.js'
import { DebuggerSnapshotSchema } from '@abele/node-protocol'
import { wire } from './dap-wire.js'
import { target } from './helpers.js'

async function fixture(
  work: (f: {
    core: NodeCore
    session: DapSession
    w: ReturnType<typeof wire>
    path: string
  }) => Promise<void>,
  wireOptions: Parameters<typeof wire>[0] = {},
  profile = 'fake'
) {
  const dir = mkdtempSync(join(tmpdir(), 'dap-driver-'))
  const core = new NodeCore(join(dir, 'state'), { debuggerEnabled: true })
  const path = join(dir, 'fixture.cjs')
  writeFileSync(path, 'setInterval(() => {}, 1000)\n')
  const w = wire(wireOptions),
    state = core.debugger.create({ ...target, adapter_profile: profile })
  const session = new DapSession(core.debugger, state, w.dap, new Map([['source', path]]))
  try {
    await work({ core, session, w, path })
  } finally {
    w.dap.close()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
function stopped(w: ReturnType<typeof wire>, thread = 1) {
  w.send({
    type: 'event',
    event: 'stopped',
    body: { threadId: thread, allThreadsStopped: true, reason: 'breakpoint' },
  })
}
async function ready(f: Parameters<Parameters<typeof fixture>[0]>[0], clipboard = false) {
  const p = f.session.start('attach', { type: 'pwa-node', port: 12345, address: '127.0.0.1' })
  f.w.reply(f.w.messages[0], {
    supportsConfigurationDoneRequest: true,
    supportsClipboardContext: clipboard,
  })
  f.w.send({ type: 'event', event: 'initialized' })
  await Promise.resolve()
  await Promise.resolve()
  for (let i = 0; i < 10; i++) {
    for (const m of f.w.messages.filter((m) => m.type === 'request' && !m.replied)) {
      m.replied = true
      f.w.reply(m)
    }
    await Promise.resolve()
  }
  await p
  stopped(f.w)
}
describe('internal DAP session driver', () => {
  it('never exports a lazy getter reference or evaluates it while inspecting native objects', async () =>
    fixture(
      async (f) => {
        await ready(f)
        const scope = f.core.debugger.issueHandle(f.session.id, 'object', 23, 1)
        ;(f.session as any).objectThreads.set(scope, 1)
        const pending = f.session.approvedVariables(scope)
        f.w.reply(f.w.messages.at(-1), {
          variables: [
            {
              name: 'getter',
              value: '(...)',
              variablesReference: 99,
              presentationHint: { lazy: true },
            },
            { name: 'item', value: 'Object', variablesReference: 100 },
          ],
        })
        const page = await pending
        expect(page.items[0]).toMatchObject({ name: 'getter', handle: null })
        expect(page.items[1]).toMatchObject({ name: 'item', handle: expect.any(String) })
        const depthZero = f.session.approvedVariables(scope, 0, 50, 8192, 0)
        f.w.reply(f.w.messages.at(-1), {
          variables: [{ name: 'item', value: 'Object', variablesReference: 100 }],
        })
        expect((await depthZero).items[0]).toMatchObject({ handle: null })
        expect(f.w.messages.filter((m) => m.command === 'variables')).toHaveLength(2)
        expect(f.w.messages.some((m) => m.command === 'evaluate')).toBe(false)
      },
      {},
      'js-ts-native'
    ))
  it('does not publish native child references from a reply overtaken by a step', async () =>
    fixture(
      async (f) => {
        await ready(f)
        const scope = f.core.debugger.issueHandle(f.session.id, 'object', 23, 1)
        ;(f.session as any).objectThreads.set(scope, 1)
        const pending = f.session.approvedVariables(scope)
        const rejected = expect(pending).rejects.toThrow('stale_state')
        const variables = f.w.messages.at(-1)
        const step = f.session.step(1, 'over')
        f.w.reply(f.w.messages.at(-1))
        await step
        f.w.reply(variables, {
          variables: [{ name: 'item', value: 'old', variablesReference: 100 }],
        })
        await rejected
      },
      {},
      'js-ts-native'
    ))
  it('exports approved children and rejects them after execution moves without a request', async () =>
    fixture(
      async (f) => {
        await ready(f)
        const scope = f.core.debugger.issueHandle(f.session.id, 'object', 23, 1)
        ;(f.session as any).objectThreads.set(scope, 1)
        const pending = f.session.approvedVariables(scope, 0, 2)
        f.w.reply(f.w.messages.at(-1), {
          variables: [{ name: 'item', value: 'Object', variablesReference: 99 }],
        })
        const page = await pending
        const child = (page.items[0] as any).handle
        expect(child).toEqual(expect.any(String))
        expect(page.observation_stop_epoch).toBe(f.session.snapshot.stop_epoch)
        const expansion = f.session.approvedVariables(child, 0, 2)
        expect(f.w.messages.at(-1).arguments).toEqual({
          variablesReference: 99,
          start: 0,
          count: 2,
        })
        f.w.reply(f.w.messages.at(-1), {
          variables: [{ name: 'nested', value: '3', variablesReference: 101 }],
        })
        const nested = (await expansion).items[0] as any
        const step = f.session.step(1, 'over')
        f.w.reply(f.w.messages.at(-1))
        await step
        const sent = f.w.messages.length
        await expect(f.session.approvedVariables(nested.handle)).rejects.toThrow(
          /expired.*program moved on/
        )
        expect(f.w.messages).toHaveLength(sent)
        expect(f.w.messages.some((m) => m.command === 'evaluate')).toBe(false)
      },
      {},
      'js-ts-native'
    ))
  it('records in repl even when clipboard is advertised, preserving frame, chunks and cleanup', async () =>
    fixture(async (f) => {
      await ready(f, true)
      const sandbox = { n: 'x'.repeat(200000), Buffer }
      const pending = f.session.recordStop(1, [{ name: 'argument', expression: 'n' }])
      const evaluations: any[] = []
      let done = false
      void pending.then(() => {
        done = true
      })
      for (let i = 0; i < 200 && !done; i++) {
        for (const m of f.w.messages.filter((m) => !m.replied)) {
          m.replied = true
          if (m.command === 'stackTrace')
            f.w.reply(m, { stackFrames: [{ id: 42, name: 'inspectItem', line: 2 }] })
          else if (m.command === 'evaluate') {
            evaluations.push(m.arguments)
            if (m.arguments.context !== 'repl') f.w.reply(m, {}, false)
            else f.w.reply(m, { result: String(runInNewContext(m.arguments.expression, sandbox)) })
          }
        }
        await Promise.resolve()
      }
      const result = await pending
      expect(result.values).toEqual([{ name: 'argument', text: sandbox.n, string: true }])
      expect(evaluations.length).toBeGreaterThan(3)
      expect(evaluations.every((a) => a.frameId === 42 && a.context === 'repl')).toBe(true)
      expect((sandbox as any).__abeleTrace).toEqual({})
    }))
  it('waits for initialized after attach and before configuring, even after a successful attach reply', async () =>
    fixture(async (f) => {
      const pending = f.session.start('attach', { type: 'pwa-node', port: 12345 })
      f.w.reply(f.w.messages[0], { supportsConfigurationDoneRequest: true })
      await Promise.resolve()
      await Promise.resolve()
      const attach = f.w.messages.find((m) => m.command === 'attach')
      expect(attach).toBeDefined()
      f.w.reply(attach)
      await Promise.resolve()
      await Promise.resolve()
      const premature = f.w.messages.filter((m) =>
        ['setBreakpoints', 'setExceptionBreakpoints', 'configurationDone'].includes(m.command)
      )
      // Keep an old implementation's pending configuration settled on test failure.
      for (const m of premature) f.w.reply(m)
      f.w.send({ type: 'event', event: 'initialized' })
      for (let i = 0; i < 15; i++) {
        for (const m of f.w.messages.filter((m) => m.type === 'request' && !m.replied)) {
          m.replied = true
          f.w.reply(m)
        }
        await Promise.resolve()
      }
      await pending
      expect(premature).toEqual([])
      expect(f.w.messages.map((m) => m.command)).toContain('configurationDone')
    }))
  it.each(['timeout', 'cancel', 'eof'] as const)(
    'settles the initialized barrier on %s without configuration dispatch or leaked timers',
    async (kind) => {
      vi.useFakeTimers()
      try {
        await fixture(async (f) => {
          const controller = new AbortController()
          const pending = f.session.start(
            'attach',
            { type: 'pwa-node', port: 12345 },
            controller.signal
          )
          const rejected = expect(pending).rejects.toThrow(
            kind === 'timeout'
              ? 'dap_initialized_timeout'
              : kind === 'cancel'
                ? 'dap_cancelled'
                : 'lost'
          )
          f.w.reply(f.w.messages[0])
          await Promise.resolve()
          await Promise.resolve()
          f.w.reply(f.w.messages.find((m) => m.command === 'attach'))
          if (kind === 'timeout') await vi.advanceTimersByTimeAsync(10000)
          else if (kind === 'cancel') controller.abort()
          else f.w.dap.close(new Error('lost'))
          await rejected
          expect(f.w.messages.some((m) => m.command === 'setExceptionBreakpoints')).toBe(false)
          expect(f.w.dap.pendingCount).toBe(0)
          expect(vi.getTimerCount()).toBe(0)
        })
      } finally {
        vi.useRealTimers()
      }
    }
  )
  it('always sends bounded start/count variable pages without adapter echo of a client capability', async () =>
    fixture(async (f) => {
      await ready(f)
      const stack = f.session.stack(1),
        sr = f.w.messages.at(-1)
      f.w.reply(sr, { stackFrames: [{ id: 1, name: 'main', line: 1, column: 1 }] })
      const frame = (await stack).items[0]!
      const scopes = f.session.scopes(frame.handle),
        cr = f.w.messages.at(-1)
      f.w.reply(cr, { scopes: [{ name: 'Local', variablesReference: 2, expensive: false }] })
      const handle = (await scopes).items[0]!.handle!
      for (const start of [0, 100]) {
        const before = f.w.messages.length
        const p = f.session.variables(handle, start, 2)
        void p.catch(() => {})
        const request = f.w.messages.at(-1)
        if (f.w.messages.length > before) f.w.reply(request, { variables: [] })
        await p
        expect(request.arguments).toEqual({ variablesReference: 2, start, count: 2 })
      }
      expect(f.w.messages[0].arguments.supportsVariablePaging).toBe(true)
    }))
  it('accepts native frames with no source and zero position alongside source frames', async () =>
    fixture(async (f) => {
      await ready(f)
      const p = f.session.stack(1),
        request = f.w.messages.at(-1)
      f.w.reply(request, {
        stackFrames: [
          { id: 4, name: 'native', line: 0, column: 0 },
          { id: 5, name: 'main', line: 1, column: 1, source: { path: f.path } },
        ],
      })
      const result = await p
      expect(result.items).toMatchObject([
        { name: 'native', source_id: null, line: 0, column: 0 },
        { name: 'main', source_id: 'source', line: 1, column: 1 },
      ])
      expect(() =>
        f.core.debugger.resolveHandle(f.session.id, result.items[0]!.handle, 'frame')
      ).not.toThrow()
    }))
  it('initializes, configures exceptions, launches typed configurations and fails early without stranded requests', async () =>
    fixture(async (f) => {
      const p = f.session.start('launch', {
        type: 'pwa-node',
        program: f.path,
        args: ['--test'],
        env: { TEST: '1' },
      })
      f.w.reply(f.w.messages[0], { supportsConfigurationDoneRequest: true })
      await Promise.resolve()
      await Promise.resolve()
      const launch = f.w.messages.find((m) => m.command === 'launch')
      expect(launch.arguments.args).toEqual(['--test'])
      f.w.reply(launch, {}, false)
      await expect(p).rejects.toThrow('dap_rejected')
      expect(f.w.dap.pendingCount).toBe(0)
      expect(f.session.snapshot.lifecycle).toBe('failed')
    }))
  it.each([
    'pause',
    'exceptions',
    'continue',
    'step',
    'breakpoints',
    'start',
    'threads',
    'stack',
    'scopes',
    'variables',
  ] as const)('fences %s in session B after audit failure in session A', async (operation) =>
    fixture(async (f) => {
      await ready(f)
      let frame = '',
        object = ''
      if (operation === 'scopes' || operation === 'variables') {
        const stack = f.session.stack(1),
          request = f.w.messages.at(-1)
        f.w.reply(request, { stackFrames: [{ id: 1, name: 'main', line: 1, column: 1 }] })
        frame = (await stack).items[0]!.handle
        const scopes = f.session.scopes(frame),
          scopeRequest = f.w.messages.at(-1)
        f.w.reply(scopeRequest, {
          scopes: [{ name: 'Local', variablesReference: 2, expensive: false }],
        })
        object = (await scopes).items[0]!.handle!
      }
      const otherWire = wire(),
        other = new DapSession(
          f.core.debugger,
          f.core.debugger.create(target),
          otherWire.dap,
          new Map()
        )
      const fresh = new DapSession(
        f.core.debugger,
        f.core.debugger.create(target),
        f.w.dap,
        new Map()
      )
      try {
        f.core.db.exec(
          "CREATE TRIGGER debug_failure BEFORE INSERT ON debug_events BEGIN SELECT RAISE(FAIL, 'fixture_storage_failure'); END;"
        )
        otherWire.send({ type: 'event', event: 'output', body: { output: 'failure' } })
        expect(otherWire.dap.closed).toBe(true)
        expect(f.w.dap.closed).toBe(false)
        const before = f.w.messages.length
        const actions = {
          pause: () => f.session.pause(1),
          exceptions: () => f.session.exceptionBreakpoints(['all']),
          continue: () => f.session.continue(1),
          step: () => f.session.step(1, 'over'),
          breakpoints: () => f.session.syncBreakpoints(),
          start: () => fresh.start('launch', {}),
          threads: () => f.session.threads(),
          stack: () => f.session.stack(1),
          scopes: () => f.session.scopes(frame),
          variables: () => f.session.variables(object),
        }
        const pending = actions[operation]()
        for (const request of f.w.messages.slice(before))
          f.w.reply(request, { threads: [], stackFrames: [] })
        await expect(pending).rejects.toThrow('storage_unavailable')
        expect(f.w.messages).toHaveLength(before)
      } finally {
        otherWire.dap.close()
      }
    })
  )
  it.each(['detach', 'terminate'] as const)(
    'allows %s cleanup even when audit storage was already unavailable',
    async (operation) =>
      fixture(async (f) => {
        await ready(f)
        let killed = false
        f.session.setOwner({
          evidence: {
            pid: 123,
            start_identity: 'fixture',
            executable_sha256: 'a'.repeat(64),
            ownership_id: 'owned',
          },
          terminate: async () => {
            killed = true
          },
        })
        f.core.db.exec(
          "CREATE TRIGGER debug_failure BEFORE INSERT ON debug_events BEGIN SELECT RAISE(FAIL, 'fixture_storage_failure'); END;"
        )
        expect(() =>
          f.core.debugger.observe(f.session.id, f.session.incarnation, {
            kind: 'output',
            text: 'failure',
            category: 'console',
          })
        ).toThrow('fixture_storage_failure')
        const before = f.w.messages.length
        const pending = f.session[operation]()
        const request = f.w.messages.at(-1)
        expect(f.w.messages.length).toBe(before + 1)
        expect(request.arguments.terminateDebuggee).toBe(false)
        f.w.reply(request)
        await expect(pending).rejects.toThrow('storage_unavailable')
        expect(killed).toBe(operation === 'terminate')
        expect(f.w.dap.closed).toBe(true)
      })
  )
  it('rechecks global audit availability after a breakpoint request waits for transport capacity', async () =>
    fixture(
      async (f) => {
        await ready(f)
        f.core.debugger.patchBreakpoints(
          f.session.id,
          0,
          [{ breakpoint_id: 'bp', source_id: 'source', line: 1 }],
          []
        )
        const holders = [f.w.dap.request('held_one'), f.w.dap.request('held_two')]
        const requests = f.w.messages.slice(-2)
        const before = f.w.messages.length
        const pending = f.session.syncBreakpoints()
        const rejected = expect(pending).rejects.toThrow('storage_unavailable')
        expect(f.w.messages).toHaveLength(before)
        f.core.db.exec(
          "CREATE TRIGGER debug_failure BEFORE INSERT ON debug_events BEGIN SELECT RAISE(FAIL, 'fixture_storage_failure'); END;"
        )
        expect(() =>
          f.core.debugger.observe(f.session.id, f.session.incarnation, {
            kind: 'output',
            text: 'failure',
            category: 'console',
          })
        ).toThrow('fixture_storage_failure')
        for (const request of requests) f.w.reply(request)
        await Promise.all(holders)
        await rejected
        expect(f.w.messages).toHaveLength(before)
      },
      { maxPending: 2 }
    ))
  it.each([
    [65, 64],
    [256, 8],
    [5, 2],
  ] as const)(
    'configures %s sources below a pending limit of %s with an outstanding launch',
    async (count, maxPending) =>
      fixture(
        async (f) => {
          const sources = f.session.sources as Map<string, string>
          const breakpoints = Array.from({ length: count }, (_, i) => ({
            breakpoint_id: 'bp-' + i,
            source_id: 'source-' + i,
            line: 1,
          }))
          for (const bp of breakpoints) sources.set(bp.source_id, f.path)
          f.core.debugger.patchBreakpoints(f.session.id, 0, breakpoints, [])
          let done = false,
            error: unknown,
            peak = 0
          const pending = f.session.start('launch', { program: f.path })
          const completed = pending.then(
            () => {
              done = true
            },
            (failure) => {
              error = failure
              done = true
            }
          )
          f.w.reply(f.w.messages[0], { supportsConfigurationDoneRequest: true })
          f.w.messages[0].replied = true
          f.w.send({ type: 'event', event: 'initialized' })
          for (let i = 0; i < 5000 && !done; i++) {
            peak = Math.max(peak, f.w.dap.pendingCount)
            for (const request of f.w.messages.filter(
              (m) => m.type === 'request' && !m.replied && m.command !== 'launch'
            )) {
              request.replied = true
              f.w.reply(
                request,
                request.command === 'setBreakpoints'
                  ? { breakpoints: [{ verified: true, line: 1 }] }
                  : {}
              )
              if (request.command === 'configurationDone')
                f.w.reply(f.w.messages.find((m) => m.command === 'launch'))
            }
            await Promise.resolve()
          }
          expect(done).toBe(true)
          await completed
          expect(error).toBeUndefined()
          expect(peak).toBeLessThanOrEqual(maxPending)
          expect(f.w.messages.filter((m) => m.command === 'setBreakpoints')).toHaveLength(count)
          expect(f.session.snapshot.breakpoints.every((bp) => bp.status === 'verified')).toBe(true)
        },
        { maxPending }
      )
  )
  it('translates complete breakpoint intent, relocation and later verification events', async () =>
    fixture(async (f) => {
      await ready(f)
      f.core.debugger.patchBreakpoints(
        f.session.id,
        0,
        [{ breakpoint_id: 'bp', source_id: 'source', line: 1 }],
        []
      )
      const p = f.session.syncBreakpoints(),
        request = f.w.messages.at(-1)
      expect(request.arguments).toMatchObject({
        source: { path: f.path },
        breakpoints: [{ line: 1 }],
      })
      f.w.reply(request, { breakpoints: [{ id: 7, verified: false }] })
      await p
      f.w.send({
        type: 'event',
        event: 'breakpoint',
        body: { breakpoint: { id: 7, verified: true, line: 2 } },
      })
      expect(f.session.snapshot.breakpoints[0]).toMatchObject({
        status: 'relocated',
        resolved_line: 2,
      })
      f.core.debugger.patchBreakpoints(f.session.id, 1, [], ['bp'])
      const clear = f.session.syncBreakpoints()
      expect(f.w.messages.at(-1).arguments.breakpoints).toEqual([])
      f.w.reply(f.w.messages.at(-1), { breakpoints: [] })
      await clear
    }))
  it('fences older complete-set replies and thread inventories', async () =>
    fixture(async (f) => {
      await ready(f)
      f.core.debugger.patchBreakpoints(
        f.session.id,
        0,
        [{ breakpoint_id: 'bp', source_id: 'source', line: 1 }],
        []
      )
      const a = f.session.syncBreakpoints(),
        first = f.w.messages.at(-1)
      f.core.debugger.patchBreakpoints(
        f.session.id,
        1,
        [{ breakpoint_id: 'bp', source_id: 'source', line: 3 }],
        []
      )
      const b = f.session.syncBreakpoints(),
        second = f.w.messages.at(-1)
      f.w.reply(second, { breakpoints: [{ verified: true, line: 3 }] })
      await b
      f.w.reply(first, { breakpoints: [{ verified: true, line: 2 }] })
      await a
      expect(f.session.snapshot.breakpoints[0]!.resolved_line).toBe(3)
      const threads = f.session.threads(),
        r = f.w.messages.at(-1)
      f.w.send({ type: 'event', event: 'thread', body: { threadId: 2, reason: 'started' } })
      f.w.reply(r, { threads: [{ id: 1, name: 'one' }] })
      await threads
      expect(f.session.snapshot.threads.map((t) => t.thread_id)).toContain(2)
    }))
  it('returns paged bounded opaque frames/objects, rejects cross-session and resumed references', async () =>
    fixture(async (f) => {
      await ready(f)
      const stack = f.session.stack(1, 0, 1),
        stackRequest = f.w.messages.at(-1)
      expect(stackRequest.arguments).toEqual({ threadId: 1, startFrame: 0, levels: 1 })
      f.w.reply(stackRequest, {
        stackFrames: [{ id: 44, name: 'main', line: 1, column: 1, source: { path: f.path } }],
        totalFrames: 1,
      })
      const frame = (await stack).items[0]!
      expect(frame.handle).not.toBe('44')
      expect(frame.source_id).toBe('source')
      const scopes = f.session.scopes(frame.handle),
        scopeRequest = f.w.messages.at(-1)
      f.w.reply(scopeRequest, {
        scopes: [{ name: 'Local', variablesReference: 77, expensive: false }],
      })
      const object = (await scopes).items[0]!
      const variables = f.session.variables(object.handle!, 0, 1, 512),
        vr = f.w.messages.at(-1)
      expect(vr.arguments).toMatchObject({ variablesReference: 77, start: 0, count: 1 })
      f.w.reply(vr, {
        variables: [{ name: 'value', value: '🌲'.repeat(10000), variablesReference: 0 }],
      })
      const values = await variables
      expect(Buffer.byteLength(JSON.stringify(values.items))).toBeLessThanOrEqual(512)
      expect(values.truncated).toBe(true)
      expect(JSON.stringify(values)).not.toContain('�')
      const otherState = f.core.debugger.create(target)
      expect(() =>
        f.core.debugger.resolveHandle(otherState.debug_session_id, frame.handle, 'frame')
      ).toThrow('stale_handle')
      const step = f.session.step(1, 'over'),
        sr = f.w.messages.at(-1)
      expect(sr.command).toBe('next')
      expect(f.session.snapshot.execution).toBe('unknown')
      f.w.reply(sr)
      await step
      await expect(f.session.scopes(frame.handle)).rejects.toThrow('stale_handle')
    }))
  it('bounds stack/scopes bytes and dispatches step-in/out/continue and exception filters', async () =>
    fixture(async (f) => {
      await ready(f)
      const stack = f.session.stack(1, 0, 100, 512),
        request = f.w.messages.at(-1)
      f.w.reply(request, {
        stackFrames: Array.from({ length: 100 }, (_, i) => ({
          id: i,
          name: 'x'.repeat(256),
          line: 1,
          column: 1,
        })),
      })
      const frames = await stack
      expect(Buffer.byteLength(JSON.stringify(frames.items))).toBeLessThanOrEqual(512)
      expect(frames.truncated).toBe(true)
      const scopes = f.session.scopes(frames.items[0]!.handle, 512),
        scopeRequest = f.w.messages.at(-1)
      f.w.reply(scopeRequest, {
        scopes: Array.from({ length: 100 }, (_, i) => ({
          name: 'x'.repeat(256),
          variablesReference: i + 1,
          expensive: false,
        })),
      })
      const result = await scopes
      expect(Buffer.byteLength(JSON.stringify(result.items))).toBeLessThanOrEqual(512)
      expect(result.truncated).toBe(true)
      for (const [kind, command] of [
        ['in', 'stepIn'],
        ['out', 'stepOut'],
      ] as const) {
        const p = f.session.step(1, kind),
          r = f.w.messages.at(-1)
        expect(r.command).toBe(command)
        f.w.reply(r)
        await p
        stopped(f.w)
      }
      const p = f.session.continue(1),
        r = f.w.messages.at(-1)
      expect(r.command).toBe('continue')
      f.w.reply(r)
      await p
      const ex = f.session.exceptionBreakpoints(['uncaught']),
        er = f.w.messages.at(-1)
      expect(er.arguments.filters).toEqual(['uncaught'])
      f.w.reply(er)
      await ex
      await expect(f.session.exceptionBreakpoints(['other' as 'all'])).rejects.toThrow(
        'invalid_exception_filters'
      )
    }))
  it('rejects stale inspection replies and invalid paging before dispatch', async () =>
    fixture(async (f) => {
      await ready(f)
      const p = f.session.stack(1),
        request = f.w.messages.at(-1)
      f.w.send({
        type: 'event',
        event: 'continued',
        body: { threadId: 1, allThreadsContinued: true },
      })
      f.w.reply(request, { stackFrames: [{ id: 4, name: 'old', line: 1, column: 1 }] })
      await expect(p).rejects.toThrow('stale_state')
      const before = f.w.messages.length
      await expect(f.session.stack(1, -1, 200)).rejects.toThrow('invalid_paging')
      expect(f.w.messages.length).toBe(before)
    }))
  it('normalizes stops/output/invalidation and distinguishes detach from owned termination', async () =>
    fixture(async (f) => {
      await ready(f)
      await expect(f.session.terminate()).rejects.toThrow('process_not_owned')
      expect(f.w.messages.some((m) => m.command === 'terminate')).toBe(false)
      f.w.send({ type: 'event', event: 'output', body: { output: 'hello', category: 'stdout' } })
      const revision = f.session.snapshot.state_revision
      const pause = f.session.pause(1),
        pr = f.w.messages.at(-1)
      f.w.reply(pr)
      await pause
      expect(f.session.snapshot.state_revision).toBe(revision)
      const detach = f.session.detach(),
        request = f.w.messages.at(-1)
      expect(request.arguments).toEqual({ terminateDebuggee: false, suspendDebuggee: false })
      f.w.send({ type: 'event', event: 'terminated' })
      f.w.reply(request)
      await detach
      expect(f.session.snapshot.lifecycle).toBe('detached')
    }))
  it('reads a session the adapter closes while it is asked to detach as detached, not lost', async () =>
    fixture(async (f) => {
      await ready(f)
      const detach = f.session.detach()
      // js-debug ends the run's root as its program's session goes, and that closes this one.
      f.session.dap.close()
      await detach
      expect(f.session.snapshot.lifecycle).toBe('detached')
    }))
  it('does not label a disconnect acknowledgement as proof of process exit', async () =>
    fixture(async (f) => {
      await ready(f)
      f.session.setOwner({
        evidence: {
          pid: 123,
          start_identity: 'fixture',
          executable_sha256: 'a'.repeat(64),
          ownership_id: 'owned',
        },
        terminate: async () => {
          throw new Error('pid_reused')
        },
      })
      const p = f.session.terminate(),
        request = f.w.messages.at(-1)
      expect(request.arguments.terminateDebuggee).toBe(false)
      f.w.reply(request)
      await expect(p).rejects.toThrow('pid_reused')
      expect(f.session.snapshot.lifecycle).not.toBe('terminated')
    }))
  it('cleans up owned processes despite disconnect failure or audit-storage failure', async () =>
    fixture(async (f) => {
      await ready(f)
      let killed = false
      f.session.setOwner({
        evidence: {
          pid: 123,
          start_identity: 'fixture',
          executable_sha256: 'a'.repeat(64),
          ownership_id: 'owned',
        },
        terminate: async () => {
          killed = true
        },
      })
      const terminate = f.session.terminate(),
        request = f.w.messages.at(-1)
      f.core.db.exec(
        "CREATE TRIGGER debug_failure BEFORE INSERT ON debug_events BEGIN SELECT RAISE(FAIL, 'fixture_storage_failure'); END;"
      )
      f.w.reply(request, {}, false)
      await expect(terminate).rejects.toThrow()
      expect(killed).toBe(true)
      expect(f.w.dap.closed).toBe(true)
    }))
  it('aborts control and inspection after loss of transport', async () =>
    fixture(async (f) => {
      await ready(f)
      f.w.dap.close(new Error('lost'))
      expect(f.session.snapshot.lifecycle).toBe('connection-lost')
      await expect(f.session.pause(1)).rejects.toThrow()
    }))
  it('denies uncovered children/terminal requests and unknown reverse requests', async () =>
    fixture(async (f) => {
      const tree = new JsSessionTree(f.core.debugger, f.session, async () => {
        throw new Error('must_not_connect')
      })
      for (const command of ['startDebugging', 'runInTerminal', 'unknown'])
        await expect(
          tree.reverse(
            { seq: 1, type: 'request', command, arguments: {} },
            new AbortController().signal
          )
        ).rejects.toThrow('reverse_request_denied')
      expect(tree.children.size).toBe(0)
    }))
  it("ties a hit to its point by js-debug's breakpoint 0, and a column it picks is no move", async () =>
    fixture(async (f) => {
      await ready(f)
      f.core.debugger.patchBreakpoints(
        f.session.id,
        0,
        [{ breakpoint_id: 'bp', source_id: 'source', line: 4 }],
        []
      )
      const sync = f.session.syncBreakpoints()
      const set = f.w.messages.find((m) => m.command === 'setBreakpoints')!
      f.w.reply(set, { breakpoints: [{ id: 0, verified: true, line: 4, column: 17 }] })
      await sync
      expect(f.session.snapshot.breakpoints[0]).toMatchObject({
        status: 'verified',
        resolved_line: 4,
        resolved_column: 17,
      })
      stopped(f.w, 1)
      f.w.send({
        type: 'event',
        event: 'stopped',
        body: { threadId: 1, allThreadsStopped: true, reason: 'breakpoint', hitBreakpointIds: [0] },
      })
      await Promise.resolve()
      expect(f.session.snapshot.threads[0]!.stop?.hit_breakpoint_ids).toEqual(['bp'])
    }))
  it('takes thread 0, the only thread the pinned js-debug reports for a Node program', async () =>
    fixture(async (f) => {
      await ready(f)
      // debugger.v1 counts threads from 1, so the adapter's 0 travels as the largest id.
      const zero = Number.MAX_SAFE_INTEGER
      f.w.send({ type: 'event', event: 'thread', body: { reason: 'started', threadId: 0 } })
      stopped(f.w, 0)
      await Promise.resolve()
      expect(f.w.dap.closed).toBe(false)
      expect(f.session.snapshot.selected_thread_id).toBe(zero)
      expect(f.session.snapshot.threads.find((t) => t.thread_id === zero)?.status).toBe('stopped')
      expect(DebuggerSnapshotSchema.parse(f.session.snapshot).selected_thread_id).toBe(zero)
      const step = f.session.step(zero, 'over')
      const next = f.w.messages.find((m) => m.command === 'next')!
      expect(next.arguments).toMatchObject({ threadId: 0 })
      f.w.reply(next)
      await step
      const pause = f.session.pause(zero)
      const asked = f.w.messages.find((m) => m.command === 'pause')!
      expect(asked.arguments).toEqual({ threadId: 0 })
      f.w.reply(asked)
      await pause
      // An adapter may not take that id for a thread of its own.
      f.w.send({ type: 'event', event: 'thread', body: { reason: 'started', threadId: zero } })
      await Promise.resolve()
      expect(f.w.dap.closed).toBe(true)
    }))
  it("takes the pinned js-debug's own child form: the parent's type and a name, nothing else", async () =>
    fixture(async (f) => {
      const childWire = wire(),
        config = { type: 'pwa-node', port: 12345, address: '127.0.0.1' }
      const tree = new JsSessionTree(f.core.debugger, f.session, async () => childWire.dap, {
        mode: 'attach',
        configuration: config,
        maxChildren: 2,
      })
      const ask = (configuration: Record<string, unknown>, seq = 1) =>
        tree.reverse(
          {
            seq,
            type: 'request',
            command: 'startDebugging',
            arguments: { request: 'attach', configuration },
          },
          new AbortController().signal
        )
      for (const configuration of [
        { type: 'pwa-chrome', name: 'Remote Process [0]', __pendingTargetId: 'a' },
        { type: 'pwa-node', name: 'Remote Process [0]', port: 9999, __pendingTargetId: 'b' },
        { type: 'pwa-node', name: 'x'.repeat(129), __pendingTargetId: 'c' },
        { type: 'pwa-node', name: 7, __pendingTargetId: 'd' },
        { type: 'pwa-node', __pendingTargetId: 'e' },
      ])
        await expect(ask(configuration)).rejects.toThrow('reverse_request_denied')
      expect(tree.children.size).toBe(0)
      const p = ask({ type: 'pwa-node', name: 'Remote Process [0]', __pendingTargetId: 'real' }, 2)
      for (let i = 0; i < 15; i++) {
        for (const m of childWire.messages.filter((m) => m.type === 'request' && !m.replied)) {
          m.replied = true
          childWire.reply(m)
          if (m.command === 'initialize') childWire.send({ type: 'event', event: 'initialized' })
        }
        await Promise.resolve()
      }
      await p
      expect(tree.children.size).toBe(1)
      const attach = childWire.messages.find((m) => m.command === 'attach')!
      expect(attach.arguments).toEqual({
        request: 'attach',
        type: 'pwa-node',
        name: 'Remote Process [0]',
        __pendingTargetId: 'real',
      })
      tree.close()
    }))
  it('creates only covered child sessions, with separate reducers and bounded cleanup', async () =>
    fixture(async (f) => {
      const childWire = wire(),
        config = { type: 'pwa-node', port: 12345, address: '127.0.0.1' }
      const tree = new JsSessionTree(f.core.debugger, f.session, async () => childWire.dap, {
        mode: 'attach',
        configuration: config,
        maxChildren: 1,
      })
      const p = tree.reverse(
        {
          seq: 1,
          type: 'request',
          command: 'startDebugging',
          arguments: {
            request: 'attach',
            configuration: { ...config, __pendingTargetId: 'pending' },
          },
        },
        new AbortController().signal
      )
      for (let i = 0; i < 15; i++) {
        for (const m of childWire.messages.filter((m) => m.type === 'request' && !m.replied)) {
          m.replied = true
          childWire.reply(m)
          if (m.command === 'initialize') childWire.send({ type: 'event', event: 'initialized' })
        }
        await Promise.resolve()
      }
      await p
      const child = [...tree.children.values()][0]!
      stopped(childWire, 2)
      expect(child.snapshot.threads[0]!.thread_id).toBe(2)
      expect(f.session.snapshot.threads).toEqual([])
      expect(child.id).not.toBe(f.session.id)
      await expect(
        tree.reverse(
          {
            seq: 2,
            type: 'request',
            command: 'startDebugging',
            arguments: {
              request: 'attach',
              configuration: { ...config, __pendingTargetId: 'second', port: 9999 },
            },
          },
          new AbortController().signal
        )
      ).rejects.toThrow('reverse_request_denied')
      childWire.dap.close()
      expect(child.snapshot.lifecycle).toBe('connection-lost')
      expect(f.session.snapshot.lifecycle).toBe('configuring')
      tree.close()
    }))
})
