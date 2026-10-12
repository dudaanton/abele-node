import { z } from 'zod'

// Frozen from release 0.4.2 (43f38bd). Do not import current protocol validators:
// these fixtures must keep the strict wire contract shipped in existing clients.
const Id = z.string().min(1).max(128)
const Sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
const Version = z.object({ major: z.literal(0), minor: z.literal(0) }).strict()
const ErrorSchema = z
  .object({ code: Id, message: z.string().max(2048), details: z.record(z.unknown()).default({}) })
  .strict()
export const Welcome042Schema = z
  .object({
    kind: z.literal('welcome'),
    version: Version,
    node_id: Id,
    installation_id: Id,
    instance_id: Id,
    methods: z.array(Id),
    limits: z
      .object({
        record_bytes: Sequence,
        page_events: Sequence,
        page_bytes: Sequence,
        unacked_bytes: Sequence,
        chunk_bytes: Sequence,
        heartbeat_ms: Sequence,
        dead_ms: Sequence,
        auth_ms: Sequence,
        auth_bytes: Sequence,
        connections: Sequence,
      })
      .strict(),
    capabilities: z.record(z.unknown()),
  })
  .strict()
export const Claim042Schema = z
  .object({
    installation_id: Id,
    device_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    state: z.enum(['pending', 'confirmed']),
  })
  .strict()
export const Claimed042Schema = z
  .object({ kind: z.literal('paired.claimed'), claim: Claim042Schema })
  .strict()
export const Response042Schema = z
  .object({
    kind: z.literal('response'),
    request_id: Id,
    operation_id: Id.optional(),
    result: z.unknown().optional(),
    error: ErrorSchema.optional(),
  })
  .strict()
  .refine(
    (r) => Object.hasOwn(r, 'result') !== Object.hasOwn(r, 'error'),
    'Exactly one result or error'
  )
