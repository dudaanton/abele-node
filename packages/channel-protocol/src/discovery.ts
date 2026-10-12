import { z } from 'zod'

/** Additive release discovery. Optional on readers for nodes predating this contract.
 * This is the node release, NOT the negotiated wire or provider version.
 */
export const NodeDiscoveryFields = {
  node_version: z.string().min(1).max(128).optional(),
  supported_capabilities: z.array(z.string().min(1).max(128)).max(256).optional(),
}
