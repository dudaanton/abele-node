/** Stable stage 0 fixture types, with stage 1 runtime schemas below. */
import { z } from 'zod'
export * from './pairing.js'
export type NodeId = string
export type SessionId = string
export type StreamId = string
export type ProviderSessionId = string
export type ProviderName = 'claude' | 'pi' | 'fake'

export interface ProtocolVersion {
  major: number
  minor: number
}

export const NODE_PROTOCOL_VERSION: Readonly<ProtocolVersion> = Object.freeze({
  major: 0,
  minor: 0,
})

/** Until negotiation exists, only the exact experimental version is compatible. */
export function isCompatibleVersion(value: unknown): value is ProtocolVersion {
  if (typeof value !== 'object' || value === null) return false
  const version = value as Partial<ProtocolVersion>
  return (
    version.major === NODE_PROTOCOL_VERSION.major && version.minor === NODE_PROTOCOL_VERSION.minor
  )
}

/** A journal sequence is not a provider ID, timestamp, or a wrapping counter. */
export function assertSequence(seq: number): void {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new RangeError('Sequence must be a nonnegative safe integer')
  }
}

/** Attribution is supplied by the authenticated host, never trusted from client input. */
export type Actor =
  | { kind: 'installation'; installation_id: string }
  | { kind: 'provider'; provider: ProviderName; session_id: SessionId }
  | { kind: 'node' }

export interface EventEnvelope<T = unknown> {
  kind: 'event'
  node_id: NodeId
  stream_id: StreamId
  seq: number
  type: string
  actor: Actor
  /** UTC ISO-8601 timestamp. Ordering comes from seq, not at. */
  at: string
  /** Unknown valid provider records must remain representable. */
  data: T
}

export type Capability =
  | { status: 'supported'; evidence: string }
  | { status: 'unsupported'; reason: string }
  | { status: 'unverified'; reason: string }

export * from './schemas.js'

export interface CapabilityReport {
  provider: ProviderName
  provider_version: string
  /** Absence means unverified, not supported. Evidence identifies a probe or fixture. */
  capabilities: Record<string, Capability>
}
