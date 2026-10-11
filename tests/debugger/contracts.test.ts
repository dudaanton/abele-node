import { describe, expect, it } from 'vitest'
import {
  DebuggerMethodSchemas,
  DebuggerSnapshotSchema,
  DebuggerReceiptSchema,
  DebuggerModeSchema,
  DebuggerPolicySchema,
  DebuggerControlMethodSchemas,
  validateParams,
} from '@abele/node-protocol'
import { withCore, target } from './helpers.js'

describe('debugger.v1 contracts and compatibility', () => {
  it('does not advertise or route debugger methods by default', () =>
    withCore((core) => {
      expect(core.capabilities().capabilities).not.toHaveProperty('debugger_v1')
      const token = core.createToken('fixture')
      expect(() =>
        core.request(core.authority.authenticate(token.token), 'debugger.v1.profiles', {})
      ).toThrow('unsupported_method')
      expect(validateParams('session.list', {})).toEqual({ limit: 256 })
    }))
  it('advertises only the enabled infrastructure, never a real profile', () =>
    withCore((core) => {
      expect(core.capabilities().capabilities.debugger_v1?.status).toBe('supported')
      expect(core.debugger.profiles()).toEqual([])
      expect(core.debugger.enabled).toBe(true)
    }, true))
  it('uses separate debugger identities and strict versioned snapshots', () =>
    withCore((core) => {
      const state = core.debugger.create(target)
      expect(DebuggerSnapshotSchema.parse(state).version).toBe('debugger.v1')
      expect(state.debug_session_id).not.toBe(target.conversation_id)
      expect(DebuggerSnapshotSchema.safeParse({ ...state, version: 'debugger.v2' }).success).toBe(
        false
      )
      expect(DebuggerSnapshotSchema.safeParse({ ...state, controller: 'agent' }).success).toBe(
        false
      )
    }, true))
  it('requires incarnation/revision/operation ID and forbids raw DAP requests', () => {
    const command = {
      debug_session_id: 's',
      incarnation: 'i',
      expected_state_revision: 4,
      operation_id: 'op',
      thread_id: 1,
      kind: 'over',
    }
    expect(DebuggerMethodSchemas['debugger.v1.step'].safeParse(command).success).toBe(true)
    for (const key of ['operation_id', 'incarnation', 'expected_state_revision']) {
      const missing: Record<string, unknown> = { ...command }
      delete missing[key]
      expect(DebuggerMethodSchemas['debugger.v1.step'].safeParse(missing).success).toBe(false)
    }
    expect(
      DebuggerMethodSchemas['debugger.v1.step'].safeParse({ ...command, command: 'customRequest' })
        .success
    ).toBe(false)
    expect(
      DebuggerMethodSchemas['debugger.v1.variables'].safeParse({
        debug_session_id: 's',
        handle: 'h',
        start: 0,
        count: 100001,
      }).success
    ).toBe(false)
    expect(
      DebuggerMethodSchemas['debugger.v1.evaluate'].safeParse({ ...command, expression: 'x' })
        .success
    ).toBe(false)
  })
  it('declares exactly two modes and no action-class auto-approval input', () => {
    expect(DebuggerModeSchema.options).toEqual(['ask', 'allow-all'])
    expect(DebuggerPolicySchema.parse({}).mode).toBe('ask')
    for (const mode of ['ask', 'allow-all']) {
      expect(DebuggerPolicySchema.safeParse({ mode }).success).toBe(true)
      expect(
        DebuggerControlMethodSchemas['debugger.v1.grant.setMode'].safeParse({ grant_id: 'g', mode })
          .success
      ).toBe(true)
      expect(DebuggerPolicySchema.safeParse({ mode, auto_actions: [] }).success).toBe(false)
    }
    expect(DebuggerPolicySchema.safeParse({ mode: 'auto' }).success).toBe(false)
    expect(
      DebuggerControlMethodSchemas['debugger.v1.grant.setMode'].safeParse({
        grant_id: 'g',
        mode: 'auto',
      }).success
    ).toBe(false)
  })
  it('stamps rejected and unknown receipts with completion state', () =>
    withCore((core) => {
      const snapshot = core.debugger.create(target)
      const receipt = {
        operation_id: 'op',
        acceptance: 'accepted',
        dispatch: 'possible',
        outcome: 'outcome_unknown',
        snapshot,
        completed_at: new Date().toISOString(),
      }
      expect(DebuggerReceiptSchema.safeParse(receipt).success).toBe(true)
      const { snapshot: _, ...unstamped } = receipt
      expect(DebuggerReceiptSchema.safeParse(unstamped).success).toBe(false)
    }, true))
})
