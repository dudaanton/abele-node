import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  assertSequence,
  isCompatibleVersion,
  NODE_PROTOCOL_VERSION,
  type CapabilityReport,
  type EventEnvelope,
} from '../src/index.js'

describe('stage 0 contracts', () => {
  it('round-trips an unknown provider event without discarding its payload', () => {
    const event: EventEnvelope = {
      kind: 'event',
      node_id: 'node-fixture',
      stream_id: 'session-fixture',
      seq: 1,
      type: 'provider.raw',
      actor: { kind: 'provider', provider: 'claude', session_id: 'session-fixture' },
      at: '2026-09-30T00:00:00.000Z',
      data: { type: 'future_provider_record', nested: { text: 'hello' } },
    }
    expect(JSON.parse(JSON.stringify(event))).toEqual(event)
  })

  it('retains recorded provider payloads through the event envelope', () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL('../../../probes/fixtures/provider-records.json', import.meta.url),
        'utf8'
      )
    ) as { records: unknown[] }
    expect(fixture.records.length).toBeGreaterThan(0)
    for (const [seq, data] of fixture.records.entries()) {
      const event: EventEnvelope = {
        kind: 'event',
        node_id: 'node-fixture',
        stream_id: 'session-fixture',
        seq,
        type: 'provider.raw',
        actor: { kind: 'node' },
        at: '2026-09-30T00:00:00.000Z',
        data,
      }
      expect(JSON.parse(JSON.stringify(event)).data).toEqual(data)
    }
  })

  it('accepts only nonnegative safe integer sequences, never wrapping', () => {
    for (const seq of [0, 1, Number.MAX_SAFE_INTEGER]) {
      expect(() => assertSequence(seq)).not.toThrow()
    }
    for (const seq of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
      expect(() => assertSequence(seq)).toThrow(RangeError)
    }
  })

  it('rejects unknown and malformed protocol versions', () => {
    expect(isCompatibleVersion(NODE_PROTOCOL_VERSION)).toBe(true)
    for (const version of [
      { major: 1, minor: 0 },
      { major: 0, minor: 1 },
      { major: 0, minor: -1 },
      { major: 0, minor: NaN },
      null,
      '0.0',
      {},
    ]) {
      expect(isCompatibleVersion(version)).toBe(false)
    }
  })

  it('keeps measured support distinct from unverified capabilities', () => {
    const report: CapabilityReport = {
      provider: 'claude',
      provider_version: 'fixture',
      capabilities: {
        continuation: { status: 'supported', evidence: 'fixture-resume' },
        steering: { status: 'unverified', reason: 'No steering probe yet' },
        remote_approval: { status: 'unsupported', reason: 'No bridge in this mode' },
      },
    }
    expect(JSON.parse(JSON.stringify(report))).toEqual(report)
  })
})
