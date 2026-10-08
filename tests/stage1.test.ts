import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
import { FrameCodec, LIMITS } from '../packages/channel-protocol/src/index.js'

mkdirSync('.scratch', { recursive: true })
const dirs: string[] = []
const cores: NodeCore[] = []
function setup() {
  const dir = mkdtempSync(resolve('.scratch/core-'))
  dirs.push(dir)
  const core = new NodeCore(dir)
  cores.push(core)
  const token = core.createToken('test')
  const actor = core.authority.authenticate(token.token)
  const session = core.request(actor, 'session.create', { title: 'fixture' }, 'create') as {
    session_id: string
  }
  return { core, actor, token, dir, session_id: session.session_id }
}
afterEach(() => {
  vi.useRealTimers()
  for (const c of cores.splice(0)) c.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('durable node core', () => {
  it('commits receipts with state; lost response retries and changed bodies are rejected', () => {
    const { core, actor, session_id } = setup()
    const body = { session_id, text: 'hello', observed_seq: 0 }
    core.fault = (point) => {
      if (point === 'after_commit') throw new Error('lost response')
    }
    expect(() => core.request(actor, 'session.send', body, 'send')).toThrow('lost response')
    core.fault = undefined
    const result = core.request(actor, 'session.send', body, 'send')
    expect(core.request(actor, 'session.send', body, 'send')).toEqual(result)
    expect(() => core.request(actor, 'session.send', { ...body, text: 'changed' }, 'send')).toThrow(
      'idempotency_mismatch'
    )
    expect(core.read(session_id, 0).filter((e) => e.type === 'input.accepted')).toHaveLength(1)
  })
  it('rolls back at the commit boundary and stops execution on storage failure', () => {
    const { core, actor, session_id } = setup()
    core.fault = (point) => {
      if (point === 'before_commit') throw new Error('SQLITE_FULL')
    }
    expect(() =>
      core.request(actor, 'session.send', { session_id, text: 'x', observed_seq: 0 }, 'failed')
    ).toThrow('SQLITE_FULL')
    expect(core.read(session_id, 0).filter((e) => e.type === 'input.accepted')).toHaveLength(0)
    expect(() => core.tick()).toThrow()
  })
  it('two principals converge, prompt answer/expiry is first-valid-wins and never grants on timeout', () => {
    // Only the core's wall clock is fake; subprocesses and timer scheduling stay real.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const { core, actor, session_id } = setup()
    const other = core.authority.authenticate(core.createToken('other').token)
    core.request(
      actor,
      'session.send',
      {
        session_id,
        text: 'permission',
        observed_seq: 0,
        script: [{ kind: 'permission', ttl_ms: 10 }],
      },
      'p'
    )
    core.tick()
    const prompt = core.prompts(session_id)[0]!
    expect(prompt.expires_at).toBe(Date.now() + 10)
    vi.setSystemTime(prompt.expires_at - 1)
    const answer = {
      session_id,
      prompt_id: prompt.prompt_id,
      run_id: prompt.run_id,
      revision: 1,
      action_digest: prompt.action_digest,
      choice: 'allow',
    }
    const a = core.request(other, 'prompt.answer', answer, 'a')
    expect(core.request(actor, 'prompt.answer', { ...answer, choice: 'deny' }, 'b')).toEqual(a)
    vi.setSystemTime(prompt.expires_at)
    core.tick()
    expect(core.read(session_id, 0).filter((e) => e.type === 'prompt.resolved')).toHaveLength(1)
    core.request(
      actor,
      'session.send',
      { session_id, text: 'expiry', observed_seq: 0, script: [{ kind: 'permission', ttl_ms: 1 }] },
      'q'
    )
    core.tick()
    const expiring = core.prompts(session_id).find((p) => p.state === 'pending')!
    expect(expiring.expires_at).toBe(Date.now() + 1)
    vi.setSystemTime(expiring.expires_at - 1)
    core.tick()
    expect(core.prompts(session_id).find((p) => p.prompt_id === expiring.prompt_id)).toMatchObject({
      state: 'pending',
      choice: null,
      delivered: false,
    })
    vi.setSystemTime(expiring.expires_at)
    // At the exact boundary, even before the expiry sweep, allow must fail closed.
    expect(() =>
      core.request(
        other,
        'prompt.answer',
        {
          ...answer,
          prompt_id: expiring.prompt_id,
          run_id: expiring.run_id,
          action_digest: expiring.action_digest,
        },
        'at-deadline'
      )
    ).toThrow('prompt_expired')
    core.tick()
    const expired = core.prompts(session_id).find((p) => p.state === 'expired')!
    expect(expired).toMatchObject({ choice: 'deny', delivered: true })
    expect(() =>
      core.request(
        other,
        'prompt.answer',
        {
          ...answer,
          prompt_id: expired.prompt_id,
          run_id: expired.run_id,
          action_digest: expired.action_digest,
        },
        'late'
      )
    ).toThrow('prompt_expired')
  })
  it('restart preserves journal/queue, fences uncertain delivery, and resumes queued followups', () => {
    const { core, actor, session_id, dir, token } = setup()
    core.request(
      actor,
      'session.send',
      { session_id, text: 'hang', observed_seq: 0, script: [{ kind: 'hang' }] },
      'hang'
    )
    core.tick()
    core.request(actor, 'session.send', { session_id, text: 'next', observed_seq: 0 }, 'next')
    const before = core.read(session_id, 0)
    core.close()
    const reopened = new NodeCore(dir)
    cores.push(reopened)
    reopened.tick()
    const history = reopened.read(session_id, 0)
    expect(history.slice(0, before.length)).toEqual(before)
    expect(history.some((e) => e.type === 'input.delivery_unknown')).toBe(true)
    expect(history.some((e) => e.type === 'input.completed')).toBe(true)
    expect(reopened.authority.authenticate(token.token)).toEqual(actor)
  })
  it('a second permission action in one run requires a new correlated approval', () => {
    const { core, actor, session_id } = setup()
    core.request(
      actor,
      'session.send',
      {
        session_id,
        text: 'two approvals',
        observed_seq: 0,
        script: [
          { kind: 'permission', ttl_ms: 60000 },
          { kind: 'chunk', text: 'first' },
          { kind: 'permission', ttl_ms: 60000 },
          { kind: 'chunk', text: 'second' },
        ],
      },
      'two-prompts'
    )
    core.tick()
    const p = core.prompts(session_id)[0]!
    core.request(
      actor,
      'prompt.answer',
      {
        session_id,
        prompt_id: p.prompt_id,
        run_id: p.run_id,
        revision: p.revision,
        action_digest: p.action_digest,
        choice: 'allow',
      },
      'first-answer'
    )
    core.tick()
    expect(core.prompts(session_id)).toHaveLength(2)
    expect(core.prompts(session_id).filter((p) => p.state === 'pending')).toHaveLength(1)
    expect(core.read(session_id, 0).some((e) => e.type === 'input.completed')).toBe(false)
  })
  it('journal read pages fit a response record and retain every event', () => {
    const { core, actor, session_id } = setup()
    for (let i = 0; i < 40; i++) {
      core.request(
        actor,
        'session.send',
        { session_id, text: 'x'.repeat(8000), observed_seq: 0 },
        'large-' + i
      )
      core.tick()
    }
    let cursor = 0,
      count = 0
    while (cursor < core.head(session_id)) {
      const page = core.read(session_id, cursor)
      expect(() =>
        FrameCodec.encode({ kind: 'response', request_id: 'page', result: page })
      ).not.toThrow()
      expect(page.length).toBeGreaterThan(0)
      count += page.length
      cursor = page.at(-1)!.seq
    }
    expect(count).toBe(core.head(session_id))
  })
  it('real SQLITE_FULL rolls back acceptance and halts later approvals/execution', () => {
    const { core, actor, session_id } = setup()
    const pages = Number(
      (core.db.prepare('PRAGMA page_count').get() as { page_count: number }).page_count
    )
    core.db.exec('PRAGMA max_page_count=' + pages)
    expect(() =>
      core.request(
        actor,
        'session.send',
        { session_id, text: 'x'.repeat(32768), observed_seq: 0 },
        'disk-full'
      )
    ).toThrow(/full/i)
    expect(core.read(session_id, 0).filter((e) => e.type === 'input.accepted')).toHaveLength(0)
    expect(() => core.tick()).toThrow('storage_unavailable')
    expect(() =>
      core.request(actor, 'session.send', { session_id, text: 'small', observed_seq: 0 }, 'later')
    ).toThrow('storage_unavailable')
  })
  it('cross-node credentials cannot authenticate even with the same installation label', () => {
    const a = setup(),
      b = setup()
    expect(a.core.node_id).not.toBe(b.core.node_id)
    expect(() => b.core.authority.authenticate(a.token.token)).toThrow('unauthorized')
  })
  it('scripted streaming, failure, cancellation, interruption and artifact reads are durable', () => {
    const { core, actor, session_id } = setup()
    core.request(
      actor,
      'session.send',
      {
        session_id,
        text: 'fixture',
        observed_seq: 0,
        script: [
          { kind: 'chunk', text: 'first' },
          { kind: 'chunk', text: 'x'.repeat(20000) },
          { kind: 'fail' },
        ],
      },
      'script'
    )
    core.tick()
    const event = core
      .read(session_id, 0)
      .find((e) => e.type === 'content.delta' && (e.data as { artifact_id?: string }).artifact_id)!
    const artifact = core.request(actor, 'artifact.read', {
      session_id,
      artifact_id: (event.data as { artifact_id: string }).artifact_id,
      offset: 0,
      length: 100,
    }) as { base64: string; total: number }
    expect(Buffer.from(artifact.base64, 'base64').toString()).toBe('x'.repeat(100))
    expect(artifact.total).toBe(20000)
    expect(core.read(session_id, 0).some((e) => e.type === 'input.failed')).toBe(true)
    const queued = core.request(
      actor,
      'session.send',
      { session_id, text: 'cancel', observed_seq: 0 },
      'cancel-send'
    ) as { input_id: string }
    core.request(actor, 'input.cancel', { session_id, input_id: queued.input_id }, 'cancel')
    core.request(
      actor,
      'session.send',
      { session_id, text: 'hang', observed_seq: 0, script: [{ kind: 'hang' }] },
      'hang-send'
    )
    core.tick()
    const run = core
      .read(session_id, 0)
      .filter((e) => e.type === 'run.started')
      .at(-1)!
    core.request(
      actor,
      'session.interrupt',
      { session_id, run_id: (run.data as { run_id: string }).run_id },
      'interrupt'
    )
    expect(core.read(session_id, 0).some((e) => e.type === 'input.interrupted')).toBe(true)
  })
  it('revocation applies to receipt replay and queued execution', () => {
    const { core, actor, session_id, token } = setup()
    const body = { session_id, text: 'queued', observed_seq: 0 }
    core.request(actor, 'session.send', body, 'queued')
    core.revokeToken(token.installation_id)
    expect(() => core.authority.authenticate(token.token)).toThrow('unauthorized')
    expect(() => core.request(actor, 'session.send', body, 'queued')).toThrow('unauthorized')
    core.tick()
    expect(core.read(session_id, 0).some((e) => e.type === 'input.cancelled')).toBe(true)
  })
})

describe('bounded frame validation', () => {
  it('rejects malformed, oversized, unknown envelopes and versions while preserving unknown events', () => {
    for (const bytes of [
      new Uint8Array(LIMITS.record_bytes + 1),
      new TextEncoder().encode('{'),
      new TextEncoder().encode('{"kind":"future"}'),
    ])
      expect(() => FrameCodec.decode(bytes)).toThrow()
    expect(() => FrameCodec.encode({ kind: 'hello', version: { major: 99, minor: 0 } })).toThrow()
    const event = {
      kind: 'event',
      node_id: 'n',
      stream_id: 's',
      seq: 1,
      type: 'future.event',
      actor: { kind: 'node' },
      at: new Date().toISOString(),
      data: { unknown: ['kept'] },
    }
    expect(FrameCodec.decode(FrameCodec.encode(event))).toEqual(event)
  })
})
