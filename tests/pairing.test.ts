import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
import { PairingService } from '../packages/node-core/src/pairing.js'
import {
  generateIdentity,
  fingerprint,
  signProof,
  verifyProof,
} from '../packages/channel-protocol/src/paired.js'

const dirs: string[] = []
const cores: NodeCore[] = []
afterEach(() => {
  for (const core of cores.splice(0)) core.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function setup() {
  const dir = mkdtempSync(resolve('.scratch/pairing-'))
  dirs.push(dir)
  const core = new NodeCore(dir)
  cores.push(core)
  return { core, pairing: new PairingService(core) }
}
it('single-use invite requires device possession and exact owner confirmation; recovery is key-bound', async () => {
  const { core, pairing } = setup()
  const invite = await pairing.issue('wss://node.example.ts.net:8443/channel', 'phone')
  const device = await generateIdentity()
  const claim = await pairing.claim(invite, device.public_key)
  expect(claim.state).toBe('pending')
  expect(() => pairing.actor(claim.installation_id, device.public_key)).toThrow('unauthorized')
  expect(() => pairing.confirm(claim.installation_id, '0'.repeat(64))).toThrow('key_mismatch')
  expect(await pairing.claim(invite, device.public_key)).toEqual(claim)
  await expect(pairing.claim(invite, (await generateIdentity()).public_key)).rejects.toThrow(
    'invite_consumed'
  )
  pairing.confirm(claim.installation_id, await fingerprint(device.public_key))
  const actor = pairing.actor(claim.installation_id, device.public_key)
  expect(core.request(actor, 'session.list', {})).toEqual([])
  core.revokeToken(claim.installation_id)
  expect(() => pairing.actor(claim.installation_id, device.public_key)).toThrow('unauthorized')
})
it('WebCrypto identity signatures detect transcript substitution', async () => {
  const identity = await generateIdentity()
  const signature = await signProof(identity.private_key, [
    'abele-paired-wss-v1',
    'connection',
    'node',
    'installation',
  ])
  expect(
    await verifyProof(
      identity.public_key,
      ['abele-paired-wss-v1', 'connection', 'node', 'installation'],
      signature
    )
  ).toBe(true)
  expect(
    await verifyProof(
      identity.public_key,
      ['abele-paired-wss-v1', 'other', 'node', 'installation'],
      signature
    )
  ).toBe(false)
})
