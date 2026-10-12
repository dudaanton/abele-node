import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
import { PairingService } from '../packages/node-core/src/pairing.js'
import { Claim042Schema } from './fixtures/channel-0.4.2.js'
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
  const description = core.request(
    core.authority.authenticate(core.createToken('discovery').token),
    'node.describe',
    {}
  ) as any
  // Claim has no extensible field in 0.4.2. Keep discovery on describe/welcome.
  expect(Claim042Schema.parse(claim)).toEqual(claim)
  expect(description.node_version).toBe(core.discovery().node_version)
  expect(description.supported_capabilities).toEqual(
    expect.arrayContaining(['expected_target', 'session.rename', 'session.delete'])
  )
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
it('persists a proven enrolling device name and age; retries cannot rename it', async () => {
  const { pairing } = setup()
  const invite = await pairing.issue('wss://node.example.ts.net:8443/channel', 'invitation label')
  const device = await generateIdentity()
  const before = Date.now()
  const claim = await pairing.claim(invite, device.public_key, () => {}, 'Test device')
  expect(pairing.list()).toContainEqual({
    installation_id: claim.installation_id,
    fingerprint: claim.device_fingerprint,
    state: 'pending',
    device_name: 'Test device',
    created_at: expect.any(Number),
  })
  expect(pairing.list()[0]!.created_at).toBeGreaterThanOrEqual(before)
  await pairing.claim(invite, device.public_key, () => {}, 'Spoofed rename')
  expect(pairing.list()[0]!.device_name).toBe('Test device')
  expect(() => pairing.approve(claim.installation_id, '0'.repeat(64))).toThrow('key_mismatch')
  pairing.approve(claim.installation_id, claim.device_fingerprint)
  expect(() => pairing.approve(claim.installation_id, claim.device_fingerprint)).toThrow(
    'not_pending'
  )
})
it('rejects unsafe names and never stores a name before proof succeeds', async () => {
  const { pairing } = setup()
  const invite = await pairing.issue('wss://node.example.ts.net:8443/channel', 'label')
  const device = await generateIdentity()
  await expect(
    pairing.claim(
      invite,
      device.public_key,
      () => {
        throw new Error('proof_failed')
      },
      'Test device'
    )
  ).rejects.toThrow('proof_failed')
  expect(pairing.list()).toEqual([])
  for (const name of ['bad\u001b[0m', 'bad\nname', '', 'x'.repeat(129)])
    await expect(pairing.claim(invite, device.public_key, () => {}, name)).rejects.toThrow()
})
it('keeps the legacy paired-device table layout compatible with existing inserts', () => {
  const { core, pairing } = setup()
  const installation = core.createToken('Legacy device')
  core.db
    .prepare("INSERT INTO paired_devices VALUES(?,?,?,'confirmed')")
    .run(installation.installation_id, 'fixture-key', 'a'.repeat(64))
  expect(pairing.list()).toContainEqual({
    installation_id: installation.installation_id,
    fingerprint: 'a'.repeat(64),
    state: 'confirmed',
    device_name: 'Legacy device',
    created_at: 0,
  })
})
it('additive migration keeps pending legacy devices selectable by their existing installation label', async () => {
  const { core, pairing } = setup()
  const invite = await pairing.issue('wss://node.example.ts.net:8443/channel', 'Legacy device')
  const device = await generateIdentity()
  const claim = await pairing.claim(invite, device.public_key)
  core.db.exec('DROP TABLE paired_device_metadata')
  const migrated = new PairingService(core)
  expect(migrated.list()).toContainEqual({
    installation_id: claim.installation_id,
    fingerprint: claim.device_fingerprint,
    state: 'pending',
    device_name: 'Legacy device',
    created_at: 0,
  })
  expect(migrated.approve(claim.installation_id, claim.device_fingerprint).state).toBe('confirmed')
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
