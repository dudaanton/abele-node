import { z } from 'zod'
import { InviteSchema, assertPairedEndpoint } from '@abele/channel-protocol'

export const PairCodePayloadSchema = z
  .object({
    version: z.literal(1),
    node_name: z
      .string()
      .min(1)
      .max(128)
      .refine((s) => !/[\p{Cc}\p{Cf}]/u.test(s)),
    invite: InviteSchema,
  })
  .strict()
export type PairCodePayload = z.infer<typeof PairCodePayloadSchema>
// Protocol builds intentionally omit DOM types; these standard browser/Node globals
// are the only runtime requirements (no Buffer, filesystem or Node imports).
const { btoa, atob, TextEncoder, TextDecoder } = globalThis as unknown as {
  btoa(text: string): string
  atob(text: string): string
  TextEncoder: new () => { encode(text: string): Uint8Array }
  TextDecoder: new (
    encoding: string,
    options: { fatal: boolean }
  ) => { decode(bytes: Uint8Array): string }
}
const prefix = 'abele1:'
const maxLength = 8192
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}
export function encodePairCode(raw: PairCodePayload): string {
  const payload = PairCodePayloadSchema.parse(raw)
  assertPairedEndpoint(payload.invite.endpoint)
  const code = prefix + base64url(new TextEncoder().encode(JSON.stringify(payload)))
  if (code.length > maxLength) throw new Error('pair_code_too_large')
  return code
}
/** Local validation only. Expiry belongs to the node: consumed invites have key-bound recovery. */
export function decodePairCode(text: string): PairCodePayload {
  const code = text.trim()
  if (code.length > maxLength || !code.startsWith(prefix)) throw new Error('invalid_pair_code')
  const encoded = code.slice(prefix.length)
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error('invalid_pair_code')
  const bytes = Uint8Array.from(
    atob(
      encoded.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (encoded.length % 4)) % 4)
    ),
    (c) => c.charCodeAt(0)
  )
  if (base64url(bytes) !== encoded) throw new Error('invalid_pair_code')
  const payload = PairCodePayloadSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
  )
  assertPairedEndpoint(payload.invite.endpoint)
  return payload
}
export function shortPairingFingerprint(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid_fingerprint')
  return value.slice(0, 4) + ' ' + value.slice(4, 8)
}
