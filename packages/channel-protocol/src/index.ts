import { z } from 'zod'
import { PairedRecordSchemas, type PublicKey } from './paired.js'
export * from './paired.js'

export const LIMITS = Object.freeze({
  record_bytes: 256 * 1024,
  auth_bytes: 16 * 1024,
  page_events: 256,
  page_bytes: 1024 * 1024,
  unacked_bytes: 2 * 1024 * 1024,
  chunk_bytes: 128 * 1024,
  heartbeat_ms: 25000,
  dead_ms: 75000,
  auth_ms: 10000,
  connections: 32,
})
export const Id = z.string().min(1).max(128)
export const Sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)
export const Version = z.object({ major: z.literal(0), minor: z.literal(0) }).strict()
export const ErrorSchema = z
  .object({ code: Id, message: z.string().max(2048), details: z.record(z.unknown()).default({}) })
  .strict()
export const EventSchema = z
  .object({
    kind: z.literal('event'),
    node_id: Id,
    stream_id: Id,
    seq: Sequence,
    type: Id,
    actor: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('node') }).strict(),
      z.object({ kind: z.literal('installation'), installation_id: Id }).strict(),
      z.object({ kind: z.literal('provider'), provider: Id, session_id: Id }).strict(),
    ]),
    at: z.string().datetime(),
    data: z.unknown(),
  })
  .strict()
export const RequestSchema = z
  .object({
    kind: z.literal('request'),
    request_id: Id,
    operation_id: Id.optional(),
    method: Id,
    params: z.unknown(),
  })
  .strict()
const ResponseSchema = z
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
export const WelcomeSchema = z
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
export const RecordSchema = z.union([
  ...PairedRecordSchemas,
  z
    .object({
      kind: z.literal('auth'),
      profile: z.literal('local-token-v1'),
      token: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
  z.object({ kind: z.literal('authenticated'), installation_id: Id }).strict(),
  z.object({ kind: z.literal('hello'), version: Version }).strict(),
  WelcomeSchema,
  RequestSchema,
  ResponseSchema,
  EventSchema,
  z.object({ kind: z.enum(['ping', 'pong']) }).strict(),
])
export type RecordFrame = z.infer<typeof RecordSchema>
export type JournalEvent = z.infer<typeof EventSchema>
export type RequestFrame = z.infer<typeof RequestSchema>
export class ChannelError extends Error {
  constructor(
    public code: string,
    message = code,
    public details: Record<string, unknown> = {}
  ) {
    super(message)
  }
}
export const FrameCodec = {
  encode(value: unknown): Uint8Array {
    const parsed = RecordSchema.parse(value)
    const bytes = new TextEncoder().encode(JSON.stringify(parsed))
    if (bytes.length > LIMITS.record_bytes) throw new ChannelError('record_too_large')
    return bytes
  },
  decode(bytes: Uint8Array): RecordFrame {
    if (bytes.byteLength > LIMITS.record_bytes) throw new ChannelError('record_too_large')
    return RecordSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)))
  },
}
export interface RecordTransport {
  send(record: Uint8Array): Promise<void>
  receive(): AsyncIterable<Uint8Array>
  close(reason: string): Promise<void>
}
export interface AuthorityContext {
  installation_id: string
  profile?: 'local-token-v1' | 'paired-wss-v1'
  device_key?: string
}
export type NodeConnection =
  | {
      url: string
      token: string
      expected_node_id?: string
      profile: 'local-token-v1'
    }
  | {
      url: string
      profile: 'paired-wss-v1'
      expected_node_id: string
      node_fingerprint: string
      installation_id: string
      public_key: PublicKey
    }
export interface AuthenticatedChannel {
  transport: RecordTransport
  authority: AuthorityContext
  welcome: z.infer<typeof WelcomeSchema>
}
export interface ChannelConnector {
  connect(target: NodeConnection): Promise<AuthenticatedChannel>
}
/** No hostnames, redirects, LAN, alternate profiles, URL secrets or configurable host. */
export function assertLocalEndpoint(target: NodeConnection): void {
  const url = new URL(target.url)
  if (
    target.profile !== 'local-token-v1' ||
    url.protocol !== 'ws:' ||
    url.hostname !== '127.0.0.1' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/channel'
  )
    throw new ChannelError('endpoint_refused')
}
