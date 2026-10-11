import { expect, it } from 'vitest'
import { decodePairCode, encodePairCode } from '../packages/node-protocol/src/pairing-code.js'

const payload = {
  version: 1 as const,
  node_name: 'Test node',
  invite: {
    endpoint: 'wss://node.example.ts.net:8443/channel',
    node_id: 'node-id',
    node_fingerprint: 'a'.repeat(64),
    invite_id: 'invite-id',
    secret: 'b'.repeat(64),
    expires_at: 1,
  },
}
it('round trips UTF-8 in one canonical browser-compatible line and trims only outer whitespace', () => {
  const value = { ...payload, node_name: 'Нода' }
  const code = encodePairCode(value)
  expect(code).toMatch(/^abele1:[A-Za-z0-9_-]+$/)
  expect(decodePairCode(` \n${code}\n `)).toEqual(value)
  // Expiry is enforced at claim, not decode: consumed invites can recover for 24 hours.
  expect(decodePairCode(code).invite.expires_at).toBe(1)
})
it('refuses malformed, noncanonical, oversized, unknown and unsafe endpoint payloads locally', () => {
  const code = encodePairCode(payload)
  for (const bad of ['', 'abele2:abc', code + '=', code + '\nabc', 'abele1:' + 'x'.repeat(8192)])
    expect(() => decodePairCode(bad)).toThrow()
  expect(() => encodePairCode({ ...payload, extra: true } as typeof payload)).toThrow()
  expect(() =>
    encodePairCode({
      ...payload,
      invite: { ...payload.invite, endpoint: 'ws://127.0.0.1/channel' },
    })
  ).toThrow()
})
