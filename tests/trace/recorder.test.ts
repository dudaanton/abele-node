import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeCore } from '../../packages/node-core/src/index.js'
import { DapSession } from '../../packages/node-core/src/debugger/driver.js'
import { TracePoints, TraceRecorder } from '../../packages/node-core/src/trace/recorder.js'
import { TraceStore } from '../../packages/node-core/src/trace/store.js'
import { wire } from '../debugger/dap-wire.js'
import { target } from '../debugger/helpers.js'
import { adapter } from './adapter.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function fixture(frame: () => Record<string, unknown>) {
  const dir = mkdtempSync(join(tmpdir(), 'trace-recorder-'))
  dirs.push(dir)
  const core = new NodeCore(join(dir, 'state'), { debuggerEnabled: true })
  const w = wire()
  const fake = adapter(w, frame)
  const state = core.debugger.create({ ...target, build_identity: 'matched' })
  const session = new DapSession(
    core.debugger,
    state,
    w.dap,
    new Map([['source', '/project/src/page.ts']])
  )
  await session.start('attach', { type: 'pwa-node', port: 1 })
  const points = new TracePoints()
  const store = new TraceStore(join(dir, 'runs'))
  const recorder = new TraceRecorder({
    service: core.debugger,
    points,
    storeFor: () => store,
    rootFor: () => '/project',
  })
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setTimeout(r, 2))
    expect(check()).toBe(true)
  }
  const breakpoint = async (id: string, line: number, condition?: string) => {
    const revision = session.snapshot.breakpoint_revision
    await session.patchBreakpoints(
      revision,
      [{ breakpoint_id: id, source_id: 'source', line, ...(condition ? { condition } : {}) }],
      []
    )
    return fake.lastBreakpointId()
  }
  return {
    core,
    w,
    fake,
    session,
    points,
    store,
    recorder,
    until,
    breakpoint,
    close() {
      fake.stop()
      recorder.close()
      w.dap.close()
      core.close()
    },
  }
}

describe('a run recorded over a debugger session', () => {
  it('takes the values of a record point whole and lets the program go on', async () => {
    const xmlText = `<doc>${'<item>1</item>'.repeat(20_000)}</doc>`
    const f = await fixture(() => ({ xmlText, result: { items: [1, 2, 3] }, Buffer }))
    try {
      const dapId = await f.breakpoint('bp-1', 4)
      f.points.set(
        f.session.id,
        [{ breakpoint_id: 'bp-1', take: ['xmlText', 'result'], note: 'Page parsed' }],
        []
      )
      f.recorder.attach(f.session)
      const run = f.recorder.recording(f.session.id)!
      expect(run).toBeDefined()
      f.fake.hit([dapId])
      await f.until(() => f.store.read(run.run_id).steps.length === 1)
      await f.until(() => f.fake.running)
      const step = f.store.read(run.run_id).steps[0]!
      expect(step).toMatchObject({
        kind: 'probe',
        point: 'bp-1',
        label: 'Page parsed',
        place: { file: 'src/page.ts', line: 4, fn: 'parsePage' },
        stack: ['parsePage src/page.ts:4', 'loadDocument src/service.ts:9'],
      })
      expect(step.paused_ms).toBeGreaterThanOrEqual(0)
      expect(f.store.text(run.run_id, step.values[0]!)).toBe(xmlText)
      expect(step.values[0]!.format).toBe('xml')
      expect(JSON.parse(f.store.text(run.run_id, step.values[1]!))).toEqual({ items: [1, 2, 3] })
      expect(f.w.messages.filter((m) => m.command === 'continue')).toHaveLength(1)
    } finally {
      f.close()
    }
  })

  it('takes nothing at a record point with an empty list, and still lets the program go on', async () => {
    const f = await fixture(() => ({ secret: 'sample-token', result: { items: [1] } }))
    try {
      const dapId = await f.breakpoint('bp-1', 4)
      f.points.set(f.session.id, [{ breakpoint_id: 'bp-1', take: [] }], [])
      f.recorder.attach(f.session)
      const run = f.recorder.recording(f.session.id)!
      f.fake.hit([dapId])
      await f.until(() => f.store.read(run.run_id).steps.length === 1)
      await f.until(() => f.fake.running)
      expect(f.store.read(run.run_id).steps[0]).toMatchObject({ kind: 'probe', values: [] })
      const asked = f.w.messages.map((m) => m.command)
      expect(asked).not.toContain('scopes')
      expect(asked).not.toContain('variables')
      expect(asked).not.toContain('evaluate')
      expect(asked.filter((c) => c === 'continue')).toHaveLength(1)
    } finally {
      f.close()
    }
  })

  it('leaves a stop on an ordinary breakpoint stopped and records nothing for it', async () => {
    const f = await fixture(() => ({}))
    try {
      const recordId = await f.breakpoint('bp-record', 4)
      const stopId = await f.breakpoint('bp-stop', 6)
      expect(recordId).not.toBe(stopId)
      f.points.set(f.session.id, [{ breakpoint_id: 'bp-record', take: [] }], [])
      f.recorder.attach(f.session)
      f.fake.hit([stopId])
      await new Promise((r) => setTimeout(r, 30))
      await f.recorder.settled(f.session.id)
      expect(f.w.messages.some((m) => m.command === 'continue')).toBe(false)
      expect(f.session.snapshot.execution).toBe('stopped')
      expect(f.store.read(f.recorder.recording(f.session.id)!.run_id).steps).toHaveLength(0)
    } finally {
      f.close()
    }
  })

  it('says why a value could not be taken and still goes on', async () => {
    const f = await fixture(() => ({ ok: 1 }))
    try {
      const dapId = await f.breakpoint('bp-1', 4)
      f.points.set(f.session.id, [{ breakpoint_id: 'bp-1', take: ['ok', 'missing.deep'] }], [])
      f.recorder.attach(f.session)
      f.fake.hit([dapId])
      const run = f.recorder.recording(f.session.id)!.run_id
      await f.until(() => f.store.read(run).steps.length === 1)
      const [ok, missing] = f.store.read(run).steps[0]!.values
      expect(ok).toMatchObject({ name: 'ok', inline: '1' })
      expect(missing).toMatchObject({
        name: 'missing.deep',
        failed: expect.stringMatching(/missing/),
      })
      await f.until(() => f.fake.running)
    } finally {
      f.close()
    }
  })

  it('names a value as asked and records an exception as a step', async () => {
    const f = await fixture(() => ({ ctx: { request: { id: 'req-1' } } }))
    try {
      const dapId = await f.breakpoint('bp-1', 4)
      f.points.set(
        f.session.id,
        [{ breakpoint_id: 'bp-1', take: ['ctx.request.id as requestId'] }],
        []
      )
      f.recorder.attach(f.session)
      const run = f.recorder.recording(f.session.id)!.run_id
      f.fake.hit([dapId])
      await f.until(() => f.store.read(run).steps.length === 1)
      await f.until(() => f.fake.running)
      f.fake.hit([], 'exception', 'SampleError: no rows')
      await f.until(() => f.store.read(run).steps.length === 2)
      const steps = f.store.read(run).steps
      expect(steps[0]!.values[0]).toMatchObject({ name: 'requestId', inline: 'req-1' })
      expect(steps[1]).toMatchObject({ kind: 'error', label: 'SampleError: no rows' })
    } finally {
      f.close()
    }
  })

  it('keeps the run when the program ends, and marks it cut when the connection goes', async () => {
    const f = await fixture(() => ({}))
    try {
      await f.breakpoint('bp-1', 4)
      f.points.set(f.session.id, [{ breakpoint_id: 'bp-1', take: [] }], [])
      f.recorder.attach(f.session)
      const run = f.recorder.recording(f.session.id)!.run_id
      expect(f.store.read(run).run.points).toEqual([
        { breakpoint_id: 'bp-1', file: 'src/page.ts', line: 4, take: [] },
      ])
      f.w.dap.close()
      await f.until(() => f.store.read(run).run.state !== 'recording')
      expect(f.store.read(run).run.state).toBe('cut')
      expect(f.recorder.recording(f.session.id)).toBeUndefined()
    } finally {
      f.close()
    }
  })

  it('records nothing in a session without record points, and starts once one is set', async () => {
    const f = await fixture(() => ({}))
    try {
      await f.breakpoint('bp-1', 4)
      f.recorder.attach(f.session)
      expect(f.recorder.recording(f.session.id)).toBeUndefined()
      expect(f.store.list()).toEqual([])
      f.points.set(f.session.id, [{ breakpoint_id: 'bp-1', take: [] }], [])
      expect(f.recorder.recording(f.session.id)).toBeDefined()
      expect(f.store.list()).toHaveLength(1)
    } finally {
      f.close()
    }
  })
})
