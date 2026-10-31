import { z } from 'zod'
import { PublicKeySchema, fingerprint } from './paired.js'

// This is a new admission protocol, not a fallback to auth-first local-token-v1.
export const LOCAL_PROOF_PROFILE = 'local-proof-v1' as const
const Hex = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .max(64)
export const LocalBeginSchema = z
  .object({
    kind: z.literal('local.begin'),
    profile: z.literal(LOCAL_PROOF_PROFILE),
    client_nonce: Hex,
    selector: Hex,
  })
  .strict()
export const LocalChallengeSchema = z
  .object({
    kind: z.literal('local.challenge'),
    profile: z.literal(LOCAL_PROOF_PROFILE),
    client_nonce: Hex,
    selector: Hex,
    connection_id: Hex,
    node_id: z.string().min(1).max(128),
    installation_id: z.string().min(1).max(128),
    expires_at: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    node_key: PublicKeySchema,
    signature: z
      .string()
      .regex(/^[A-Za-z0-9_-]{86}$/)
      .max(86),
    mac: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .max(64),
  })
  .strict()
export type LocalChallenge = z.infer<typeof LocalChallengeSchema>
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value))
const hex = (bytes: ArrayBuffer) =>
  Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('')
export async function localTokenHash(token: string): Promise<string> {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('unauthorized')
  return hex(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))
}
export async function localSelector(tokenHash: string): Promise<string> {
  Hex.parse(tokenHash)
  return hex(
    await globalThis.crypto.subtle.digest('SHA-256', encode(['abele-local-selector-v1', tokenHash]))
  )
}
export async function localTranscript(c: LocalChallenge): Promise<string[]> {
  return [
    'abele-local-proof-v1',
    'node-protocol:0.0',
    'node',
    'connect',
    c.profile,
    c.selector,
    c.client_nonce,
    c.connection_id,
    c.node_id,
    c.installation_id,
    String(c.expires_at),
    await fingerprint(c.node_key),
  ]
}
async function macKey(tokenHash: string) {
  Hex.parse(tokenHash)
  const material = await globalThis.crypto.subtle.digest(
    'SHA-256',
    encode(['abele-local-bootstrap-key-v1', tokenHash])
  )
  return globalThis.crypto.subtle.importKey(
    'raw',
    material,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  )
}
async function macTranscript(c: LocalChallenge) {
  return encode(['abele-local-bootstrap-mac-v1', ...(await localTranscript(c)), c.signature])
}
export async function localBootstrapMac(tokenHash: string, c: LocalChallenge): Promise<string> {
  return hex(
    await globalThis.crypto.subtle.sign('HMAC', await macKey(tokenHash), await macTranscript(c))
  )
}
export async function verifyLocalBootstrap(tokenHash: string, c: LocalChallenge): Promise<boolean> {
  // WebCrypto verification avoids a JavaScript early-exit comparison of a secret proof.
  const bytes = Uint8Array.from(c.mac.match(/../g) ?? [], (b) => parseInt(b, 16))
  return globalThis.crypto.subtle.verify(
    'HMAC',
    await macKey(tokenHash),
    bytes,
    await macTranscript(c)
  )
}
