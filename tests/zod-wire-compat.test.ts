import { describe, expect, it } from 'vitest'
import {
  ErrorSchema,
  EventSchema,
  RequestSchema,
  WelcomeSchema,
  FrameCodec,
  WireOffsetTimestampSchema,
} from '../packages/channel-protocol/src/index.js'
import {
  MethodSchemas,
  FakeStepSchema,
  CapabilitySchema,
} from '../packages/node-protocol/src/schemas.js'
import { ToolLocationSchema } from '../packages/node-protocol/src/session-update.js'
import {
  ActionSchema,
  IdentitySchema,
  WorkerMessageSchema,
} from '../packages/provider-pi/src/wire.js'
import { z as legacy } from 'zod/v3'
import { NodeCore } from '../packages/node-core/src/index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { debuggerToolDefinitions } from '../packages/node-core/src/debugger/agent.js'

describe('wire validation compatibility', () => {
  it('keeps debugger tool JSON schemas, defaults, and admission-only operation IDs', () => {
    const stack = debuggerToolDefinitions.find((tool) => tool.name === 'debug_stack')!
    expect(stack.inputSchema).toEqual({
      type: 'object',
      properties: {
        debug_session_id: { type: 'string', minLength: 1, maxLength: 128 },
        incarnation: { type: 'string', minLength: 1, maxLength: 128 },
        expected_state_revision: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        thread_id: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
        start: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER, default: 0 },
        count: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
      },
      required: ['debug_session_id', 'incarnation', 'expected_state_revision', 'thread_id'],
      additionalProperties: false,
    })
    const patch = debuggerToolDefinitions.find((tool) => tool.name === 'debug_breakpoints_patch')!
    expect(patch.inputSchema).toMatchObject({
      properties: { upsert: { type: 'array', maxItems: 256 } },
    })
    expect(patch.inputSchema.properties).not.toHaveProperty('operation_id')
  })
  it('keeps defaults and unknown key policies', () => {
    expect(ErrorSchema.parse({ code: 'invalid_params', message: 'bad' })).toEqual({
      code: 'invalid_params',
      message: 'bad',
      details: {},
    })
    expect(MethodSchemas['session.create'].parse({})).toEqual({
      title: 'Fake session',
      provider: 'fake',
    })
    expect(FakeStepSchema.parse({ kind: 'permission' })).toEqual({
      kind: 'permission',
      ttl_ms: 60000,
    })
    expect(MethodSchemas['session.create'].safeParse({ extra: true }).success).toBe(false)
    expect(ToolLocationSchema.parse({ path: 'x', future: true })).toEqual({ path: 'x' })
    expect(WelcomeSchema.shape.capabilities.parse({ future: true })).toEqual({ future: true })
  })
  it('preserves absent unknown fields and response exclusivity', () => {
    expect(RequestSchema.parse({ kind: 'request', request_id: 'r', method: 'x' })).toEqual({
      kind: 'request',
      request_id: 'r',
      method: 'x',
    })
    for (const frame of [
      { kind: 'response', request_id: 'r', result: null },
      { kind: 'response', request_id: 'r', error: { code: 'x', message: 'x', details: {} } },
    ]) {
      expect(FrameCodec.decode(FrameCodec.encode(frame))).toEqual(frame)
    }
    expect(() => FrameCodec.encode({ kind: 'response', request_id: 'r' })).toThrow()
    expect(() =>
      FrameCodec.encode({
        kind: 'response',
        request_id: 'r',
        result: null,
        error: { code: 'x', message: 'x' },
      })
    ).toThrow()
    expect(
      EventSchema.safeParse({
        kind: 'event',
        node_id: 'n',
        stream_id: 's',
        seq: 0,
        type: 'future',
        actor: { kind: 'node' },
        at: '2026-01-01T00:00:00Z',
      }).success
    ).toBe(true)
  })
  it('keeps validation paths and does not coerce numbers', () => {
    const result = MethodSchemas['stream.read'].safeParse({ stream_id: 's', after_seq: '0' })
    expect(result.success).toBe(false)
    if (!result.success)
      expect(result.error.issues.map(({ code, path }) => ({ code, path }))).toEqual([
        { code: 'invalid_type', path: ['after_seq'] },
      ])
  })
  it('keeps command context validation errors on the wire', () => {
    const dir = mkdtempSync(resolve('.scratch/zod-errors-'))
    const core = new NodeCore(dir)
    try {
      const actor = core.authority.authenticate(core.createToken('test').token)
      expect(() =>
        core.request(
          actor,
          'command.context.v1.prepare',
          {
            context_id: 'c',
            parent_chat_id: 'p',
            command: 'echo test',
            permission_mode: 'ask',
            extra: true,
          },
          'op'
        )
      ).toThrow(
        expect.objectContaining({
          code: 'invalid_params',
          details: { fields: ["Unrecognized key(s) in object: 'extra'"] },
        })
      )
      for (const raw of [null, [], 1, undefined]) {
        const old = legacy.object({}).safeParse(raw)
        if (old.success) throw new Error('Invalid fixture')
        expect(() => core.request(actor, 'command.context.v1.prepare', raw, 'op')).toThrow(
          expect.objectContaining({
            code: 'invalid_params',
            details: { fields: old.error.issues.map((issue) => issue.message) },
          })
        )
      }
    } finally {
      core.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('retains JSON integers outside the safe range where the old schema allowed them', () => {
    // multipleOf(1) retains Zod 3's integer range; Zod 4 int() implies safe().
    const value = { pid: 1e20, group: 1e20, fingerprint: 'fixture' }
    expect(IdentitySchema.parse(value)).toEqual(value)
    expect(IdentitySchema.safeParse({ ...value, pid: 2.5 }).success).toBe(false)
  })
  it('retains timestamp precision accepted by existing nodes', () => {
    for (const value of [
      '2026-01-01T00:00Z',
      '2024-02-29T23:59:59.123Z',
      '2025-02-29T00:00Z',
      '2026-01-01T24:00Z',
      '2026-01-01T00:00:00+01:00',
    ]) {
      expect(EventSchema.shape.at.safeParse(value).success, value).toBe(
        legacy.string().datetime().safeParse(value).success
      )
    }
    for (const value of [
      '2026-01-01T00:00+0100',
      '2026-01-01T00:00:00+99:99',
      '2026-01-01T00:00Z',
      '2026-01-01T00:00',
      '2025-02-29T00:00+01:00',
    ]) {
      expect(WireOffsetTimestampSchema.safeParse(value).success, value).toBe(
        legacy.string().datetime({ offset: true }).safeParse(value).success
      )
    }
  })
  it('retains arbitrary record values and legacy UUIDs', () => {
    const action = {
      tool_use_id: 't',
      tool_name: 'x',
      native_session_id: '00000000-0000-0000-0000-000000000001',
      input: { future: [1, null, { x: true }] },
    }
    expect(ActionSchema.parse(action)).toEqual(action)
    expect(
      WorkerMessageSchema.parse({
        kind: 'event',
        event: { type: 'pi.future', data: { nested: [1] } },
      })
    ).toEqual({ kind: 'event', event: { type: 'pi.future', data: { nested: [1] } } })
  })
  it('bounds formerly unlimited network arrays and strings', () => {
    expect(WelcomeSchema.shape.methods.safeParse(Array(65537).fill('x')).success).toBe(false)
    const invalid = WelcomeSchema.shape.methods.safeParse(Array(65537).fill(null))
    expect(invalid.success).toBe(false)
    if (!invalid.success) {
      // Reject at the length check, without allocating an issue for every item.
      expect(invalid.error.issues).toHaveLength(1)
      expect(invalid.error.issues[0]!.code).toBe('too_big')
    }
    expect(
      CapabilitySchema.safeParse({
        status: 'supported',
        evidence: 'x'.repeat(16 * 1024 * 1024 + 1),
      }).success
    ).toBe(false)
  })
})
