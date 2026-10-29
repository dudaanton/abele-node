import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NodeCore, DapDebuggerBackend } from '../../packages/node-core/src/index.js'
import { DapSession } from '../../packages/node-core/src/debugger/driver.js'
import { wire } from './dap-wire.js'
import { target } from './helpers.js'
import { z } from 'zod'

async function fixture(
  work: (f: any) => Promise<void>,
  options: Parameters<typeof wire>[0] = {},
  initiallyStopped = true,
  stoppedDuringStart = false
) {
  const dir = mkdtempSync(join(tmpdir(), 'control-driver-'))
  const core = new NodeCore(dir, { debuggerEnabled: true })
  const w = wire(options)
  const state = core.debugger.create({ ...target, build_identity: 'matched' })
  const session = new DapSession(core.debugger, state, w.dap, new Map([['source', 'fixture.cjs']]))
  try {
    const start = session.start('attach', { type: 'pwa-node', port: 12345 })
    w.reply(w.messages[0], {
      supportsSetVariable: true,
      supportsConditionalBreakpoints: true,
      supportsLogPoints: true,
      supportsHitConditionalBreakpoints: true,
    })
    w.send({ type: 'event', event: 'initialized' })
    for (let i = 0; i < 20; i++) {
      for (const m of w.messages.filter((m) => m.type === 'request' && !m.replied)) {
        m.replied = true
        w.reply(m)
      }
      await Promise.resolve()
    }
    if (stoppedDuringStart)
      w.send({
        type: 'event',
        event: 'stopped',
        body: { threadId: 1, allThreadsStopped: true, reason: 'pause' },
      })
    await start
    if (initiallyStopped)
      w.send({
        type: 'event',
        event: 'stopped',
        body: { threadId: 1, allThreadsStopped: true, reason: 'pause' },
      })
    const owner = core.authority.authenticate(core.createToken('fixture').token)
    const human = { kind: 'human', authority: owner }
    core.debuggerControl.registerBackend(session.id, new DapDebuggerBackend(session))
    const body = (operation_id: string) => ({
      operation_id,
      debug_session_id: session.id,
      incarnation: session.incarnation,
      expected_state_revision: session.snapshot.state_revision,
    })
    await work({ core, w, session, owner, human, body })
  } finally {
    w.dap.close()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
}
async function request(w: ReturnType<typeof wire>, command: string) {
  for (let i = 0; i < 30; i++) {
    const m = w.messages.find((m) => m.command === command && !m.replied)
    if (m) {
      m.replied = true
      return m
    }
    await Promise.resolve()
  }
  throw new Error('missing_request_' + command)
}
describe('authorized typed DAP backend', () => {
  it('does not dispatch superseded breakpoint intent after source validation', () =>
    fixture(async ({ core, session, human, w, body }) => {
      let release!: () => void
      session.validateSource = () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
      const pending = core.debuggerControl.command(human, 'breakpoints.patch', {
        ...body('superseded-source'),
        expected_breakpoint_revision: 0,
        upsert: [{ breakpoint_id: 'bp', source_id: 'source', line: 2 }],
        remove: [],
      })
      for (let i = 0; i < 30 && !release; i++) await Promise.resolve()
      expect(release).toBeTypeOf('function')
      core.debugger.patchBreakpoints(session.id, 1, [], ['bp'])
      release()
      expect(await pending).toMatchObject({ outcome: 'outcome_unknown', code: 'stale_state' })
      expect(w.messages.some((m: any) => m.command === 'setBreakpoints')).toBe(false)
    }))
  it.each(['stopped', 'continued'])(
    'installs source breakpoints when %s arrives during source validation',
    (event) =>
      fixture(async ({ core, session, human, w, body }) => {
        let release!: () => void
        session.validateSource = () =>
          new Promise<void>((resolve) => {
            release = resolve
          })
        const pending = core.debuggerControl.command(human, 'breakpoints.patch', {
          ...body('source-race'),
          expected_breakpoint_revision: 0,
          upsert: [{ breakpoint_id: 'bp', source_id: 'source', line: 2 }],
          remove: [],
        })
        for (let i = 0; i < 30 && !release; i++) await Promise.resolve()
        expect(release).toBeTypeOf('function')
        w.send({
          type: 'event',
          event,
          body: {
            threadId: 1,
            allThreadsStopped: true,
            allThreadsContinued: true,
            reason: 'pause',
          },
        })
        release()
        for (let i = 0; i < 30; i++) await Promise.resolve()
        const dispatched = w.messages.find((m: any) => m.command === 'setBreakpoints')
        if (dispatched) w.reply(dispatched, { breakpoints: [{ verified: true, line: 2 }] })
        expect(await pending).toMatchObject({ outcome: 'completed' })
        expect(dispatched).toBeDefined()
        expect(session.snapshot.breakpoints[0].status).toBe('verified')
      })
  )
  it('detaches without waiting for an in-flight inspection or an adapter reply', () =>
    fixture(async ({ core, session, human, w, body }) => {
      const inspection = core.debuggerControl.inspect(human, 'stack', {
        debug_session_id: session.id,
        incarnation: session.incarnation,
        expected_state_revision: session.snapshot.state_revision,
        thread_id: 1,
      })
      const settled = inspection.catch(() => undefined)
      await request(w, 'stackTrace')
      const poll = core.debuggerControl.wait(human, 'wait', {
        debug_session_id: session.id,
        timeout_ms: 30000,
        after_event_seq: core.debugger.snapshot(session.id).cursor.event_seq,
        kinds: ['stopped'],
      })
      const started = Date.now()
      const detach = core.debuggerControl.command(human, 'detach', body('detach'))
      await request(w, 'disconnect')
      const result = await detach
      expect(Date.now() - started).toBeLessThan(1000)
      expect(result.snapshot.lifecycle).toBe('detached')
      await settled
      expect((await poll).reason).toBe('cancelled')
      expect(w.dap.pendingCount).toBe(0)
    }))
  it('keeps inspection pages structured when recording state makes snapshots large', () =>
    fixture(async ({ core, session, human, w }) => {
      core.debugger.patchBreakpoints(
        session.id,
        0,
        Array.from({ length: 100 }, (_, i) => ({
          breakpoint_id: `bp${i}`,
          source_id: 'source',
          line: i + 1,
        })),
        []
      )
      const pending = core.debuggerControl.inspect(human, 'stack', {
        debug_session_id: session.id,
        incarnation: session.incarnation,
        expected_state_revision: session.snapshot.state_revision,
        thread_id: 1,
      })
      w.reply(await request(w, 'stackTrace'), {
        stackFrames: [{ id: 1, name: 'main', line: 1, column: 1 }],
      })
      const result = await pending
      expect(
        z
          .object({ data: z.object({ items: z.array(z.object({ name: z.string() })) }) })
          .safeParse(result).success
      ).toBe(true)
    }))
  it('reports running after attach without a continued event', () =>
    fixture(
      async ({ session }) => {
        expect(session.snapshot.execution).toBe('running')
      },
      {},
      false
    ))
  it('preserves a stop reported before attach completes', () =>
    fixture(
      async ({ session }) => {
        expect(session.snapshot.execution).toBe('stopped')
      },
      {},
      false,
      true
    ))
  it('replays a fresh attachment from cursor zero without an output gap', () =>
    fixture(
      async ({ session, core }) => {
        const cursor = { ...core.debugger.snapshot(session.id).cursor, event_seq: 0 }
        const replay = core.debugger.replay(cursor)
        expect(replay.kind).toBe('events')
        if (replay.kind === 'events')
          expect(replay.events.filter((e: any) => e.kind === 'output')).toEqual([])
      },
      {},
      false
    ))
  it.each([[[7]], [[7, 8]], [[0]]])(
    'pauses a never-stopped program using adapter threads %j',
    (ids) =>
      fixture(
        async (f) => {
          expect(f.session.snapshot.selected_thread_id).toBeNull()
          const pending = f.core.debuggerControl.command(f.human, 'pause', f.body('pause'))
          const result = pending.then(
            (value: any) => value,
            (error: unknown) => error
          )
          f.w.reply(await request(f.w, 'threads'), {
            threads: ids.map((id) => ({ id, name: 'main' })),
          })
          const pause = await request(f.w, 'pause')
          expect(pause.arguments).toEqual({ threadId: ids[0] })
          f.w.reply(pause)
          expect(await result).toMatchObject({ outcome: 'completed' })
          f.w.send({
            type: 'event',
            event: 'stopped',
            body: {
              threadId: ids[0],
              allThreadsStopped: true,
              reason: 'pause',
            },
          })
          expect(f.session.snapshot.selected_thread_id).toBeTruthy()
        },
        {},
        false
      )
  )
  it.each(['step', 'continue'])(
    'rejects %s on a never-stopped program before sending DAP',
    (method) =>
      fixture(
        async (f) => {
          const result = await f.core.debuggerControl.command(f.human, method, {
            ...f.body(method),
            ...(method === 'step' ? { thread_id: 1, kind: 'over' } : {}),
          })
          expect(result).toMatchObject({ outcome: 'rejected', code: 'not_stopped' })
          expect(f.w.messages.some((m: any) => ['next', 'continue'].includes(m.command))).toBe(
            false
          )
        },
        {},
        false
      )
  )
  it.each(['selected', 'explicit'])('pauses the %s thread without discovery', (selection) =>
    fixture(async (f) => {
      const pending = f.core.debuggerControl.command(f.human, 'pause', {
        ...f.body('pause-known'),
        ...(selection === 'explicit' ? { thread_id: 2 } : {}),
      })
      const pause = await request(f.w, 'pause')
      expect(pause.arguments.threadId).toBe(selection === 'explicit' ? 2 : 1)
      f.w.reply(pause)
      expect(await pending).toMatchObject({ outcome: 'completed' })
      expect(f.w.messages.some((m: any) => m.command === 'threads')).toBe(false)
    })
  )
  it.each(['empty', 'failed', 'stale'])('does not pause after %s thread discovery', (mode) =>
    fixture(
      async (f) => {
        const pending = f.core.debuggerControl.command(f.human, 'pause', f.body('pause-discovery'))
        const threads = await request(f.w, 'threads')
        if (mode === 'stale')
          f.w.send({
            type: 'event',
            event: 'stopped',
            body: {
              threadId: 9,
              allThreadsStopped: true,
              reason: 'breakpoint',
            },
          })
        f.w.reply(
          threads,
          { threads: mode === 'empty' ? [] : [{ id: 7, name: 'main' }] },
          mode !== 'failed'
        )
        expect(await pending).toMatchObject({ outcome: 'outcome_unknown' })
        expect(f.w.messages.some((m: any) => m.command === 'pause')).toBe(false)
      },
      {},
      false
    )
  )
  it.each(['condition', 'log_message', 'hit_condition'])(
    'does not replay an undispatched %s through a basic patch',
    (expressionKind) =>
      fixture(
        async (f) => {
          const control = f.core.debuggerControl
          const grant = (actions: string[], mode = 'ask') =>
            control.createGrant(f.owner, {
              installation_id: f.owner.installation_id,
              run_id: 'run',
              task_id: 'task',
              conversation_id: target.conversation_id,
              workspace_id: target.workspace_id,
              target_id: target.target_id,
              debug_session_id: f.session.id,
              incarnation: f.session.incarnation,
              expires_at: new Date(Date.now() + 60000).toISOString(),
              actions,
              mode,
            })
          const agent = (g: any) => ({
            kind: 'agent',
            authority: f.owner,
            grant_id: g.grant_id,
            run_id: 'run',
            task_id: 'task',
            conversation_id: target.conversation_id,
            workspace_id: target.workspace_id,
            target_id: target.target_id,
          })
          const g = grant(['breakpoints', 'expressions'])
          const a = agent(g)
          const bp = {
            breakpoint_id: 'expression-bp',
            source_id: 'source',
            line: 2,
            [expressionKind]: 'counter++',
          }
          const proposal = await control.command(a, 'breakpoints.patch', {
            ...f.body('expression'),
            expected_breakpoint_revision: 0,
            upsert: [bp],
            remove: [],
          })
          // Occupy every physical transport slot before approving the expression.
          const blockers = Array.from({ length: f.w.dap.pendingLimit }, () =>
            f.w.dap.request('capacity')
          )
          const approved = control.approve(f.owner, {
            principal_key: control.principalKey(a),
            operation_id: 'expression',
            proposal_hash: proposal.proposal_hash,
            decision: 'approve',
          })
          for (let i = 0; i < 20; i++) await Promise.resolve()
          expect(f.session.snapshot.breakpoint_revision).toBe(1)
          expect(f.session.snapshot.breakpoints[0][expressionKind]).toBe('counter++')
          expect(f.w.messages.some((m: any) => m.command === 'setBreakpoints')).toBe(false)
          control.revokeGrant(f.owner, g.grant_id)
          for (const m of f.w.messages.filter((m: any) => m.command === 'capacity')) {
            m.replied = true
            f.w.reply(m)
          }
          await Promise.all(blockers)
          expect(await approved).toMatchObject({ outcome: 'outcome_unknown', code: 'unauthorized' })
          expect(f.w.messages.some((m: any) => m.command === 'setBreakpoints')).toBe(false)
          const basic = control.command(
            agent(grant(['breakpoints'], 'allow-all')),
            'breakpoints.patch',
            {
              ...f.body('basic'),
              expected_breakpoint_revision: 1,
              upsert: [],
              remove: [],
            }
          )
          // Settle a buggy implementation's unsolicited send, so the regression never
          // leaves transport requests or cleanup running behind an assertion failure.
          for (let i = 0; i < 20; i++) await Promise.resolve()
          for (const m of f.w.messages.filter(
            (m: any) => m.command === 'setBreakpoints' && !m.replied
          )) {
            m.replied = true
            f.w.reply(m, { breakpoints: [{ verified: true, line: 2 }] })
          }
          await expect(basic).rejects.toThrow('unauthorized')
          expect(f.w.messages.some((m: any) => m.command === 'setBreakpoints')).toBe(false)
          const permitted = agent(grant(['breakpoints', 'expressions'], 'ask'))
          const retry = await control.command(permitted, 'breakpoints.patch', {
            ...f.body('reapproved'),
            expected_breakpoint_revision: 1,
            upsert: [],
            remove: [],
          })
          expect(retry.outcome).toBe('pending')
          const page = f.core.request(f.owner, 'debugger.v1.approvals', {
            debug_session_id: f.session.id,
          })
          expect(
            page.proposals.find((p: any) => p.params.operation_id === 'reapproved')
              .effective_breakpoints
          ).toEqual([bp])
          const sent = control.approve(f.owner, {
            principal_key: control.principalKey(permitted),
            operation_id: 'reapproved',
            proposal_hash: retry.proposal_hash,
            decision: 'approve',
          })
          const m = await request(f.w, 'setBreakpoints')
          expect(m.arguments.breakpoints).toEqual([
            {
              line: 2,
              [{ condition: 'condition', log_message: 'logMessage', hit_condition: 'hitCondition' }[
                expressionKind
              ]!]: 'counter++',
            },
          ])
          f.w.reply(m, { breakpoints: [{ verified: true, line: 2 }] })
          expect((await sent).outcome).toBe('completed')
          const row = f.core.db
            .prepare("SELECT body FROM debug_operations WHERE operation_id='reapproved'")
            .get()
          expect(JSON.parse(String(row.body))).not.toHaveProperty('effective_breakpoints')
        },
        { maxPending: 4 }
      )
  )
  it.each(
    ['ask', 'allow-all'].flatMap((mode) =>
      ['evaluate', 'setVariable', 'variables', 'breakpoints.patch'].map((method) => ({
        mode,
        method,
      }))
    )
  )('uses $mode for effectful $method at the physical DAP boundary', ({ mode, method }) =>
    fixture(async (f) => {
      const control = f.core.debuggerControl
      const g = control.createGrant(f.owner, {
        installation_id: f.owner.installation_id,
        run_id: 'run',
        task_id: 'task',
        conversation_id: target.conversation_id,
        workspace_id: target.workspace_id,
        target_id: target.target_id,
        debug_session_id: f.session.id,
        incarnation: f.session.incarnation,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        actions: ['read', 'expressions', 'breakpoints'],
        mode,
      })
      const a = {
        kind: 'agent',
        authority: f.owner,
        grant_id: g.grant_id,
        run_id: 'run',
        task_id: 'task',
        conversation_id: target.conversation_id,
        workspace_id: target.workspace_id,
        target_id: target.target_id,
      }
      const frame = f.core.debugger.issueHandle(f.session.id, 'frame', 42, 1)
      const object = f.core.debugger.issueHandle(f.session.id, 'object', 23, 1)
      const args =
        method === 'evaluate'
          ? { frame_handle: frame, expression: 'counter++' }
          : method === 'setVariable'
            ? { handle: object, name: 'counter', value: '2' }
            : method === 'variables'
              ? { handle: object, start: 3, count: 2 }
              : {
                  expected_breakpoint_revision: 0,
                  upsert: [
                    {
                      breakpoint_id: 'bp',
                      source_id: 'source',
                      line: 2,
                      condition: 'counter++',
                      log_message: '{counter++}',
                    },
                  ],
                  remove: [],
                }
      const command = method === 'breakpoints.patch' ? 'setBreakpoints' : method
      const p = { ...f.body('mode-effect'), ...args }
      let pending = control.command(a, method, p)
      if (mode === 'ask') {
        const proposal = await pending
        expect(proposal).toMatchObject({ outcome: 'pending', dispatch: 'not_dispatched' })
        expect(f.w.messages.some((m: any) => m.command === command)).toBe(false)
        pending = control.approve(f.owner, {
          principal_key: control.principalKey(a),
          operation_id: p.operation_id,
          proposal_hash: proposal.proposal_hash,
          decision: 'approve',
        })
      }
      const m = await request(f.w, command)
      if (method === 'breakpoints.patch')
        expect(m.arguments.breakpoints).toEqual([
          { line: 2, condition: 'counter++', logMessage: '{counter++}' },
        ])
      else
        expect(() =>
          f.core.debugger.resolveHandle(
            f.session.id,
            method === 'evaluate' ? frame : object,
            method === 'evaluate' ? 'frame' : 'object'
          )
        ).toThrow('stale_handle')
      f.w.reply(
        m,
        method === 'evaluate'
          ? { result: '1', variablesReference: 99 }
          : method === 'setVariable'
            ? { value: '2', variablesReference: 99 }
            : method === 'variables'
              ? { variables: [{ name: 'counter', value: '2', variablesReference: 99 }] }
              : { breakpoints: [{ verified: true, line: 2 }] }
      )
      expect(await pending).toMatchObject({ outcome: 'completed', dispatch: 'dispatched' })
      expect((await control.command(a, method, p)).outcome).toBe('completed')
      expect(f.w.messages.filter((m: any) => m.command === command)).toHaveLength(1)
    })
  )
  it('dispatches a shared step once, adopting only its own durable execution intent', () =>
    fixture(async (f) => {
      const p = { ...f.body('step'), thread_id: 1, kind: 'over', single_thread: false }
      const pending = f.core.debuggerControl.command(f.human, 'step', p)
      f.w.reply(await request(f.w, 'next'))
      const receipt = await pending
      expect(receipt).toMatchObject({
        outcome: 'completed',
        dispatch: 'dispatched',
        snapshot: { execution: 'unknown' },
      })
      await f.core.debuggerControl.command(f.human, 'step', p)
      expect(f.w.messages.filter((m: any) => m.command === 'next')).toHaveLength(1)
    }))
  it.each(['missingSample is not defined', 'x'.repeat(1000), 'structured', null])(
    'returns bounded evaluate errors and keeps transport loss uncertain (%s)',
    (message) =>
      fixture(async (f) => {
        const stack = f.session.stack(1)
        f.w.reply(await request(f.w, 'stackTrace'), {
          stackFrames: [{ id: 42, name: 'main', line: 1, column: 1 }],
          totalFrames: 1,
        })
        const handle = (await stack).items[0]!.handle
        const p = {
          ...f.body('failed-watch'),
          frame_handle: handle,
          expression: 'missingSample',
          context: 'watch',
        }
        const before = f.session.snapshot
        const proposal = await f.core.debuggerControl.command(f.human, 'evaluate', p)
        const pending = f.core.debuggerControl.approve(f.owner, {
          principal_key: f.core.debuggerControl.principalKey(f.human),
          operation_id: p.operation_id,
          proposal_hash: proposal.proposal_hash,
          decision: 'approve',
        })
        const m = await request(f.w, 'evaluate')
        if (message === null) f.w.dap.close(new Error('transport lost'))
        else
          f.w.send({
            type: 'response',
            request_seq: m.seq,
            command: m.command,
            success: false,
            ...(message === 'structured'
              ? {
                  body: {
                    error: {
                      id: 9222,
                      format: '{name} is not defined',
                      variables: { name: 'missingSample' },
                    },
                  },
                }
              : { message }),
          })
        const receipt = await pending
        if (message === null) {
          expect(receipt).toMatchObject({
            outcome: 'outcome_unknown',
            dispatch: 'possible',
            code: 'dispatch_uncertain',
          })
          expect(receipt).not.toHaveProperty('message')
          return
        }
        const expected =
          message === 'structured' ? 'missingSample is not defined' : message.slice(0, 256)
        expect(receipt).toMatchObject({
          outcome: 'failed',
          dispatch: 'dispatched',
          code: 'adapter_rejected',
          message: expected,
          snapshot: { execution: 'stopped', stop_epoch: before.stop_epoch },
        })
        expect(f.core.debugger.resolveHandle(f.session.id, handle, 'frame')).toBeDefined()
        expect(f.core.debugger.history(f.session.id).entries.at(-1)).toMatchObject({
          outcome: 'failed',
          requested_data: { code: 'adapter_rejected', message: expected },
        })
        expect(await f.core.debuggerControl.command(f.human, 'evaluate', p)).toEqual(receipt)
        expect(f.w.messages.filter((m: any) => m.command === 'evaluate')).toHaveLength(1)
      })
  )
  it('requires exact approval, fences handles and returns only requested expression data', () =>
    fixture(async (f) => {
      const handle = f.core.debugger.issueHandle(f.session.id, 'frame', 42, 1)
      const p = { ...f.body('expr'), frame_handle: handle, expression: 'counter++' }
      const proposal = await f.core.debuggerControl.command(f.human, 'evaluate', p)
      expect(f.w.messages.some((m: any) => m.command === 'evaluate')).toBe(false)
      const pending = f.core.debuggerControl.approve(f.owner, {
        principal_key: f.core.debuggerControl.principalKey(f.human),
        operation_id: 'expr',
        proposal_hash: proposal.proposal_hash,
        decision: 'approve',
      })
      const m = await request(f.w, 'evaluate')
      expect(m.arguments).toEqual({ frameId: 42, expression: 'counter++', context: 'repl' })
      expect(() => f.core.debugger.resolveHandle(f.session.id, handle, 'frame')).toThrow(
        'stale_handle'
      )
      f.w.reply(m, { result: '1', variablesReference: 99 })
      expect((await pending).outcome).toBe('completed')
      const entries = f.core.debugger.history(f.session.id).entries
      expect(entries.at(-1).requested_data).toMatchObject({
        value: '1',
        observation_stop_epoch: expect.any(Number),
      })
      expect(entries.at(-1).requested_data).not.toHaveProperty('variablesReference')
    }))
  it('separately approves conditional/logpoint arguments and sends a complete source set', () =>
    fixture(async (f) => {
      const p = {
        ...f.body('bp'),
        expected_breakpoint_revision: 0,
        upsert: [
          {
            breakpoint_id: 'bp',
            source_id: 'source',
            line: 2,
            condition: 'x > 1',
            log_message: '{x}',
          },
        ],
        remove: [],
      }
      const proposal = await f.core.debuggerControl.command(f.human, 'breakpoints.patch', p)
      expect(proposal.outcome).toBe('pending')
      const pending = f.core.debuggerControl.approve(f.owner, {
        principal_key: f.core.debuggerControl.principalKey(f.human),
        operation_id: 'bp',
        proposal_hash: proposal.proposal_hash,
        decision: 'approve',
      })
      const m = await request(f.w, 'setBreakpoints')
      expect(m.arguments.breakpoints).toEqual([{ line: 2, condition: 'x > 1', logMessage: '{x}' }])
      f.w.reply(m, { breakpoints: [{ id: 1, verified: true, line: 2 }] })
      expect((await pending).outcome).toBe('completed')
    }))
  it('exactly approves setVariable name/value and never restores expired object handles', () =>
    fixture(async (f) => {
      const handle = f.core.debugger.issueHandle(f.session.id, 'object', 23, 1)
      const p = { ...f.body('set'), handle, name: 'counter', value: '2' }
      const proposal = await f.core.debuggerControl.command(f.human, 'setVariable', p)
      await expect(
        f.core.debuggerControl.command(f.human, 'setVariable', { ...p, value: '3' })
      ).rejects.toThrow('idempotency_mismatch')
      expect(f.w.messages.some((m: any) => m.command === 'setVariable')).toBe(false)
      const pending = f.core.debuggerControl.approve(f.owner, {
        principal_key: f.core.debuggerControl.principalKey(f.human),
        operation_id: 'set',
        proposal_hash: proposal.proposal_hash,
        decision: 'approve',
      })
      const m = await request(f.w, 'setVariable')
      expect(m.arguments).toEqual({ variablesReference: 23, name: 'counter', value: '2' })
      f.w.reply(m, { value: '2', variablesReference: 99 })
      expect((await pending).outcome).toBe('completed')
      expect(() => f.core.debugger.resolveHandle(f.session.id, handle, 'object')).toThrow(
        'stale_handle'
      )
    }))
  it('returns only the approved explicit variable page, conservatively expiring references', () =>
    fixture(async (f) => {
      const handle = f.core.debugger.issueHandle(f.session.id, 'object', 23, 1)
      const p = { ...f.body('vars'), handle, start: 3, count: 2, max_bytes: 8192 }
      const proposal = await f.core.debuggerControl.command(f.human, 'variables', p)
      const pending = f.core.debuggerControl.approve(f.owner, {
        principal_key: f.core.debuggerControl.principalKey(f.human),
        operation_id: 'vars',
        proposal_hash: proposal.proposal_hash,
        decision: 'approve',
      })
      const m = await request(f.w, 'variables')
      expect(m.arguments).toEqual({ variablesReference: 23, start: 3, count: 2 })
      f.w.reply(m, { variables: [{ name: 'counter', value: '2', variablesReference: 99 }] })
      expect((await pending).outcome).toBe('completed')
      const data = f.core.debugger.history(f.session.id).entries.at(-1).requested_data
      expect(data.items).toEqual([{ name: 'counter', value: '2' }])
      expect(() => f.core.debugger.resolveHandle(f.session.id, handle, 'object')).toThrow(
        'stale_handle'
      )
    }))
  it('publishes paging and depth limits without recursively reading object children', () =>
    fixture(async (f) => {
      const handle = f.core.debugger.issueHandle(f.session.id, 'object', 23, 1)
      const p = {
        ...f.body('bounded-objects'),
        handle,
        start: 7,
        count: 2,
        depth: 3,
        max_bytes: 64,
      }
      const proposal = await f.core.debuggerControl.command(f.human, 'variables', p)
      const pending = f.core.debuggerControl.approve(f.owner, {
        principal_key: f.core.debuggerControl.principalKey(f.human),
        operation_id: p.operation_id,
        proposal_hash: proposal.proposal_hash,
        decision: 'approve',
      })
      const m = await request(f.w, 'variables')
      f.w.reply(m, {
        variables: [
          { name: 'child', value: 'Object', variablesReference: 99 },
          { name: 'large', value: '🌲'.repeat(1000), variablesReference: 100 },
        ],
      })
      expect((await pending).outcome).toBe('completed')
      const data = f.core.debugger.history(f.session.id).entries.at(-1).requested_data
      expect(data).toMatchObject({
        start: 7,
        count: 2,
        next: 8,
        depth_limit: 3,
        expansion_depth: 0,
        truncated: true,
      })
      expect(Buffer.byteLength(JSON.stringify(data.items))).toBeLessThanOrEqual(64)
      expect(data.items[0]).toEqual({ name: 'child', value: 'Object' })
      expect(f.w.messages.filter((m: any) => m.command === 'variables')).toHaveLength(1)
    }))
  it('disables unknown/effectful variables without a separate operation approval', () =>
    fixture(async (f) => {
      const handle = f.core.debugger.issueHandle(f.session.id, 'object', 23, 1)
      await expect(
        f.core.debuggerControl.command(f.human, 'variables', {
          ...f.body('vars'),
          handle,
          start: 0,
          count: 2,
          depth: 1,
          max_bytes: 8192,
        })
      ).resolves.toMatchObject({ outcome: 'pending' })
      expect(f.w.messages.some((m: any) => m.command === 'variables')).toBe(false)
    }))
})
