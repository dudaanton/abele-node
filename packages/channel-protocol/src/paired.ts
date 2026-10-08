import { z } from 'zod'

// Fixed P-256 public coordinates, not an arbitrary JWK/algorithm supplied by a peer.
const Coordinate = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const PublicKeySchema = z
  .object({ kty: z.literal('EC'), crv: z.literal('P-256'), x: Coordinate, y: Coordinate })
  .strict()
export type PublicKey = z.infer<typeof PublicKeySchema>
export interface DeviceIdentity {
  public_key: PublicKey
  private_key: CryptoKey
}
export const FingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/)
const Nonce = z.string().regex(/^[a-f0-9]{64}$/)
const Id = z.string().min(1).max(128)
export const InviteSchema = z
  .object({
    endpoint: z.string().max(2048),
    node_id: Id,
    node_fingerprint: FingerprintSchema,
    invite_id: Id,
    secret: Nonce,
    expires_at: z.number().int().positive(),
  })
  .strict()
export type PairingInvite = z.infer<typeof InviteSchema>
export const ClaimSchema = z
  .object({
    installation_id: Id,
    device_fingerprint: FingerprintSchema,
    state: z.enum(['pending', 'confirmed']),
  })
  .strict()
export const PairedBeginSchema = z
  .object({
    kind: z.literal('paired.begin'),
    profile: z.literal('paired-wss-v1'),
    client_nonce: Nonce,
    public_key: PublicKeySchema,
    installation_id: Id.optional(),
    invite: InviteSchema.optional(),
  })
  .strict()
  .refine((r) => !!r.installation_id !== !!r.invite)
export const ChallengeSchema = z
  .object({
    kind: z.literal('paired.challenge'),
    profile: z.literal('paired-wss-v1'),
    connection_id: Nonce,
    client_nonce: Nonce,
    node_id: Id,
    endpoint: z.string().max(2048),
    installation_id: Id,
    device_fingerprint: FingerprintSchema,
    purpose: z.enum(['connect', 'claim']),
    expires_at: z.number().int().positive(),
    node_key: PublicKeySchema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict()
export type DeviceChallenge = z.infer<typeof ChallengeSchema>
export const PairedRecordSchemas = [
  PairedBeginSchema,
  ChallengeSchema,
  z
    .object({ kind: z.literal('paired.proof'), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/) })
    .strict(),
  z.object({ kind: z.literal('paired.claimed'), claim: ClaimSchema }).strict(),
] as const
export function proofTranscript(c: DeviceChallenge, role: 'node' | 'device'): string[] {
  return [
    'abele-paired-wss-v1',
    'node-protocol:0.0',
    role,
    c.purpose,
    c.connection_id,
    c.client_nonce,
    c.node_id,
    c.endpoint,
    c.installation_id,
    c.device_fingerprint,
    String(c.expires_at),
  ]
}
export function randomNonce(): string {
  return Array.from(globalThis.crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')
}
export async function generateIdentity(): Promise<DeviceIdentity> {
  const pair = await globalThis.crypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign', 'verify']
  )
  return {
    private_key: pair.privateKey,
    public_key: PublicKeySchema.parse(
      publicCoordinates(await globalThis.crypto.subtle.exportKey('jwk', pair.publicKey))
    ),
  }
}
export function publicCoordinates(key: JsonWebKey): PublicKey {
  return PublicKeySchema.parse({ kty: key.kty, crv: key.crv, x: key.x, y: key.y })
}
export async function fingerprint(key: PublicKey): Promise<string> {
  const k = PublicKeySchema.parse(key)
  // Fixed serialization; no property-order or JWK metadata ambiguity.
  const bytes = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(['EC', 'P-256', k.x, k.y]))
  )
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
}
export async function signProof(key: CryptoKey, transcript: string[]): Promise<string> {
  const bytes = new Uint8Array(
    await globalThis.crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      new TextEncoder().encode(JSON.stringify(transcript))
    )
  )
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}
export async function verifyProof(
  key: PublicKey,
  transcript: string[],
  signature: string
): Promise<boolean> {
  try {
    if (!/^[A-Za-z0-9_-]{86}$/.test(signature)) return false
    const imported = await globalThis.crypto.subtle.importKey(
      'jwk',
      PublicKeySchema.parse(key),
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    )
    const bytes = Uint8Array.from(
      atob(signature.replaceAll('-', '+').replaceAll('_', '/') + '=='),
      (c) => c.charCodeAt(0)
    )
    return await globalThis.crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      imported,
      bytes,
      new TextEncoder().encode(JSON.stringify(transcript))
    )
  } catch {
    return false
  }
}
export function assertPairedEndpoint(endpoint: string): void {
  const u = new URL(endpoint)
  if (
    u.protocol !== 'wss:' ||
    !u.hostname.endsWith('.ts.net') ||
    u.username ||
    u.password ||
    u.search ||
    u.hash ||
    u.pathname !== '/channel' ||
    u.href !== endpoint ||
    u.href !== u.origin + '/channel'
  )
    throw new Error('endpoint_refused')
}
