import { expect, it } from 'vitest'
import { agentFixture } from './review-fixture.js'

it.each(['history', 'receipt'] as const)(
  'retains outcome_unknown and the operation ID after dispatched effect / %s failure',
  async (failure) => {
    const f = agentFixture(),
      g = f.grant(),
      binding = f.binding(g)
    let sends = 0
    f.control.registerBackend(f.id, {
      supports: () => true,
      dispatch: async (_m, _p, guard) => {
        guard()
        sends++
        return {}
      },
    })
    f.core.db.exec(
      failure === 'receipt'
        ? `CREATE TRIGGER fail_debug_receipt BEFORE UPDATE ON debug_operations WHEN json_extract(NEW.body,'$.receipt.outcome')='completed' BEGIN SELECT RAISE(ABORT,'receipt_failed'); END`
        : `CREATE TRIGGER fail_debug_history BEFORE INSERT ON debug_history WHEN json_extract(NEW.body,'$.outcome')='completed' BEGIN SELECT RAISE(ABORT,'history_failed'); END`
    )
    try {
      const result = await binding.call('debug_step', f.args())
      expect(sends).toBe(1)
      expect(result).toMatchObject({
        outcome: 'outcome_unknown',
        dispatch: 'possible',
        operation_id: expect.any(String),
      })
      expect(result.operation_id.length).toBeGreaterThan(0)
      const receipt = await binding.call('debug_command_result', {
        debug_session_id: f.id,
        operation_id: result.operation_id,
      })
      expect(receipt.dispatch).toBe('possible')
      expect(sends).toBe(1)
    } finally {
      // Cleanup is independent of the deliberately failed audit fence.
      try {
        binding.close()
      } catch {}
      f.close()
    }
  }
)

it('a lost commit acknowledgement for the possible-dispatch marker stays reconcilable', async () => {
  const f = agentFixture(),
    g = f.grant(),
    binding = f.binding(g)
  let sends = 0
  f.control.registerBackend(f.id, {
    supports: () => true,
    dispatch: async (_m, _p, guard) => {
      guard()
      sends++
      return {}
    },
  })
  f.core.fault = (point) => {
    if (
      point === 'after_commit' &&
      f.core.db
        .prepare(
          "SELECT 1 FROM debug_operations WHERE json_extract(body,'$.receipt.dispatch')='possible'"
        )
        .get()
    ) {
      f.core.fault = undefined
      throw Error('marker_commit_reply_lost')
    }
  }
  try {
    const result = await binding.call('debug_step', f.args())
    expect(result).toMatchObject({
      outcome: 'outcome_unknown',
      dispatch: 'possible',
      operation_id: expect.any(String),
    })
    expect(sends).toBe(0)
    expect(f.control.commandEvidence(f.principal(g), f.id, result.operation_id)?.dispatch).toBe(
      'possible'
    )
  } finally {
    f.core.fault = undefined
    try {
      binding.close()
    } catch {}
    f.close()
  }
})

it('an intent-storage admission failure is rejected with its own reconciliation ID and no dispatch', async () => {
  const f = agentFixture(),
    g = f.grant(),
    binding = f.binding(g)
  let sends = 0
  f.control.registerBackend(f.id, {
    supports: () => true,
    dispatch: async (_m, _p, guard) => {
      guard()
      sends++
      return {}
    },
  })
  f.core.db.exec(
    `CREATE TRIGGER fail_debug_intent BEFORE INSERT ON debug_operations BEGIN SELECT RAISE(ABORT,'intent_failed'); END`
  )
  try {
    const result = await binding.call('debug_step', f.args())
    expect(result).toMatchObject({
      outcome: 'rejected',
      dispatch: 'not_dispatched',
      operation_id: expect.any(String),
    })
    expect(sends).toBe(0)
    expect(f.core.db.prepare('SELECT count(*) AS n FROM debug_operations').get()?.n).toBe(0)
  } finally {
    try {
      binding.close()
    } catch {}
    f.close()
  }
})

it('publication revocation does not relabel a possibly dispatched effect as rejected or discard its ID', async () => {
  const f = agentFixture(),
    g = f.grant(),
    binding = f.binding(g)
  f.control.registerBackend(f.id, {
    supports: () => true,
    dispatch: async (_m, _p, guard) => {
      guard()
      f.control.revokeGrant(f.owner, g.grant_id)
      return { private_value: 'not-publishable' }
    },
  })
  try {
    const result = await binding.call('debug_step', f.args())
    expect(result).toMatchObject({
      outcome: 'outcome_unknown',
      operation_id: expect.any(String),
      snapshot: null,
    })
    expect(JSON.stringify(result)).not.toContain('not-publishable')
  } finally {
    binding.close()
    f.close()
  }
})
