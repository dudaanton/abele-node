import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeCore } from '@abele/node-core'
import { generateIdentity, type AuthorityContext } from '@abele/channel-protocol'

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const f of cleanup.splice(0).reverse()) f()
})
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'abele-delegation-paired-'))
  let core = new NodeCore(dir)
  cleanup.push(() => {
    core.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const local = () => core.authority.authenticate(core.createToken('local').token)
  const paired = async (id?: string) => {
    const keys = await generateIdentity()
    const invite = await core.pairing.issue(
      'wss://node.example.ts.net/channel',
      'paired',
      300000,
      id
    )
    const claimed = await core.pairing.claim(invite, keys.public_key)
    core.pairing.confirm(claimed.installation_id, claimed.device_fingerprint)
    return core.pairing.actor(claimed.installation_id, keys.public_key)
  }
  const restoreSameKey = async (actor: AuthorityContext) => {
    const invite = await core.pairing.issue(
      'wss://node.example.ts.net/channel',
      'restored',
      300000,
      actor.installation_id
    )
    const claimed = await core.pairing.claim(invite, JSON.parse(actor.device_key!))
    core.pairing.confirm(claimed.installation_id, claimed.device_fingerprint)
    return core.pairing.actor(actor.installation_id, JSON.parse(actor.device_key!))
  }
  const request = (actor: AuthorityContext, method: string, p: unknown) =>
    core.request(actor, method, p, crypto.randomUUID()) as any
  const grant = (owner: AuthorityContext, controller: AuthorityContext) =>
    request(owner, 'delegation.grant.create', {
      installation_id: controller.installation_id,
      parent_id: 'parent',
      project_ids: [],
      allow_fake: true,
    })
  const create = (controller: AuthorityContext, grant_id: string, key = crypto.randomUUID()) =>
    request(controller, 'delegation.create', {
      grant_id,
      delegation_key: key,
      provider: 'fake',
      title: 'child',
      text: 'work',
      script: [{ kind: 'permission' }],
    })
  return {
    get core() {
      return core
    },
    local,
    paired,
    restoreSameKey,
    request,
    grant,
    create,
    restart() {
      core.close()
      core = new NodeCore(dir)
    },
  }
}
it('revoking a paired approving owner fences create/send/read/replay and cancels the child even after restart', async () => {
  const f = setup(),
    owner = await f.paired(),
    controller = f.local(),
    grant = f.grant(owner, controller)
  const child = await f.create(controller, grant.grant_id)
  f.core.tick()
  f.core.pairing.revoke(owner.installation_id)
  f.restart()
  await expect(f.create(controller, grant.grant_id)).rejects.toThrow(/unauthorized/)
  expect(() =>
    f.request(controller, 'delegation.send', {
      delegation_id: child.delegation_id,
      text: 'next',
      observed_seq: 0,
    })
  ).toThrow(/unauthorized/)
  expect(() =>
    f.request(controller, 'stream.read', { stream_id: child.mailbox_stream_id, after_seq: 0 })
  ).toThrow(/unauthorized/)
  expect(() => f.core.authority.check(controller, 'publish', child.mailbox_stream_id)).toThrow(
    /unauthorized/
  )
  f.core.tick()
  expect(f.core.prompts(child.session_id)[0]!.state).toBe('invalidated')
  expect(f.core.read(child.mailbox_stream_id, 0).at(-1)!.data).toHaveProperty('state', 'cancelled')
  // Re-enrollment with a new key must not revive the old owner's approval.
  await f.paired(owner.installation_id)
  await expect(f.create(controller, grant.grant_id)).rejects.toThrow(/unauthorized/)
  f.core.pairing.revoke(owner.installation_id)
  await f.restoreSameKey(owner)
  await expect(f.create(controller, grant.grant_id)).rejects.toThrow(/unauthorized/)
})
it('revoking a paired controller cancels its queued and running children without weakening human session access', async () => {
  const f = setup(),
    owner = f.local(),
    controller = await f.paired(),
    grant = f.grant(owner, controller)
  const running = await f.create(controller, grant.grant_id)
  f.core.tick()
  const queued = await f.create(controller, grant.grant_id)
  f.core.pairing.revoke(controller.installation_id)
  f.core.tick()
  expect(f.core.read(running.mailbox_stream_id, 0).at(-1)!.data).toHaveProperty(
    'state',
    'cancelled'
  )
  expect(
    (f.core.db.prepare('SELECT state FROM inputs WHERE session_id=?').get(queued.session_id) as any)
      .state
  ).toBe('cancelled')
  expect(f.core.read(queued.session_id, 0).some((e) => e.type === 'run.started')).toBe(false)
  const replacement = await f.paired(controller.installation_id)
  await expect(f.create(replacement, grant.grant_id)).rejects.toThrow(/unauthorized/)
  expect(() =>
    f.request(replacement, 'stream.read', { stream_id: running.mailbox_stream_id, after_seq: 0 })
  ).toThrow(/unauthorized/)
  expect(f.request(owner, 'session.get', { session_id: running.session_id })).toHaveProperty(
    'session_id',
    running.session_id
  )
  f.core.pairing.revoke(controller.installation_id)
  const restored = await f.restoreSameKey(controller)
  await expect(f.create(restored, grant.grant_id)).rejects.toThrow(/unauthorized/)
})
it('node identity rotation permanently invalidates paired grants even if the same device key is enrolled again', async () => {
  const f = setup(),
    owner = await f.paired(),
    controller = f.local(),
    grant = f.grant(owner, controller)
  await f.core.pairing.identity.rotate()
  await f.restoreSameKey(owner)
  await expect(f.create(controller, grant.grant_id)).rejects.toThrow(/unauthorized/)
  // Purely local approvals are independent of remote device revocation.
  const localGrant = f.grant(controller, controller)
  await f.core.pairing.identity.rotate()
  expect(await f.create(controller, localGrant.grant_id)).toHaveProperty('session_id')
})
it('fails closed for legacy grants with ambiguous paired provenance while retaining legacy local grants', async () => {
  const f = setup(),
    controller = f.local(),
    pairedOwner = await f.paired(),
    localOwner = f.local()
  const ambiguous = f.grant(pairedOwner, controller),
    retained = f.grant(localOwner, controller)
  for (const grant of [ambiguous, retained]) {
    const old = { ...grant }
    delete old.owner_authority
    delete old.controller_authority
    f.core.db
      .prepare('UPDATE delegation_grants SET body=? WHERE grant_id=?')
      .run(JSON.stringify(old), grant.grant_id)
  }
  f.restart()
  await expect(f.create(controller, ambiguous.grant_id)).rejects.toThrow(/unauthorized/)
  expect(await f.create(controller, retained.grant_id)).toHaveProperty('session_id')
})
