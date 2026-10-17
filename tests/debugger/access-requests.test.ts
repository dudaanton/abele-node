import { expect, it, vi } from 'vitest'
import { DebuggerAccessRequestSchema, SessionUpdateSchema } from '@abele/node-protocol'
import { agentFixture } from './review-fixture.js'

it('requests access, binds Allow to the host run, and settles the grant', async () => {
  const f = agentFixture(),
    run = f.run()
  try {
    f.core.db.prepare('INSERT INTO streams(stream_id,head_seq) VALUES(?,0)').run('conversation')
    const result = await run.call('debug_status', { debug_session_id: f.id })
    expect(result).toMatchObject({
      code: 'unauthorized',
      message: expect.stringContaining('owner was asked in the chat'),
      request_id: expect.any(String),
    })
    const rows = f.core.db.prepare('SELECT body FROM events WHERE stream_id=?').all('conversation')
    const update = JSON.parse(String(rows[0]!.body)).data.update
    expect(DebuggerAccessRequestSchema.parse(update)).toMatchObject({
      kind: 'debugger_access_requested',
      version: 1,
      method: 'status',
      program: 'config',
    })
    expect(SessionUpdateSchema.parse(update)).toEqual(update)
    expect(run.publish({ debug_session_id: f.id }, result)).toMatchObject({
      message: expect.stringContaining('owner was asked in the chat'),
      request_id: (result as any).request_id,
    })
    await run.call('debug_status', { debug_session_id: f.id })
    expect(f.control.request(f.owner, 'debugger.v1.access.requests', {})).toHaveLength(1)
    const grant = f.control.request(f.owner, 'debugger.v1.access.decide', {
      request_id: (result as any).request_id,
      decision: 'allow',
    }) as any
    expect(grant).toMatchObject({
      run_id: 'run',
      conversation_id: 'conversation',
      actions: ['read'],
    })
    expect(await run.call('debug_status', { debug_session_id: f.id })).toMatchObject({
      snapshot: { execution: 'stopped' },
    })
    run.close()
    expect(f.control.permissions.grant(grant.grant_id).revoked).toBe(true)
  } finally {
    run.close()
    f.close()
  }
})

it.each([false, true])('deletes an own grant (active=%s) and removes it from list', (active) => {
  const f = agentFixture()
  try {
    const grant = f.grant()
    const revoke = vi.spyOn(f.control, 'revokeGrant')
    if (!active) f.control.revokeGrant(f.owner, grant.grant_id)
    f.control.request(f.owner, 'debugger.v1.grant.delete', { grant_id: grant.grant_id })
    expect(revoke).toHaveBeenCalledWith(f.owner, grant.grant_id)
    expect(f.control.request(f.owner, 'debugger.v1.grant.list', {})).toEqual([])
    expect(() => f.control.permissions.grant(grant.grant_id)).toThrow()
  } finally {
    f.close()
  }
})

it.each(['deny', 'settle', 'replace', 'inactive', 'expired', 'revoked'] as const)(
  'fences a %s request',
  async (change) => {
    const f = agentFixture(),
      run = f.run()
    try {
      f.core.db.prepare('INSERT INTO streams(stream_id,head_seq) VALUES(?,0)').run('conversation')
      const result = (await run.call('debug_status', { debug_session_id: f.id })) as any
      const decide = () =>
        f.control.request(f.owner, 'debugger.v1.access.decide', {
          request_id: result.request_id,
          decision: 'allow',
        })
      if (change === 'deny')
        expect(
          f.control.request(f.owner, 'debugger.v1.access.decide', {
            request_id: result.request_id,
            decision: 'deny',
          })
        ).toEqual({ denied: true })
      if (change === 'settle') run.close()
      if (change === 'replace') f.core.debugger.replaceTarget(f.id, f.initial.target)
      if (change === 'inactive') f.setActive(false)
      if (change === 'expired') {
        vi.useFakeTimers()
        vi.setSystemTime(Date.now() + 86400001)
      }
      if (change === 'revoked') f.core.revokeToken(f.owner.installation_id)
      expect(decide).toThrow()
      if (change !== 'revoked')
        expect(f.control.request(f.owner, 'debugger.v1.grant.list', {})).toEqual([])
    } finally {
      vi.useRealTimers()
      run.close()
      f.close()
    }
  }
)

it('requests expression authority separately from read, without dispatching', async () => {
  const f = agentFixture(),
    run = f.run()
  try {
    f.core.db.prepare('INSERT INTO streams(stream_id,head_seq) VALUES(?,0)').run('conversation')
    f.grant({ actions: ['read'] })
    const dispatch = vi.fn()
    f.control.registerBackend(f.id, { supports: () => true, dispatch })
    const result = (await run.call('debug_evaluate', {
      debug_session_id: f.id,
      incarnation: f.initial.incarnation,
      expected_state_revision: f.core.debugger.snapshot(f.id).snapshot.state_revision,
      frame_handle: 'frame',
      expression: 'x',
    })) as any
    expect(result).toMatchObject({ code: 'unauthorized', request_id: expect.any(String) })
    const requests = f.control.request(f.owner, 'debugger.v1.access.requests', {}) as any[]
    expect(requests[0]).toMatchObject({
      actions: ['read', 'expressions'],
      access: 'evaluate/setVariable',
    })
    expect(dispatch).not.toHaveBeenCalled()
  } finally {
    run.close()
    f.close()
  }
})

it('rejects forged run identity and never asks for an unrelated chat target', async () => {
  const f = agentFixture(),
    run = f.run()
  try {
    f.core.db.prepare('INSERT INTO streams(stream_id,head_seq) VALUES(?,0)').run('conversation')
    const result = (await run.call('debug_status', { debug_session_id: f.id })) as any
    expect(() =>
      f.control.request(f.owner, 'debugger.v1.access.decide', {
        request_id: result.request_id,
        decision: 'allow',
        run_id: 'forged',
      })
    ).toThrow()
    f.core.debugger.replaceTarget(f.id, { ...f.initial.target, conversation_id: 'elsewhere' })
    expect(await run.call('debug_status', { debug_session_id: f.id })).not.toHaveProperty(
      'request_id'
    )
  } finally {
    run.close()
    f.close()
  }
})

it('refuses another issuer revoke/delete and forged issuer fields', () => {
  const f = agentFixture()
  try {
    const other = f.core.authority.authenticate(f.core.createToken('other').token),
      grant = f.grant()
    for (const method of ['revoke', 'delete']) {
      expect(() =>
        f.control.request(other, `debugger.v1.grant.${method}`, { grant_id: grant.grant_id })
      ).toThrow()
      expect(() =>
        f.control.request(other, `debugger.v1.grant.${method}`, {
          grant_id: grant.grant_id,
          owner_authority: f.owner,
        })
      ).toThrow()
    }
    expect(f.control.permissions.grant(grant.grant_id).revoked).toBe(false)
    expect(() =>
      f.control.request(other, 'debugger.v1.task.settle', {
        task_id: grant.task_id,
        run_id: grant.run_id,
      })
    ).toThrow()
    expect(f.control.permissions.grant(grant.grant_id).revoked).toBe(false)
    expect(f.control.request(other, 'debugger.v1.grant.list', {})).toEqual([])
  } finally {
    f.close()
  }
})

it('pages retained grants and deletes an own expired record', () => {
  const f = agentFixture()
  try {
    const first = f.grant({ expires_at: new Date(Date.now() - 1).toISOString() })
    const second = f.grant()
    expect(f.control.request(f.owner, 'debugger.v1.grant.list', { limit: 1 })).toEqual([second])
    expect(f.control.request(f.owner, 'debugger.v1.grant.list', { offset: 1, limit: 1 })).toEqual([
      first,
    ])
    f.control.request(f.owner, 'debugger.v1.grant.delete', { grant_id: first.grant_id })
    expect(f.control.request(f.owner, 'debugger.v1.grant.list', {})).toEqual([second])
  } finally {
    f.close()
  }
})
