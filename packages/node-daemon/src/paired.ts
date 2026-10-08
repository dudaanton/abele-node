import { z } from 'zod'
import {
  FrameCodec,
  LIMITS,
  ChannelError,
  assertPairedEndpoint,
  fingerprint,
  randomNonce,
  signProof,
  verifyProof,
  proofTranscript,
  type DeviceChallenge,
  type RecordTransport,
} from '@abele/channel-protocol'
import type { NodeCore } from '@abele/node-core'
import { serveChannel } from '@abele/channel-server'
export const PairedListenerSchema = z
  .object({
    endpoint: z
      .string()
      .transform((s) => {
        try {
          const url = new URL(s)
          if (!url.port) url.port = '8443'
          return url.href
        } catch {
          return s
        }
      })
      .refine((s) => {
        try {
          assertPairedEndpoint(s)
          return true
        } catch {
          return false
        }
      }),
    backend_port: z.number().int().min(0).max(65535).default(47124),
    origins: z
      .array(
        z
          .string()
          .min(1)
          .max(2048)
          .refine((s) => !s.includes('*') && s !== 'null')
      )
      .max(16)
      .default([]),
    allow_missing_origin: z.boolean().default(false),
    allow_null_origin: z.boolean().default(false),
  })
  .strict()
export type PairedListenerConfig = z.infer<typeof PairedListenerSchema>
export function pairedAdmission(
  config: PairedListenerConfig,
  host: string | undefined,
  origin: string | undefined,
  path: string
): boolean {
  const endpoint = new URL(config.endpoint)
  return (
    path === endpoint.pathname &&
    host === endpoint.host &&
    (origin === undefined
      ? config.allow_missing_origin
      : origin === 'null'
        ? config.allow_null_origin
        : config.origins.includes(origin))
  )
}
/** No local-token branch exists on this listener, even for a loopback peer. */
export async function servePairedChannel(
  transport: RecordTransport,
  core: NodeCore,
  endpoint: string
) {
  let expired = false
  const deadline = setTimeout(() => {
    expired = true
    void transport.close('authentication_timeout')
  }, LIMITS.auth_ms)
  try {
    const iterator = transport.receive()[Symbol.asyncIterator]()
    const next = async () => {
      const row = await iterator.next()
      if (row.done || row.value.byteLength > LIMITS.auth_bytes)
        throw new ChannelError('unauthorized')
      return FrameCodec.decode(row.value)
    }
    const begin = await next()
    if (begin.kind !== 'paired.begin') throw new ChannelError('profile_refused')
    const identity = await core.pairing.identity.load()
    const challenge: DeviceChallenge = {
      kind: 'paired.challenge',
      profile: 'paired-wss-v1',
      connection_id: randomNonce(),
      client_nonce: begin.client_nonce,
      node_id: core.node_id,
      endpoint,
      installation_id: begin.installation_id ?? begin.invite!.invite_id,
      purpose: begin.invite ? 'claim' : 'connect',
      device_fingerprint: await fingerprint(begin.public_key),
      expires_at: Date.now() + LIMITS.auth_ms,
      node_key: identity.public_key,
      signature: '',
    }
    challenge.signature = await signProof(identity.private_key, proofTranscript(challenge, 'node'))
    await transport.send(FrameCodec.encode(challenge))
    const proof = await next()
    if (
      proof.kind !== 'paired.proof' ||
      Date.now() >= challenge.expires_at ||
      !(await verifyProof(begin.public_key, proofTranscript(challenge, 'device'), proof.signature))
    )
      throw new ChannelError('unauthorized')
    const checkProof = () => {
      if (expired || Date.now() >= challenge.expires_at) throw new ChannelError('unauthorized')
    }
    checkProof()
    // Rotation can interleave with asynchronous crypto. Recheck the current node identity.
    if (
      (await fingerprint((await core.pairing.identity.load()).public_key)) !==
      (await fingerprint(identity.public_key))
    )
      throw new ChannelError('node_identity_changed')
    if (begin.invite) {
      if (
        begin.invite.endpoint !== endpoint ||
        begin.invite.node_id !== core.node_id ||
        begin.invite.node_fingerprint !== (await fingerprint(identity.public_key))
      )
        throw new ChannelError('invalid_invite')
      const claim = await core.pairing.claim(begin.invite, begin.public_key, checkProof)
      await transport.send(FrameCodec.encode({ kind: 'paired.claimed', claim }))
      return
    }
    checkProof()
    const actor = core.pairing.actor(begin.installation_id!, begin.public_key)
    await transport.send(
      FrameCodec.encode({ kind: 'authenticated', installation_id: actor.installation_id })
    )
    clearTimeout(deadline)
    await serveChannel(transport, core, actor)
  } catch {
    /* Admission fails closed without unauthenticated details. */
  } finally {
    clearTimeout(deadline)
    await transport.close('paired_channel_closed')
  }
}
