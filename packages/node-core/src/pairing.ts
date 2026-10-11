import {
  ChannelError,
  InviteSchema,
  PublicKeySchema,
  DeviceNameSchema,
  assertPairedEndpoint,
  fingerprint,
  randomNonce,
  publicCoordinates,
  type PairingInvite,
  type PublicKey,
} from '@abele/channel-protocol'
import type { NodeCore } from './index.js'

/** Node identity private bytes live only in the protected node database. */
export class IdentityStore {
  private loading?: ReturnType<IdentityStore['loadOrCreate']>
  constructor(private core: NodeCore) {}
  load() {
    return (this.loading ??= this.loadOrCreate())
  }
  private async loadOrCreate() {
    let stored = this.core.db
      .prepare("SELECT value FROM meta WHERE key='paired_identity'")
      .get() as { value: string } | undefined
    if (!stored) {
      const keys = await globalThis.crypto.subtle.generateKey(
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['sign', 'verify']
      )
      const privateJwk = await globalThis.crypto.subtle.exportKey('jwk', keys.privateKey)
      this.core.transaction(() =>
        this.core.db
          .prepare("INSERT OR IGNORE INTO meta VALUES('paired_identity',?)")
          .run(JSON.stringify(privateJwk))
      )
      stored = this.core.db.prepare("SELECT value FROM meta WHERE key='paired_identity'").get() as {
        value: string
      }
    }
    const jwk = JSON.parse(stored.value) as Parameters<
      typeof globalThis.crypto.subtle.importKey
    >[1] & { kty: string; crv: string; x: string; y: string }
    const private_key = await globalThis.crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    )
    return { private_key, public_key: publicCoordinates(jwk) }
  }
  rotate() {
    this.core.transaction(() => {
      this.core.db.prepare("DELETE FROM meta WHERE key='paired_identity'").run()
      this.core.db.prepare("UPDATE paired_devices SET state='revoked'").run()
      this.core.authority.invalidatePairedGrants()
      this.core.db.prepare('DELETE FROM pairing_invites').run()
    })
    this.loading = undefined
    return this.load()
  }
}
export class PairingService {
  readonly identity: IdentityStore
  constructor(private core: NodeCore) {
    // Independent additive schema to avoid collisions with provider migrations.
    core.db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS paired_devices(installation_id TEXT PRIMARY KEY REFERENCES installations(installation_id), public_key TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','confirmed','revoked')));
      CREATE TABLE IF NOT EXISTS pairing_invites(invite_id TEXT PRIMARY KEY, body TEXT NOT NULL, secret_hash TEXT NOT NULL, label TEXT NOT NULL, installation_id TEXT, claim_key TEXT, recovery_until INTEGER);
      CREATE TABLE IF NOT EXISTS paired_device_metadata(installation_id TEXT PRIMARY KEY REFERENCES paired_devices(installation_id), device_name TEXT NOT NULL, created_at INTEGER NOT NULL);
      COMMIT;`)
    this.identity = new IdentityStore(core)
  }
  async issue(
    endpoint: string,
    label: string,
    ttl_ms = 300000,
    installation_id?: string
  ): Promise<PairingInvite> {
    assertPairedEndpoint(endpoint)
    if (
      !label ||
      label.length > 128 ||
      !Number.isSafeInteger(ttl_ms) ||
      ttl_ms < 1 ||
      ttl_ms > 3600000
    )
      throw new ChannelError('invalid_invite')
    const key = await this.identity.load()
    const invite = InviteSchema.parse({
      endpoint,
      node_id: this.core.node_id,
      node_fingerprint: await fingerprint(key.public_key),
      invite_id: globalThis.crypto.randomUUID(),
      secret: randomNonce(),
      expires_at: Date.now() + ttl_ms,
    })
    const secret_hash = await hashSecret(invite.secret)
    this.core.transaction(() => {
      if (installation_id) {
        this.core.authority.check({ installation_id }, 'pair')
        if (
          this.core.db
            .prepare("SELECT 1 FROM paired_devices WHERE installation_id=? AND state!='revoked'")
            .get(installation_id)
        )
          throw new ChannelError('already_paired')
      }
      this.core.db
        .prepare(
          'INSERT INTO pairing_invites(invite_id,body,secret_hash,label,installation_id) VALUES(?,?,?,?,?)'
        )
        .run(
          invite.invite_id,
          JSON.stringify({ ...invite, secret: undefined }),
          secret_hash,
          label,
          installation_id ?? null
        )
    })
    return invite
  }
  /** Called only after a fresh challenge verified possession of the submitted key. */
  async claim(
    raw: PairingInvite,
    rawKey: PublicKey,
    checkProof: () => void = () => {},
    deviceName?: string
  ) {
    const invite = InviteSchema.parse(raw),
      key = PublicKeySchema.parse(rawKey)
    if (deviceName !== undefined) DeviceNameSchema.parse(deviceName)
    const fp = await fingerprint(key),
      secretHash = await hashSecret(invite.secret)
    return this.core.transaction(() => {
      checkProof()
      const row = this.core.db
        .prepare('SELECT * FROM pairing_invites WHERE invite_id=?')
        .get(invite.invite_id) as
        | {
            body: string
            secret_hash: string
            installation_id: string | null
            claim_key: string | null
            recovery_until: number | null
            label: string
          }
        | undefined
      if (
        !row ||
        row.secret_hash !== secretHash ||
        row.body !== JSON.stringify({ ...invite, secret: undefined })
      )
        throw new ChannelError('invalid_invite')
      if (row.claim_key) {
        if (row.claim_key !== fp) throw new ChannelError('invite_consumed')
        if (!row.recovery_until || Date.now() > row.recovery_until)
          throw new ChannelError('invite_expired')
        const result = this.claimResult(row.installation_id!)
        if (result.device_fingerprint !== fp) throw new ChannelError('invite_consumed')
        return result
      }
      if (Date.now() >= invite.expires_at) throw new ChannelError('invite_expired')
      const id = row.installation_id ?? globalThis.crypto.randomUUID()
      if (row.installation_id) this.core.authority.check({ installation_id: id }, 'pair')
      else
        this.core.db
          .prepare('INSERT INTO installations(installation_id,label,token_hash) VALUES(?,?,?)')
          .run(id, deviceName ?? row.label, 'paired:' + randomNonce())
      if (
        this.core.db
          .prepare("SELECT 1 FROM paired_devices WHERE installation_id=? AND state!='revoked'")
          .get(id)
      )
        throw new ChannelError('already_paired')
      this.core.db
        .prepare(
          "INSERT INTO paired_devices(installation_id,public_key,fingerprint,state) VALUES(?,?,?,'pending') ON CONFLICT(installation_id) DO UPDATE SET public_key=excluded.public_key,fingerprint=excluded.fingerprint,state='pending'"
        )
        .run(id, JSON.stringify(key), fp)
      this.core.db
        .prepare(
          'INSERT INTO paired_device_metadata VALUES(?,?,?) ON CONFLICT(installation_id) DO UPDATE SET device_name=excluded.device_name,created_at=excluded.created_at'
        )
        .run(id, deviceName ?? row.label, Date.now())
      this.core.db
        .prepare(
          'UPDATE pairing_invites SET installation_id=?,claim_key=?,recovery_until=? WHERE invite_id=? AND claim_key IS NULL'
        )
        .run(id, fp, Date.now() + 86400000, invite.invite_id)
      return this.claimResult(id)
    })
  }
  private claimResult(id: string) {
    const device = this.core.db
      .prepare('SELECT fingerprint,state FROM paired_devices WHERE installation_id=?')
      .get(id) as { fingerprint: string; state: 'pending' | 'confirmed' } | undefined
    if (!device || !['pending', 'confirmed'].includes(device.state))
      throw new ChannelError('unauthorized')
    this.core.authority.check({ installation_id: id }, 'pair')
    return { installation_id: id, device_fingerprint: device.fingerprint, state: device.state }
  }
  confirm(id: string, expectedFingerprint: string, requirePending = false) {
    return this.core.transaction(() => {
      const result = this.claimResult(id)
      if (requirePending && result.state !== 'pending') throw new ChannelError('not_pending')
      if (result.device_fingerprint !== expectedFingerprint) throw new ChannelError('key_mismatch')
      this.core.db
        .prepare("UPDATE paired_devices SET state='confirmed' WHERE installation_id=?")
        .run(id)
      return { ...result, state: 'confirmed' as const }
    })
  }
  /** Approval captures an exact principal/key and refuses stale list selections. */
  approve(id: string, expectedFingerprint: string) {
    return this.confirm(id, expectedFingerprint, true)
  }
  list() {
    return this.core.db
      .prepare(
        "SELECT d.installation_id,d.fingerprint,d.state,COALESCE(m.device_name,i.label,'') AS device_name,COALESCE(m.created_at,0) AS created_at FROM paired_devices d LEFT JOIN paired_device_metadata m USING(installation_id) LEFT JOIN installations i USING(installation_id)"
      )
      .all() as Array<{
      installation_id: string
      fingerprint: string
      state: 'pending' | 'confirmed' | 'revoked'
      device_name: string
      created_at: number
    }>
  }
  actor(id: string, key: PublicKey) {
    const actor = {
      installation_id: id,
      profile: 'paired-wss-v1' as const,
      device_key: JSON.stringify(PublicKeySchema.parse(key)),
    }
    this.core.authority.check(actor, 'admit')
    return actor
  }
  revoke(id: string) {
    this.core.transaction(() => {
      this.core.db
        .prepare("UPDATE paired_devices SET state='revoked' WHERE installation_id=?")
        .run(id)
      this.core.authority.invalidatePairedGrants(id)
    })
  }
}
async function hashSecret(secret: string) {
  const bytes = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  )
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
