import { expect, it } from 'vitest'
import { NodeCore, DebuggerRunBinding } from '@abele/node-core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { target } from './helpers.js'
import { agentFixture, barrier } from './review-fixture.js'

it('interrupt revokes debugger authority before returning, without provider drain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'debug-interrupt-'))
  const core = new NodeCore(dir, { debuggerEnabled: true })
  const owner = core.authority.authenticate(core.createToken('owner').token)
  const request = (m: string, p: unknown): any => core.request(owner, m, p, crypto.randomUUID())
  const session = request('session.create', { title: 'Fixture' })
  const input = request('session.send', {
    session_id: session.session_id,
    text: 'investigate',
    observed_seq: 0,
  })
  core.db
    .prepare("UPDATE inputs SET run_id='run',state='dispatching' WHERE input_id=?")
    .run(input.input_id)
  core.db
    .prepare("INSERT INTO provider_runs(run_id,session_id,state) VALUES('run',?,'active')")
    .run(session.session_id)
  const debug = core.debugger.create({ ...target, conversation_id: session.session_id })
  core.debugger.observe(debug.debug_session_id, debug.incarnation, {
    kind: 'lifecycle',
    lifecycle: 'active',
  })
  core.debugger.observe(debug.debug_session_id, debug.incarnation, {
    kind: 'stopped',
    thread_id: 1,
    all_threads_stopped: true,
    reason: 'pause',
    hit_breakpoint_ids: [],
  })
  const grant = core.debuggerControl.createGrant(owner, {
    installation_id: owner.installation_id,
    run_id: 'run',
    task_id: 'task',
    conversation_id: session.session_id,
    workspace_id: null,
    target_id: target.target_id,
    debug_session_id: debug.debug_session_id,
    incarnation: debug.incarnation,
    expires_at: new Date(Date.now() + 60000).toISOString(),
    actions: ['read', 'step'],
  })
  let sends = 0
  core.debuggerControl.registerBackend(debug.debug_session_id, {
    supports: () => true,
    dispatch: async (_m, _p, guard) => {
      guard()
      sends++
      return {}
    },
  })
  const principal = {
    kind: 'agent' as const,
    authority: owner,
    grant_id: grant.grant_id,
    run_id: 'run',
    task_id: 'task',
    conversation_id: session.session_id,
    workspace_id: null,
    target_id: target.target_id,
  }
  const run = new DebuggerRunBinding(core, {
    authority: owner,
    run_id: 'run',
    conversation_id: session.session_id,
    workspace_id: null,
    active: () =>
      ['dispatching', 'delivered'].includes(
        String(
          core.db.prepare('SELECT state FROM inputs WHERE input_id=?').get(input.input_id)?.state
        )
      ),
  })
  try {
    const proposal = await run.call('debug_step', {
      debug_session_id: debug.debug_session_id,
      incarnation: debug.incarnation,
      expected_state_revision: core.debugger.snapshot(debug.debug_session_id).snapshot
        .state_revision,
      thread_id: 1,
      kind: 'over',
    })
    expect(proposal.outcome).toBe('pending')
    request('session.interrupt', { session_id: session.session_id, run_id: 'run' })
    const approved = await core.debuggerControl.approve(owner, {
      principal_key: core.debuggerControl.principalKey(principal),
      operation_id: proposal.operation_id,
      proposal_hash: proposal.proposal_hash,
      decision: 'approve',
    })
    expect(approved).toMatchObject({ outcome: 'rejected', dispatch: 'not_dispatched' })
    expect(sends).toBe(0)
    expect(core.debuggerControl.permissions.grant(grant.grant_id).revoked).toBe(true)
  } finally {
    run.close()
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each(['queue', 'physical-slot'] as const)(
  'rechecks trusted run activity at %s admission',
  async (where) => {
    const f = agentFixture(),
      release = barrier(),
      entered = barrier()
    const g = f.grant(),
      run = f.run()
    let sends = 0,
      pending: Promise<any> | undefined,
      blocker: Promise<any> | undefined
    f.control.registerBackend(f.id, {
      supports: () => true,
      dispatch: async (method, _p, guard) => {
        if (where === 'queue' && method === 'pause') {
          entered.resolve()
          await release.promise
          return {}
        }
        if (where === 'physical-slot') {
          entered.resolve()
          await release.promise
        }
        guard()
        sends++
        return {}
      },
    })
    try {
      if (where === 'queue') {
        const { kind: _, ...body } = f.args()
        blocker = f.control.command({ kind: 'human', authority: f.owner }, 'pause', {
          ...body,
          operation_id: 'blocker',
        })
        await entered.promise
      }
      pending = run.call('debug_step', f.args())
      if (where === 'physical-slot') await entered.promise
      f.setActive(false) // grant deliberately remains valid: test the actual dispatch fence
      release.resolve()
      await blocker
      await pending
      expect(sends).toBe(0)
      expect(f.control.permissions.grant(g.grant_id).revoked).toBe(false)
    } finally {
      release.resolve()
      await blocker
      await pending
      run.close()
      f.close()
    }
  }
)
