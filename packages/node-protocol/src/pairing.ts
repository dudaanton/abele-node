import { z } from 'zod'
import { FingerprintSchema, Id } from '@abele/channel-protocol'
export {
  InviteSchema,
  ClaimSchema,
  PublicKeySchema,
  type PairingInvite,
  type PublicKey,
} from '@abele/channel-protocol'
/** Owner control methods are admitted only on a locally token-authenticated channel. */
export const PairingMethodSchemas = {
  'pairing.list': z.object({}).strict(),
  'pairing.confirm': z
    .object({ installation_id: Id, device_fingerprint: FingerprintSchema })
    .strict(),
}
