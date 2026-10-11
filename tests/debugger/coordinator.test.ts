import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NodeCore } from '@abele/node-core'
import { target } from './helpers.js'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
async function fixture(work: (f: any) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'debug-control-'))
  const core = new NodeCore(dir, { debuggerEnabled: true })
  try {
    const owner = core.authority.authenticate(core.createToken('owner').token)
    const other = core.authority.authenticate(core.createToken('other').token)
    const control = core.debuggerControl
    const initial = core.debugger.create(target)
    const id = initial.debug_session_id
    core.debugger.observe(id, initial.incarnation, { kind: 'lifecycle', lifecycle: 'active' })
    const stop = () =>
      core.debugger.observe(id, initial.incarnation, {
        kind: 'stopped',
        thread_id: 1,
        all_threads_stopped: true,
        reason: 'pause',
        hit_breakpoint_ids: [],
      })
    stop()
    const body = (operation_id: string) => ({
      operation_id,
      debug_session_id: id,
      incarnation: initial.incarnation,
      expected_state_revision: core.debugger.snapshot(id).snapshot.state_revision,
      thread_id: 1,
      kind: 'over',
      single_thread: false,
    })
    let calls = 0
    control.registerBackend(id, {
      supports: (method: string) =>
        ['step', 'pause', 'continue', 'evaluate', 'variables', 'breakpoints.patch'].includes(
          method
        ),
      dispatch: async (method: string, p: any, guard: () => void) => {
        guard()
        calls++
        if (['step', 'continue', 'evaluate'].includes(method))
          core.debugger.executionIntent(
            id,
            initial.incarnation,
            core.debugger.snapshot(id).snapshot.state_revision,
            method === 'evaluate' ? 'evaluate' : (method as 'step' | 'continue')
          )
        return { value: 'explicit requested value' }
      },
    })
    const grant = (extra = {}) =>
      control.createGrant(owner, {
        installation_id: owner.installation_id,
        run_id: 'run',
        task_id: 'task',
        conversation_id: target.conversation_id,
        workspace_id: target.workspace_id,
        target_id: target.target_id,
        debug_session_id: id,
        incarnation: initial.incarnation,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        actions: ['read', 'step', 'pause', 'continue', 'breakpoints', 'expressions'],
        ...extra,
      })
    const agent = (g: any) => ({
      kind: 'agent',
      authority: owner,
      grant_id: g.grant_id,
      run_id: 'run',
      task_id: 'task',
      conversation_id: target.conversation_id,
      workspace_id: target.workspace_id,
      target_id: target.target_id,
    })
    const human = { kind: 'human', authority: owner }
    await work({
      core,
      control,
      owner,
      other,
      id,
      dir,
      body,
      stop,
      grant,
      agent,
      human,
      calls: () => calls,
    })
  } finally {
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('shared debugger authorization and durable coordination', () => {
  it('validates direct read arguments and authorizes the replay cursor session', () =>
    fixture(async (f) => {
      const a = f.agent(f.grant({ actions: ['read'] }))
      const other = f.core.debugger.create({ ...target, target_id: 'other-target' })
      const cursor = {
        debug_session_id: other.debug_session_id,
        incarnation: 'unknown',
        event_seq: 0,
      }
      expect(() => f.control.read(a, 'replay', { debug_session_id: f.id, cursor })).toThrow(
        'invalid_params'
      )
      expect(() => f.control.read(a, 'replay', { cursor })).toThrow('unauthorized')
      expect(() => f.control.read(a, 'history', { debug_session_id: f.id, limit: 129 })).toThrow(
        'invalid_params'
      )
      expect(() => f.control.read(a, 'status', { debug_session_id: f.id, cursor })).toThrow(
        'invalid_params'
      )
      expect(() => f.control.read(a, 'pause', { debug_session_id: f.id })).toThrow(
        'unsupported_method'
      )
      expect(
        f.control.read(a, 'replay', { cursor: f.core.debugger.snapshot(f.id).cursor })
      ).toMatchObject({ kind: 'events', events: [] })
    }))
  it.each(['target', 'incarnation'])(
    'excludes retained history outside a new %s grant before paging',
    (change) =>
      fixture(async (f) => {
        f.core.debugger.recordHistory(f.id, {
          actor: { kind: 'node' },
          operation_id: null,
          operation: 'old-scope',
          outcome: 'completed',
          requested_data: { value: 'prior target value' },
        })
        const old = f.core.debugger.snapshot(f.id).snapshot
        const newTarget =
          change === 'target'
            ? {
                ...old.target,
                target_id: 'new-target',
                workspace_id: 'new-workspace',
                conversation_id: 'new-conversation',
              }
            : old.target
        const replaced = f.core.debugger.replaceTarget(f.id, newTarget)
        expect(replaced.incarnation).not.toBe(old.incarnation)
        f.core.debugger.recordHistory(f.id, {
          actor: { kind: 'node' },
          operation_id: null,
          operation: 'new-scope',
          outcome: 'completed',
          requested_data: { value: 'current target value' },
        })
        const g = f.grant({
          actions: ['read'],
          incarnation: replaced.incarnation,
          target_id: newTarget.target_id,
          workspace_id: newTarget.workspace_id,
          conversation_id: newTarget.conversation_id,
        })
        const a = {
          ...f.agent(g),
          target_id: newTarget.target_id,
          workspace_id: newTarget.workspace_id,
          conversation_id: newTarget.conversation_id,
        }
        const args = { debug_session_id: f.id, after: 0, limit: 1 }
        const history = f.control.read(a, 'history', args)
        expect(history.entries.map((entry: any) => entry.operation)).toEqual(['new-scope'])
        expect(history.entries[0].requested_data).toEqual({ value: 'current target value' })
        expect(
          f.control
            .read(f.human, 'history', { ...args, limit: 128 })
            .entries.map((entry: any) => entry.operation)
        ).toEqual(['old-scope', 'new-scope'])
        f.control.checkPublication(a, f.id)
        f.control.revokeGrant(f.owner, g.grant_id)
        expect(() => f.control.read(a, 'history', args)).toThrow('unauthorized')
        expect(() => f.control.checkPublication(a, f.id)).toThrow('unauthorized')
      })
  )
  it.each([
    { stage: 'queued', revoke: 'device' },
    { stage: 'slot', revoke: 'device' },
    { stage: 'queued', revoke: 'rotation' },
    { stage: 'slot', revoke: 'rotation' },
  ])(
    'irreversibly revokes a separate approving device at $stage admission on $revoke',
    ({ stage, revoke }) =>
      fixture(async (f) => {
        const key = 'fixture-approving-key'
        f.core.db
          .prepare("INSERT INTO paired_devices VALUES(?,?,?,'confirmed')")
          .run(f.other.installation_id, key, 'fixture-fingerprint')
        const paired = {
          installation_id: f.other.installation_id,
          profile: 'paired-wss-v1',
          device_key: key,
        }
        const g = f.grant(),
          a = f.agent(g)
        const gate = deferred(),
          entered = deferred()
        let expressionCalls = 0
        f.control.registerBackend(f.id, {
          supports: () => true,
          dispatch: async (method: string, _p: unknown, guard: () => void) => {
            guard()
            if (
              (stage === 'queued' && method === 'pause') ||
              (stage === 'slot' && method === 'evaluate')
            ) {
              entered.resolve()
              await gate.promise
            }
            guard()
            if (method === 'evaluate') expressionCalls++
            return {}
          },
        })
        let blocker: Promise<unknown> | undefined
        if (stage === 'queued') {
          const p = f.body('blocking')
          delete p.kind
          delete p.single_thread
          blocker = f.control.command(f.human, 'pause', p)
          await entered.promise
        }
        const p = {
          ...f.body('paired-approved'),
          frame_handle: f.core.debugger.issueHandle(f.id, 'frame', 1, 1),
          expression: 'counter++',
        }
        delete p.thread_id
        delete p.kind
        delete p.single_thread
        const proposal = await f.control.command(a, 'evaluate', p)
        const approved = f.control.approve(paired, {
          principal_key: f.control.principalKey(a),
          operation_id: p.operation_id,
          proposal_hash: proposal.proposal_hash,
          decision: 'approve',
        })
        if (stage === 'slot') await entered.promise
        if (revoke === 'device') f.core.pairing.revoke(paired.installation_id)
        else await f.core.pairing.identity.rotate()
        // Re-enroll exactly the SAME installation/key before the blocked effect gets
        // its turn. The grant was issued by another, still-authorized local owner.
        f.core.db
          .prepare("UPDATE paired_devices SET state='confirmed' WHERE installation_id=?")
          .run(paired.installation_id)
        expect(() => f.control.permissions.owner(paired)).not.toThrow()
        expect(
          f.control.permissions.authorize(a, f.core.debugger.snapshot(f.id).snapshot, 'expressions')
            .grant_id
        ).toBe(g.grant_id)
        gate.resolve()
        if (blocker) await blocker
        const receipt = await approved
        expect(receipt).toMatchObject({
          code: 'approval_revoked',
          outcome: stage === 'queued' ? 'rejected' : 'outcome_unknown',
        })
        expect(expressionCalls).toBe(0)
        const row = f.core.db
          .prepare("SELECT body FROM debug_operations WHERE operation_id='paired-approved'")
          .get()
        expect(JSON.parse(String(row.body)).approval_revoked).toBe(true)
        expect((await f.control.command(a, 'evaluate', p)).outcome).toBe(receipt.outcome)
        expect(
          (
            await f.control.approve(paired, {
              principal_key: f.control.principalKey(a),
              operation_id: p.operation_id,
              proposal_hash: proposal.proposal_hash,
              decision: 'approve',
            })
          ).outcome
        ).toBe(receipt.outcome)
        expect(expressionCalls).toBe(0)
        const fresh = { ...p, operation_id: 'after-reenrollment' }
        const newProposal = await f.control.command(a, 'evaluate', fresh)
        expect(
          (
            await f.control.approve(paired, {
              principal_key: f.control.principalKey(a),
              operation_id: fresh.operation_id,
              proposal_hash: newProposal.proposal_hash,
              decision: 'approve',
            })
          ).outcome
        ).toBe('completed')
        expect(expressionCalls).toBe(1)
      })
  )
  it('asks by default without holding the lock; a human step makes approval stale', () =>
    fixture(async (f) => {
      const agent = f.agent(f.grant())
      const proposal = await f.control.command(agent, 'step', f.body('agent'))
      expect(proposal).toMatchObject({ outcome: 'pending', dispatch: 'not_dispatched' })
      expect(f.calls()).toBe(0)
      await f.control.command(f.human, 'step', f.body('human'))
      const approved = await f.control.approve(f.owner, {
        principal_key: f.control.principalKey(agent),
        operation_id: 'agent',
        proposal_hash: proposal.proposal_hash,
        decision: 'approve',
      })
      expect(approved).toMatchObject({
        code: 'stale_state',
        outcome: 'rejected',
        dispatch: 'not_dispatched',
      })
      expect(f.calls()).toBe(1)
    }))
  it.each(['ask', 'allow-all'])('uses %s for every agent command, including expressions', (mode) =>
    fixture(async (f) => {
      let sends = 0
      f.control.registerBackend(f.id, {
        supports: () => true,
        dispatch: async (_method: string, _params: unknown, guard: () => void) => {
          guard()
          sends++
          return {}
        },
      })
      const a = f.agent(
        f.grant({
          mode,
          actions: [
            'read',
            'step',
            'continue',
            'pause',
            'breakpoints',
            'detach',
            'terminate',
            'expressions',
          ],
        })
      )
      const base = () => {
        const p = f.body('unused')
        delete p.thread_id
        delete p.kind
        delete p.single_thread
        return p
      }
      const frame = f.core.debugger.issueHandle(f.id, 'frame', 1, 1)
      const object = f.core.debugger.issueHandle(f.id, 'object', 1, 1)
      const cases = [
        ['step', { thread_id: 1, kind: 'over' }],
        ['continue', { thread_id: 1 }],
        ['pause', {}],
        ['exceptionBreakpoints.set', { filters: [] }],
        [
          'breakpoints.patch',
          {
            expected_breakpoint_revision: 0,
            upsert: [
              { breakpoint_id: 'condition', source_id: 'source', line: 1, condition: 'x++' },
              { breakpoint_id: 'log', source_id: 'source', line: 2, log_message: '{x++}' },
            ],
            remove: [],
          },
        ],
        ['evaluate', { frame_handle: frame, expression: 'x++' }],
        ['setVariable', { handle: object, name: 'x', value: '2' }],
        ['variables', { handle: object }],
        ['detach', {}],
      ] as const
      for (const [method, args] of cases) {
        const before = sends
        const p = { ...base(), ...args, operation_id: method }
        const receipt = await f.control.command(a, method, p)
        expect(receipt).toMatchObject({
          outcome: mode === 'ask' ? 'pending' : 'completed',
          dispatch: mode === 'ask' ? 'not_dispatched' : 'dispatched',
        })
        expect(sends).toBe(before + (mode === 'ask' ? 0 : 1))
        if (mode === 'ask') {
          expect(
            (
              await f.control.approve(f.owner, {
                principal_key: f.control.principalKey(a),
                operation_id: method,
                proposal_hash: receipt.proposal_hash,
                decision: 'approve',
              })
            ).outcome
          ).toBe('completed')
        }
        expect((await f.control.command(a, method, p)).outcome).toBe('completed')
        expect(sends).toBe(before + 1)
      }
      // Reads that were not approval-gated remain scoped, immediate reads.
      expect(f.control.read(a, 'status', { debug_session_id: f.id })).toHaveProperty('snapshot')
    })
  )
  it('switches allow-all to ask mid-queue without treating mode permission as exact approval', () =>
    fixture(async (f) => {
      const gate = deferred(),
        entered = deferred()
      const sent: string[] = []
      f.control.registerBackend(f.id, {
        supports: () => true,
        dispatch: async (_m: string, p: any, guard: () => void) => {
          guard()
          sent.push(p.operation_id)
          if (p.operation_id === 'block') {
            entered.resolve()
            await gate.promise
          }
          return {}
        },
      })
      const g = f.grant({ mode: 'allow-all' }),
        a = f.agent(g)
      const p = f.body('block')
      delete p.kind
      delete p.single_thread
      const block = f.control.command(f.human, 'pause', p)
      await entered.promise
      const queued = f.control.command(a, 'pause', { ...p, operation_id: 'queued' })
      const changed = await f.core.request(f.owner, 'debugger.v1.grant.setMode', {
        grant_id: g.grant_id,
        mode: 'ask',
      })
      expect(changed).toMatchObject({ mode: 'ask', grant_id: g.grant_id })
      gate.resolve()
      await block
      const proposal = await queued
      expect(proposal).toMatchObject({ outcome: 'pending', dispatch: 'not_dispatched' })
      expect(sent).toEqual(['block'])
      expect(
        (await f.core.request(f.owner, 'debugger.v1.approvals', { debug_session_id: f.id }))
          .proposals
      ).toHaveLength(1)
      expect(
        (
          await f.control.approve(f.owner, {
            principal_key: f.control.principalKey(a),
            operation_id: 'queued',
            proposal_hash: proposal.proposal_hash,
            decision: 'approve',
          })
        ).outcome
      ).toBe('completed')
      expect(sent).toEqual(['block', 'queued'])
    }))
  it('retains exact owner approval when a mode-switched command is still queued', () =>
    fixture(async (f) => {
      const gate = deferred(),
        entered = deferred()
      const sent: string[] = []
      f.control.registerBackend(f.id, {
        supports: () => true,
        dispatch: async (_m: string, p: any, guard: () => void) => {
          guard()
          sent.push(p.operation_id)
          if (p.operation_id === 'approval-block') {
            entered.resolve()
            await gate.promise
          }
          return {}
        },
      })
      const g = f.grant({ mode: 'allow-all' }),
        a = f.agent(g)
      const p = f.body('approval-block')
      delete p.kind
      delete p.single_thread
      const block = f.control.command(f.human, 'pause', p)
      await entered.promise
      const queued = f.control.command(a, 'pause', { ...p, operation_id: 'approved-queued' })
      f.control.setGrantMode(f.owner, g.grant_id, 'ask')
      const page = await f.core.request(f.owner, 'debugger.v1.approvals', {
        debug_session_id: f.id,
      })
      const approved = f.control.approve(f.owner, {
        principal_key: f.control.principalKey(a),
        operation_id: 'approved-queued',
        proposal_hash: page.proposals[0].receipt.proposal_hash,
        decision: 'approve',
      })
      gate.resolve()
      await block
      expect(await queued).toMatchObject({ outcome: 'completed' })
      expect(await approved).toMatchObject({ outcome: 'completed' })
      expect(sent).toEqual(['approval-block', 'approved-queued'])
    }))
  it('switches pending asks to allow-all but still rejects stale proposals', () =>
    fixture(async (f) => {
      const g = f.grant(),
        a = f.agent(g)
      const p = f.body('stale-mode')
      expect((await f.control.command(a, 'step', p)).outcome).toBe('pending')
      await f.control.command(f.human, 'step', f.body('human-mode'))
      await f.core.request(f.owner, 'debugger.v1.grant.setMode', {
        grant_id: g.grant_id,
        mode: 'allow-all',
      })
      expect(await f.control.command(a, 'step', p)).toMatchObject({
        outcome: 'rejected',
        code: 'stale_state',
        dispatch: 'not_dispatched',
      })
      expect(f.calls()).toBe(1)
      f.stop()
      expect((await f.control.command(a, 'step', f.body('fresh-mode'))).outcome).toBe('completed')
    }))
  it('releases existing fresh asks in allow-all and keeps mode changes owner-only and scoped', () =>
    fixture(async (f) => {
      const g = f.grant(),
        a = f.agent(g)
      const p = f.body('fresh-ask')
      expect((await f.control.command(a, 'step', p)).outcome).toBe('pending')
      expect(() =>
        f.control.setGrantMode({ installation_id: 'unknown' }, g.grant_id, 'allow-all')
      ).toThrow('unauthorized')
      expect(f.control.permissions.grant(g.grant_id).mode).toBe('ask')
      const updated = await f.core.request(f.owner, 'debugger.v1.grant.setMode', {
        grant_id: g.grant_id,
        mode: 'allow-all',
      })
      expect(updated).toEqual({ ...g, mode: 'allow-all' })
      expect((await f.control.command(a, 'step', p)).outcome).toBe('completed')
      expect(f.calls()).toBe(1)
      f.control.setGrantMode(f.owner, g.grant_id, 'ask')
      expect((await f.control.command(a, 'step', p)).outcome).toBe('completed')
      expect(f.calls()).toBe(1)
      f.control.revokeGrant(f.owner, g.grant_id)
      expect(() => f.control.setGrantMode(f.owner, g.grant_id, 'allow-all')).toThrow('unauthorized')
      const expired = f.grant({ expires_at: new Date(0).toISOString() })
      expect(() => f.control.setGrantMode(f.owner, expired.grant_id, 'allow-all')).toThrow(
        'unauthorized'
      )
    }))
  it('persists allow-all without reviving pending effects or the old incarnation on restart', () =>
    fixture(async (f) => {
      const g = f.grant({ mode: 'allow-all' })
      f.core.close()
      const next = new NodeCore(f.dir, { debuggerEnabled: true })
      try {
        expect(next.debuggerControl.permissions.grant(g.grant_id).mode).toBe('allow-all')
        expect(() =>
          next.debuggerControl.read(f.agent(g), 'status', { debug_session_id: f.id })
        ).toThrow('unauthorized')
      } finally {
        next.close()
      }
    }))
  it('rechecks mode after a physical slot wait without claiming non-dispatch certainty', () =>
    fixture(async (f) => {
      const gate = deferred(),
        entered = deferred()
      let sends = 0
      f.control.registerBackend(f.id, {
        supports: () => true,
        dispatch: async (_m: string, _p: unknown, guard: () => void) => {
          entered.resolve()
          await gate.promise
          guard()
          sends++
          return {}
        },
      })
      const g = f.grant({ mode: 'allow-all' }),
        a = f.agent(g)
      const p = f.body('slot-mode')
      delete p.kind
      delete p.single_thread
      const pending = f.control.command(a, 'pause', p)
      await entered.promise
      await f.core.request(f.owner, 'debugger.v1.grant.setMode', {
        grant_id: g.grant_id,
        mode: 'ask',
      })
      gate.resolve()
      expect(await pending).toMatchObject({
        outcome: 'outcome_unknown',
        dispatch: 'possible',
        code: 'approval_required',
      })
      expect(sends).toBe(0)
    }))
  it.each(
    [[], ['step'], ['step', 'continue', 'pause', 'breakpoints']].map((classes) => ({ classes }))
  )('migrates legacy auto classes $classes to ask, never allow-all', ({ classes }) =>
    fixture(async (f) => {
      const g = f.grant()
      f.core.db
        .prepare('UPDATE debug_grants SET body=? WHERE grant_id=?')
        .run(JSON.stringify({ ...g, mode: 'auto', auto_actions: classes }), g.grant_id)
      f.core.db
        .prepare('INSERT OR REPLACE INTO debug_policy VALUES(1,?)')
        .run(JSON.stringify({ mode: 'auto', auto_actions: classes, max_grant_ms: 1234 }))
      f.core.db.exec('PRAGMA user_version=14')
      f.core.close()
      const next = new NodeCore(f.dir, { debuggerEnabled: true })
      try {
        expect(next.debuggerControl.permissions.grant(g.grant_id)).toMatchObject({
          mode: 'ask',
          actions: g.actions,
          expires_at: g.expires_at,
        })
        expect(next.debuggerControl.permissions.grant(g.grant_id)).not.toHaveProperty(
          'auto_actions'
        )
        expect(next.debuggerControl.permissions.policy()).toMatchObject({
          mode: 'ask',
          max_grant_ms: 1234,
        })
        expect(next.debuggerControl.permissions.policy()).not.toHaveProperty('auto_actions')
        expect(
          JSON.parse(
            String(
              next.db.prepare('SELECT body FROM debug_grants WHERE grant_id=?').get(g.grant_id)!
                .body
            )
          )
        ).not.toHaveProperty('auto_actions')
      } finally {
        next.close()
      }
    })
  )
  it('allows task controls and expressions together in allow-all', () =>
    fixture(async (f) => {
      const a = f.agent(f.grant({ mode: 'allow-all' }))
      expect((await f.control.command(a, 'step', f.body('step'))).outcome).toBe('completed')
      f.stop()
      const p = {
        ...f.body('expr'),
        frame_handle: f.core.debugger.issueHandle(f.id, 'frame', 1, 1),
        expression: 'x++',
      }
      delete p.thread_id
      delete p.kind
      delete p.single_thread
      expect((await f.control.command(a, 'evaluate', p)).outcome).toBe('completed')
      expect(f.calls()).toBe(2)
    }))
  it('requires exact expression approval even for human proposals', () =>
    fixture(async (f) => {
      const p = {
        ...f.body('expr'),
        frame_handle: f.core.debugger.issueHandle(f.id, 'frame', 1, 1),
        expression: 'x++',
      }
      delete p.thread_id
      delete p.kind
      delete p.single_thread
      const proposal = await f.control.command(f.human, 'evaluate', p)
      await expect(
        f.control.approve(f.owner, {
          principal_key: f.control.principalKey(f.human),
          operation_id: 'expr',
          proposal_hash: 'changed',
          decision: 'approve',
        })
      ).rejects.toThrow('approval_mismatch')
      expect(f.calls()).toBe(0)
      expect(
        (
          await f.control.approve(f.owner, {
            principal_key: f.control.principalKey(f.human),
            operation_id: 'expr',
            proposal_hash: proposal.proposal_hash,
            decision: 'approve',
          })
        ).outcome
      ).toBe('completed')
    }))
  it('deduplicates concurrent commands and rejects changed bodies', () =>
    fixture(async (f) => {
      const p = f.body('same')
      const [a, b] = await Promise.all([
        f.control.command(f.human, 'step', p),
        f.control.command(f.human, 'step', p),
      ])
      expect(a).toEqual(b)
      expect(f.calls()).toBe(1)
      await expect(f.control.command(f.human, 'step', { ...p, kind: 'in' })).rejects.toThrow(
        'idempotency_mismatch'
      )
    }))
  it('keeps operation IDs principal-scoped and output does not stale an approval', () =>
    fixture(async (f) => {
      const a = f.agent(f.grant())
      const proposed = await f.control.command(a, 'step', f.body('shared-id'))
      f.core.debugger.observe(f.id, f.body('unused').incarnation, {
        kind: 'output',
        category: 'stdout',
        text: 'output',
      })
      const approved = await f.control.approve(f.other, {
        principal_key: f.control.principalKey(a),
        operation_id: 'shared-id',
        proposal_hash: proposed.proposal_hash,
        decision: 'approve',
      })
      expect(approved.outcome).toBe('completed')
      f.stop()
      expect((await f.control.command(f.human, 'step', f.body('shared-id'))).outcome).toBe(
        'completed'
      )
      expect(f.calls()).toBe(2)
    }))
  it('cannot route an expression through the inspection entrypoint', () =>
    fixture(async (f) => {
      const a = f.agent(f.grant({ actions: ['read'] }))
      await expect(
        f.control.inspect(a, 'evaluate', {
          ...f.body('bypass'),
          frame_handle: f.core.debugger.issueHandle(f.id, 'frame', 1, 1),
          expression: 'x++',
        })
      ).rejects.toThrow('unsupported_method')
      expect(f.calls()).toBe(0)
    }))
  it('treats a stolen live handle as a reference, not read/expression permission', () =>
    fixture(async (f) => {
      const a = f.agent(f.grant({ actions: ['pause'] }))
      const handle = f.core.debugger.issueHandle(f.id, 'object', 1, 1)
      expect(() => f.control.read(a, 'status', { debug_session_id: f.id })).toThrow('unauthorized')
      await expect(
        f.control.command(a, 'variables', {
          operation_id: 'stolen',
          debug_session_id: f.id,
          incarnation: f.body('unused').incarnation,
          expected_state_revision: f.body('unused').expected_state_revision,
          handle,
        })
      ).rejects.toThrow('unauthorized')
      expect(f.calls()).toBe(0)
    }))
  it('revokes queued commands and checks again at backend slot admission', () =>
    fixture(async (f) => {
      const gate = deferred(),
        entered = deferred()
      let calls = 0
      f.control.registerBackend(f.id, {
        supports: () => true,
        dispatch: async (_m: string, _p: unknown, guard: () => void) => {
          entered.resolve()
          await gate.promise
          guard()
          calls++
          return {}
        },
      })
      const g = f.grant({ mode: 'allow-all' }),
        a = f.agent(g)
      const p = { ...f.body('one') }
      delete p.kind
      delete p.single_thread
      const one = f.control.command(a, 'pause', p)
      await entered.promise
      const two = f.control.command(a, 'pause', { ...p, operation_id: 'two' })
      f.control.revokeGrant(f.owner, g.grant_id)
      gate.resolve()
      expect((await one).outcome).toBe('outcome_unknown')
      expect((await two).code).toBe('unauthorized')
      expect(calls).toBe(0)
    }))
  it('rechecks execution preconditions after physical dispatch slot waits', () =>
    fixture(async (f) => {
      const gate = deferred(),
        entered = deferred()
      let calls = 0
      f.control.registerBackend(f.id, {
        supports: () => true,
        dispatch: async (_m: string, _p: unknown, guard: () => void) => {
          entered.resolve()
          await gate.promise
          guard()
          calls++
          return {}
        },
      })
      const pending = f.control.command(f.human, 'step', f.body('slot'))
      await entered.promise
      f.stop() // A new adapter stop while transport capacity is unavailable.
      gate.resolve()
      expect((await pending).code).toBe('stale_state')
      expect(calls).toBe(0)
    }))
  it('authorizes retained reads and rechecks publication after revocation', () =>
    fixture(async (f) => {
      const g = f.grant(),
        a = f.agent(g)
      f.core.debugger.recordHistory(f.id, {
        actor: { kind: 'node' },
        operation_id: null,
        operation: 'fixture',
        outcome: 'completed',
        requested_data: { secret: 'requested' },
      })
      expect(
        f.control.read(a, 'history', { debug_session_id: f.id, after: 0, limit: 128 }).entries
      ).toHaveLength(1)
      f.control.revokeGrant(f.owner, g.grant_id)
      expect(() => f.control.read(a, 'history', { debug_session_id: f.id })).toThrow('unauthorized')
      expect(() => f.control.checkPublication(a, f.id)).toThrow('unauthorized')
      expect(() =>
        f.core.checkPublication(f.owner, 'debugger.v1.status', { debug_session_id: f.id })
      ).not.toThrow()
      f.core.revokeToken(f.owner.installation_id)
      expect(() =>
        f.core.checkPublication(f.owner, 'debugger.v1.status', { debug_session_id: f.id })
      ).toThrow('unauthorized')
    }))
  it('does not revive debugger grants when a revoked paired key is enrolled again', () =>
    fixture(async (f) => {
      const key = 'fixture-public-key'
      f.core.db
        .prepare("INSERT INTO paired_devices VALUES(?,?,?,'confirmed')")
        .run(f.owner.installation_id, key, 'fixture-fingerprint')
      const paired = {
        installation_id: f.owner.installation_id,
        profile: 'paired-wss-v1',
        device_key: key,
      }
      const g = f.control.createGrant(paired, {
        installation_id: f.owner.installation_id,
        run_id: 'run',
        task_id: 'task',
        conversation_id: target.conversation_id,
        workspace_id: target.workspace_id,
        target_id: target.target_id,
        debug_session_id: f.id,
        incarnation: f.body('unused').incarnation,
        expires_at: new Date(Date.now() + 60000).toISOString(),
        actions: ['read'],
      })
      const a = { ...f.agent(g), authority: paired }
      expect(() => f.control.read(a, 'history', { debug_session_id: f.id })).not.toThrow()
      f.core.pairing.revoke(f.owner.installation_id)
      f.core.db
        .prepare("UPDATE paired_devices SET state='confirmed' WHERE installation_id=?")
        .run(f.owner.installation_id)
      expect(() => f.core.authority.check(paired, 'request')).not.toThrow()
      expect(() => f.control.read(a, 'history', { debug_session_id: f.id })).toThrow('unauthorized')
    }))
  it('binds grants to run, task, conversation, workspace, target, session and expiry', () =>
    fixture(async (f) => {
      const a = f.agent(f.grant())
      for (const [key, value] of Object.entries({
        run_id: 'wrong',
        task_id: 'wrong',
        conversation_id: 'wrong',
        workspace_id: 'wrong',
        target_id: 'wrong',
      }))
        expect(() =>
          f.control.read({ ...a, [key]: value }, 'status', { debug_session_id: f.id })
        ).toThrow('unauthorized')
      const expired = f.agent(f.grant({ expires_at: new Date(0).toISOString() }))
      expect(() => f.control.read(expired, 'status', { debug_session_id: f.id })).toThrow(
        'unauthorized'
      )
      f.control.settleTask('task', 'run')
      expect(() => f.control.read(a, 'status', { debug_session_id: f.id })).toThrow('unauthorized')
    }))
  it.each(['intent', 'dispatch', 'result'])(
    'recovers a crash at the durable %s boundary without redispatch',
    (boundary) =>
      fixture(async (f) => {
        const p = f.body('crash')
        let commits = 0
        f.core.fault = (point: string) => {
          if (point === 'before_commit') commits++
          if (
            (boundary === 'intent' && commits === 1 && point === 'after_commit') ||
            (boundary === 'dispatch' && commits === 2 && point === 'after_commit') ||
            (boundary === 'result' && commits === 3 && point === 'before_commit')
          )
            throw new Error('crash')
        }
        await expect(f.control.command(f.human, 'step', p)).rejects.toThrow('crash')
        expect(f.calls()).toBe(boundary === 'result' ? 1 : 0)
        f.core.fault = undefined
        f.core.close()
        const next = new NodeCore(f.dir, { debuggerEnabled: true })
        let replayed = 0
        try {
          next.debuggerControl.registerBackend(f.id, {
            supports: () => true,
            dispatch: async () => {
              replayed++
              return {}
            },
          })
          const r = await next.debuggerControl.command(f.human, 'step', p)
          expect(r.outcome).toBe('outcome_unknown')
          expect(r.dispatch).toBe(boundary === 'intent' ? 'not_dispatched' : 'possible')
          expect(replayed).toBe(0)
        } finally {
          next.close()
        }
      })
  )
  it('allows only owners to configure bounded defaults and rejects legacy action-class policy', () =>
    fixture(async (f) => {
      expect(() =>
        f.control.permissions.setPolicy({ installation_id: 'unknown' }, { mode: 'allow-all' })
      ).toThrow('unauthorized')
      expect(() =>
        f.control.permissions.setPolicy(f.owner, { mode: 'auto', auto_actions: ['expressions'] })
      ).toThrow()
      f.control.permissions.setPolicy(f.owner, {
        mode: 'allow-all',
        max_grant_ms: 1000,
      })
      expect(() => f.grant()).toThrow('grant_expiry_limit')
      const g = f.grant({ expires_at: new Date(Date.now() + 500).toISOString() })
      expect(g).toMatchObject({ mode: 'allow-all' })
      expect(g).not.toHaveProperty('auto_actions')
    }))
  it('bounds exact proposal pages without dropping pending identity or silently truncating a command', () =>
    fixture(async (f) => {
      for (let n = 0; n < 24; n++) {
        const p = {
          ...f.body('expr-' + n),
          frame_handle: f.core.debugger.issueHandle(f.id, 'frame', n, 1),
          expression: 'x'.repeat(8000),
        }
        delete p.thread_id
        delete p.kind
        delete p.single_thread
        expect((await f.control.command(f.human, 'evaluate', p)).outcome).toBe('pending')
      }
      const page = await f.core.request(f.owner, 'debugger.v1.approvals', {
        debug_session_id: f.id,
      })
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(65536)
      expect(page.truncated).toBe(true)
      expect(page.proposals.length).toBeGreaterThan(0)
      const next = await f.core.request(f.owner, 'debugger.v1.approvals', {
        debug_session_id: f.id,
        after: page.next,
      })
      expect(next.proposals[0].key).not.toBe(page.proposals[0].key)
      expect(f.core.debugger.snapshot(f.id).snapshot.pending_approvals).toHaveLength(24)
    }))
  it('bounds cumulative expression-bearing breakpoint intent without poisoning storage', () =>
    fixture(async (f) => {
      const upsert = Array.from({ length: 12 }, (_, n) => ({
        breakpoint_id: 'bp' + n,
        source_id: 'source',
        line: n + 1,
        condition: 'x'.repeat(8192),
      }))
      expect(() => f.core.debugger.patchBreakpoints(f.id, 0, upsert, [])).toThrow(
        'debugger_breakpoint_limit'
      )
      expect(f.core.debugger.snapshot(f.id).snapshot.breakpoint_revision).toBe(0)
      expect(() =>
        f.core.debugger.patchBreakpoints(
          f.id,
          0,
          [{ breakpoint_id: 'small', source_id: 'source', line: 1 }],
          []
        )
      ).not.toThrow()
    }))
  it('rejects oversized command bodies before durable admission', () =>
    fixture(async (f) => {
      const p = {
        ...f.body('huge'),
        expected_breakpoint_revision: 0,
        upsert: Array.from({ length: 40 }, (_, n) => ({
          breakpoint_id: 'bp' + n,
          source_id: 'source',
          line: n + 1,
          condition: 'x'.repeat(8192),
        })),
        remove: [],
      }
      delete p.thread_id
      delete p.kind
      delete p.single_thread
      await expect(f.control.command(f.human, 'breakpoints.patch', p)).rejects.toThrow(
        'debugger_request_too_large'
      )
      expect(
        f.core.db.prepare("SELECT 1 FROM debug_operations WHERE operation_id='huge'").get()
      ).toBeUndefined()
      expect(f.calls()).toBe(0)
    }))
  it('keeps exact pending arguments but strips them from terminal dedup evidence', () =>
    fixture(async (f) => {
      const p = {
        ...f.body('sensitive'),
        frame_handle: f.core.debugger.issueHandle(f.id, 'frame', 1, 1),
        expression: 'sensitive requested expression',
      }
      delete p.thread_id
      delete p.kind
      delete p.single_thread
      const proposed = await f.control.command(f.human, 'evaluate', p)
      const stored = () =>
        JSON.parse(
          String(
            f.core.db
              .prepare("SELECT body FROM debug_operations WHERE operation_id='sensitive'")
              .get().body
          )
        )
      expect(stored().params.expression).toBe(p.expression)
      await f.control.approve(f.owner, {
        principal_key: f.control.principalKey(f.human),
        operation_id: 'sensitive',
        proposal_hash: proposed.proposal_hash,
        decision: 'approve',
      })
      expect(stored().params).not.toHaveProperty('expression')
      expect(stored().receipt).not.toHaveProperty('snapshot')
      expect(stored().hash).toEqual(expect.any(String))
      expect((await f.control.command(f.human, 'evaluate', p)).outcome).toBe('completed')
      await expect(
        f.control.command(f.human, 'evaluate', { ...p, expression: 'changed' })
      ).rejects.toThrow('idempotency_mismatch')
      expect(f.calls()).toBe(1)
    }))
  it('rejects unsupported effects without dispatch and returns completion state', () =>
    fixture(async (f) => {
      const p = f.body('restart')
      delete p.thread_id
      delete p.kind
      delete p.single_thread
      const r = await f.control.command(f.human, 'restart', p)
      expect(r).toMatchObject({
        outcome: 'rejected',
        code: 'unsupported_operation',
        snapshot: { debug_session_id: f.id },
      })
      expect(f.calls()).toBe(0)
    }))
  it('pauses effects on storage failure before intent is committed', () =>
    fixture(async (f) => {
      f.core.fault = () => {
        throw new Error('disk')
      }
      await expect(f.control.command(f.human, 'step', f.body('disk'))).rejects.toThrow('disk')
      expect(f.calls()).toBe(0)
      f.core.fault = undefined
      await expect(f.control.command(f.human, 'step', f.body('disk2'))).rejects.toThrow(
        'storage_unavailable'
      )
    }))
  it('exposes only gated authorized RPCs and never trusts caller-supplied actor identity', () =>
    fixture(async (f) => {
      expect(
        await f.core.request(f.owner, 'debugger.v1.status', { debug_session_id: f.id })
      ).toHaveProperty('snapshot')
      expect(() =>
        f.core.request(f.owner, 'debugger.v1.status', { debug_session_id: f.id, actor: 'agent' })
      ).toThrow('invalid_params')
      expect(() => f.control.createGrant({ installation_id: 'not-enrolled' }, {})).toThrow(
        'unauthorized'
      )
    }))
  it('keeps sessions independently schedulable', () =>
    fixture(async (f) => {
      const gate = deferred(),
        entered = deferred()
      f.control.registerBackend(f.id, {
        supports: () => true,
        dispatch: async () => {
          entered.resolve()
          await gate.promise
          return {}
        },
      })
      const p = f.body('blocked')
      delete p.kind
      delete p.single_thread
      const blocked = f.control.command(f.human, 'pause', p)
      await entered.promise
      const s = f.core.debugger.create(target)
      f.control.registerBackend(s.debug_session_id, {
        supports: () => true,
        dispatch: async (_m: string, _p: unknown, guard: () => void) => {
          guard()
          return {}
        },
      })
      expect(
        (
          await f.control.command(f.human, 'pause', {
            ...p,
            operation_id: 'other',
            debug_session_id: s.debug_session_id,
            incarnation: s.incarnation,
            expected_state_revision: 0,
          })
        ).outcome
      ).toBe('completed')
      gate.resolve()
      await blocked
    }))
  it('recovers pending intent even when the capability is disabled on restart', () =>
    fixture(async (f) => {
      await f.control.command(f.agent(f.grant()), 'step', f.body('disabled-restart'))
      f.core.close()
      const next = new NodeCore(f.dir)
      try {
        expect(next.debuggerControl.methods()).toEqual([])
        const row = next.db
          .prepare("SELECT body FROM debug_operations WHERE operation_id='disabled-restart'")
          .get()
        expect(JSON.parse(String(row?.body)).receipt.outcome).toBe('outcome_unknown')
      } finally {
        next.close()
      }
    }))
  it('recovers intent/dispatch without blind replay and preserves dedup across history eviction', () =>
    fixture(async (f) => {
      const p = f.body('durable')
      const r = await f.control.command(f.human, 'step', p)
      for (let i = 0; i < 140; i++)
        f.core.debugger.recordHistory(f.id, {
          actor: { kind: 'node' },
          operation_id: null,
          operation: 'fixture',
          outcome: 'completed',
        })
      expect((await f.control.command(f.human, 'step', p)).outcome).toBe('completed')
      f.stop()
      const waiting = await f.control.command(f.agent(f.grant()), 'step', f.body('waiting'))
      expect(waiting.outcome).toBe('pending')
      f.core.close()
      const next = new NodeCore(f.dir, { debuggerEnabled: true })
      try {
        expect(
          next.debuggerControl.read(f.human, 'commandResult', {
            debug_session_id: f.id,
            operation_id: 'durable',
          }).outcome
        ).toBe(r.outcome)
        const row = next.db
          .prepare("SELECT body FROM debug_operations WHERE operation_id='waiting'")
          .get()
        expect(JSON.parse(String(row?.body)).receipt.outcome).toBe('outcome_unknown')
        expect(
          next.debuggerControl.read(f.human, 'status', { debug_session_id: f.id }).snapshot
            .execution
        ).toBe('unknown')
      } finally {
        next.close()
      }
    }))
})
