import { afterEach, expect, it, vi } from 'vitest'
import { agentFixture } from './review-fixture.js'

afterEach(() => vi.useRealTimers())
it.each(['revoked', 'expired', 'replaced'] as const)(
  're-resolves a cached %s grant without revoking the new task grant',
  async (change) => {
    vi.useFakeTimers()
    const f = agentFixture(),
      old = f.grant({ actions: ['read'], expires_at: new Date(Date.now() + 10).toISOString() }),
      run = f.run()
    let sends = 0
    f.control.registerBackend(f.id, {
      supports: () => true,
      dispatch: async (_m, _p, guard) => {
        guard()
        sends++
        return {}
      },
    })
    try {
      expect(await run.call('debug_status', { debug_session_id: f.id })).toMatchObject({
        snapshot: { execution: 'stopped' },
      })
      if (change === 'revoked') f.control.revokeGrant(f.owner, old.grant_id)
      if (change === 'expired') await vi.advanceTimersByTimeAsync(10)
      const next = f.grant()
      expect(await run.call('debug_status', { debug_session_id: f.id })).toMatchObject({
        snapshot: { execution: 'stopped' },
      })
      expect(await run.call('debug_step', f.args())).toMatchObject({ outcome: 'completed' })
      expect(sends).toBe(1)
      expect(f.control.permissions.grant(next.grant_id).revoked).toBe(false)
      expect(f.control.permissions.grant(old.grant_id).revoked).toBe(change === 'revoked')
    } finally {
      run.close()
      f.close()
    }
  }
)

it('does not cache or subscribe an expired grant before successful authorization', async () => {
  vi.useFakeTimers()
  const f = agentFixture(),
    old = f.grant({ expires_at: new Date(Date.now() - 1).toISOString() }),
    run = f.run()
  const subscribe = vi.spyOn(f.control, 'subscribePermissions')
  try {
    expect(await run.call('debug_status', { debug_session_id: f.id })).toMatchObject({
      code: 'unauthorized',
      snapshot: null,
    })
    expect(subscribe).not.toHaveBeenCalled()
    const next = f.grant()
    expect(await run.call('debug_status', { debug_session_id: f.id })).toMatchObject({
      snapshot: { execution: 'stopped' },
    })
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(f.control.permissions.grant(next.grant_id).revoked).toBe(false)
    expect(f.control.permissions.grant(old.grant_id).revoked).toBe(false)
  } finally {
    subscribe.mockRestore()
    run.close()
    f.close()
  }
})

it('does not launder an old tool payload through publication under a replacement grant', async () => {
  const f = agentFixture(),
    old = f.grant(),
    run = f.run()
  try {
    f.core.debugger.recordHistory(f.id, {
      actor: { kind: 'agent', principal_id: f.owner.installation_id, run_id: 'run' },
      operation_id: 'old',
      operation: 'variables',
      outcome: 'completed',
      requested_data: 'prior-grant-value',
    })
    const result = await run.call('debug_history', { debug_session_id: f.id })
    expect(JSON.stringify(result)).toContain('prior-grant-value')
    const next = f.core.debugger.replaceTarget(f.id, result.snapshot.target)
    const grant = f.grant({ incarnation: next.incarnation })
    const published = run.publish({ debug_session_id: f.id }, result)
    expect(JSON.stringify(published)).not.toContain('prior-grant-value')
    expect(published).toMatchObject({ code: 'historical_scope_expired' })
    expect(f.control.permissions.grant(grant.grant_id).revoked).toBe(false)
    expect(f.control.permissions.grant(old.grant_id).revoked).toBe(false)
  } finally {
    run.close()
    f.close()
  }
})

it('selects the valid target incarnation instead of a cached old scope or a newer expired row', async () => {
  vi.useFakeTimers()
  const f = agentFixture(),
    old = f.grant(),
    run = f.run()
  try {
    const before = await run.call('debug_status', { debug_session_id: f.id })
    const nextState = f.core.debugger.replaceTarget(f.id, before.snapshot.target)
    const next = f.grant({ incarnation: nextState.incarnation })
    f.grant({
      incarnation: nextState.incarnation,
      expires_at: new Date(Date.now() - 1).toISOString(),
    })
    expect(await run.call('debug_status', { debug_session_id: f.id })).toMatchObject({
      snapshot: { incarnation: nextState.incarnation },
    })
    expect(f.control.permissions.grant(next.grant_id).revoked).toBe(false)
    expect(f.control.permissions.grant(old.grant_id).revoked).toBe(false)
  } finally {
    run.close()
    f.close()
  }
})
