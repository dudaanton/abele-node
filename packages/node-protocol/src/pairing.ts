import { z } from 'zod'
import { FingerprintSchema, Id } from '@abele/channel-protocol'
export {
  InviteSchema,
  ClaimSchema,
  PublicKeySchema,
  type PairingInvite,
  type PublicKey,
} from '@abele/channel-protocol'
/** Address-row diagnostics. Browsers may deliberately hide TLS/HTTP failure details. */
export const PairingRouteReasonSchema = z.enum([
  'tls',
  'host_not_accepted',
  'unreachable',
  'different_node',
  'tls_or_unreachable',
  'policy_not_accepted',
])
export type PairingRouteReason = z.infer<typeof PairingRouteReasonSchema>
export const PairingRouteFailureSchema = z
  .object({ reason: PairingRouteReasonSchema, address: z.string().max(2048) })
  .strict()
export type PairingRouteFailure = z.infer<typeof PairingRouteFailureSchema>
export const PairingListEntrySchema = z
  .object({
    installation_id: Id,
    fingerprint: FingerprintSchema,
    state: z.enum(['pending', 'confirmed', 'revoked']),
    device_name: z.string().max(128),
    created_at: z.number().int().nonnegative(),
  })
  .strict()
export type PairingListEntry = z.infer<typeof PairingListEntrySchema>
export {
  PairCodePayloadSchema,
  encodePairCode,
  decodePairCode,
  shortPairingFingerprint,
  type PairCodePayload,
} from './pairing-code.js'
/** Owner control methods are admitted only on a locally token-authenticated channel. */
export const PairingMethodSchemas = {
  'pairing.list': z.object({}).strict(),
  'pairing.confirm': z
    .object({ installation_id: Id, device_fingerprint: FingerprintSchema })
    .strict(),
}
