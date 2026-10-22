import { expect, it } from 'vitest'
import { legacyOwnerStop } from '../packages/channel-server/src/owner-stop-wire.js'

it('projects new fields for strict legacy readers while preserving owner-stop events and opaque tool data', () => {
  const session = { session_id: 'child', provider: 'fake', stop_generation: 2, owner_stopped: true }
  const intent = {
    type: 'session.owner_stop',
    data: {
      session_id: 'child',
      stop_generation: 2,
      owner_stopped: true,
      reason: 'stopped_by_owner',
    },
  }
  const terminal = {
    session_id: 'child',
    delegation_id: 'delegation',
    state: 'stopped',
    reason: 'stopped_by_owner',
    stop_generation: 2,
    owner_stopped: true,
  }
  expect(legacyOwnerStop({ result: [session, intent, terminal], input: session })).toEqual({
    result: [
      { session_id: 'child', provider: 'fake' },
      intent,
      { session_id: 'child', delegation_id: 'delegation', state: 'stopped' },
    ],
    input: session,
  })
})
it('returns a clear error to legacy send readers instead of an unfamiliar admission union', () => {
  const result = {
    code: 'owner_restart_required',
    session_id: 'child',
    reason: 'stopped_by_owner',
    stop_generation: 2,
  }
  expect(legacyOwnerStop({ kind: 'response', request_id: 'request', result })).toEqual({
    kind: 'response',
    request_id: 'request',
    error: {
      code: 'owner_restart_required',
      message: 'Stopped by the owner; an explicit owner restart is required.',
      details: result,
    },
  })
})
