import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodeCore } from '../../packages/node-core/src/index.js'
import { DapSession } from '../../packages/node-core/src/debugger/driver.js'
import { TracePoints, TraceRecorder } from '../../packages/node-core/src/trace/recorder.js'
import { TraceStore } from '../../packages/node-core/src/trace/store.js'
import { wire } from '../debugger/dap-wire.js'
import { target } from '../debugger/helpers.js'
import { adapter } from './adapter.js'
import { programHttpKey } from '../../packages/node-core/src/trace/program-http.js'

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
    async close() {
      fake.stop()
      const drained = recorder.close()
      w.dap.close()
      await drained
      core.close()
    },
  }
}

describe('a run recorded over a debugger session', () => {
  it('continues a provisional record point without reading unconfirmed code', async () => {
    const f = await fixture(() => ({ secret: 1 }))
    try {
      f.session.provisionalSource = () => true
      f.session.verifyBreakpointSource = async () => {
        throw new Error('debugger_source_pending')
      }
      const dapId = await f.breakpoint('provisional', 4)
      f.points.set(f.session.id, [{ breakpoint_id: 'provisional', take: ['secret'] }], [])
      f.recorder.attach(f.session)
      f.fake.hit([dapId])
      await f.until(() => f.fake.running)
      expect(
        f.w.messages.some(
          (m) => m.command === 'setBreakpoints' && m.arguments.breakpoints.length === 0
        )
      ).toBe(true)
      const run = f.store.list()[0]!
      await f.until(() => f.store.read(run.id).steps.length === 1)
      expect(f.store.read(run.id).steps[0]).toMatchObject({
        label: 'Record point not confirmed, skipped',
      })
      expect(f.w.messages.some((m) => m.command === 'evaluate' && 'frameId' in m.arguments)).toBe(
        false
      )
      f.session.verifyBreakpointSource = async () => {
        f.session.provisionalSource = () => false
      }
      await f.until(() => f.session.snapshot.breakpoints[0]?.status === 'verified')
      expect(
        f.w.messages.filter((m) => m.command === 'setBreakpoints').at(-1).arguments.breakpoints
      ).toHaveLength(1)
    } finally {
      await f.close()
    }
  })
  it('retries a record stop when the breakpoint revision changes during capture', async () => {
    const f = await fixture(() => ({ value: 1 }))
    try {
      const dapId = await f.breakpoint('point', 4)
      f.points.set(f.session.id, [{ breakpoint_id: 'point', take: ['value'] }], [])
      f.recorder.attach(f.session)
      const original = f.session.recordStop.bind(f.session)
      vi.spyOn(f.session, 'recordStop').mockImplementationOnce(async (...args) => {
        f.core.debugger.patchBreakpoints(
          f.session.id,
          f.session.snapshot.breakpoint_revision,
          [{ breakpoint_id: 'point', source_id: 'source', line: 4 }],
          []
        )
        return original(...args)
      })
      f.fake.hit([dapId])
      await f.until(() => f.fake.running)
      expect(f.w.messages.some((m) => m.command === 'continue')).toBe(true)
    } finally {
      await f.close()
    }
  })
  it('keeps concurrent identical requests distinct by exact exchange identity', async () => {
    const traffic: any[] = []
    const f = await fixture(() => ({
      Buffer,
      [programHttpKey]: {
        drain: () => (traffic.length ? [traffic.shift()] : []),
        stop() {},
      },
    }))
    try {
      await f.breakpoint('point', 4)
      f.points.set(f.session.id, [{ breakpoint_id: 'point', take: [] }], [])
      f.recorder.attach(f.session)
      const request = { method: 'POST', url: 'http://localhost/events' }
      const first = f.recorder.chain(f.session.id, request)!
      const second = f.recorder.chain(f.session.id, request)!
      for (const [id, chain] of [
        ['second', second],
        ['first', first],
      ] as const)
        traffic.push({
          id,
          direction: 'incoming',
          method: request.method,
          url: request.url,
          started: Date.now(),
          ended: Date.now(),
          status: 201,
          request_headers: { 'x-abele-step': chain.id },
          response_headers: {},
          request_body: '',
          response_body: id,
        })
      await f.recorder.flushHttp(f.session.id)
      const firstStep = await first.close({ label: 'POST /events', values: [] })
      const secondStep = await second.close({ label: 'POST /events', values: [] })
      expect(firstStep).not.toBe(secondStep)
      const rows = f.store.read(first.runId).steps
      expect(rows).toHaveLength(2)
      expect(rows.find((row) => row.id === firstStep)).toMatchObject({
        chain: first.id,
        sent: true,
      })
      expect(rows.find((row) => row.id === secondStep)).toMatchObject({
        chain: second.id,
        sent: true,
      })
    } finally {
      await f.close()
    }
  })
  it('starts no HTTP-only recording for rejected points and starts when a point binds', async () => {
    const f = await fixture(() => ({}))
    try {
      await f.breakpoint('unbound', 4)
      const result = (verified: boolean, message?: string) =>
        f.core.debugger.observe(f.session.id, f.session.incarnation, {
          kind: 'breakpoints_result',
          revision: f.session.snapshot.breakpoint_revision,
          results: [{ breakpoint_id: 'unbound', verified, line: 4, message }],
        })
      result(false)
      f.points.set(f.session.id, [{ breakpoint_id: 'unbound', take: [] }], [])
      f.recorder.attach(f.session)
      expect(f.recorder.recording(f.session.id)).toBeUndefined()
      expect(f.store.list()).toEqual([])
      expect(f.session.snapshot.breakpoints[0]!.status).toBe('pending')
      result(false, 'debugger_source_no_map')
      expect(f.session.snapshot.breakpoints[0]!.status).toBe('rejected')
      expect(f.recorder.recording(f.session.id)).toBeUndefined()
      expect(f.store.list()).toEqual([])
      result(true)
      expect(f.recorder.recording(f.session.id)).toBeDefined()
      const run = f.recorder.recording(f.session.id)!.run_id
      f.core.debugger.observe(f.session.id, f.session.incarnation, {
        kind: 'breakpoints_pending',
        revision: f.session.snapshot.breakpoint_revision,
      })
      expect(f.recorder.recording(f.session.id)?.run_id).toBe(run)
      result(false)
      expect(f.session.snapshot.breakpoints[0]!.status).toBe('pending')
      expect(f.recorder.recording(f.session.id)?.run_id).toBe(run)
      expect(f.recorder.chain(f.session.id)?.runId).toBe(run)
      result(false, 'debugger_source_no_map')
      expect(f.session.snapshot.breakpoints[0]!.status).toBe('rejected')
      expect(f.recorder.recording(f.session.id)).toBeUndefined()
      f.core.debugger.observe(f.session.id, f.session.incarnation, {
        kind: 'breakpoints_pending',
        revision: f.session.snapshot.breakpoint_revision,
      })
      expect(f.recorder.recording(f.session.id)).toBeUndefined()
      result(true)
      expect(f.recorder.recording(f.session.id)).toBeDefined()
      f.core.debugger.patchBreakpoints(
        f.session.id,
        f.session.snapshot.breakpoint_revision,
        [{ breakpoint_id: 'unbound', source_id: 'source', line: 4, enabled: false }],
        []
      )
      expect(f.recorder.recording(f.session.id)).toBeUndefined()
    } finally {
      await f.close()
    }
  })
  it('keeps one sent row only when the captured request has this send exact correlation id', async () => {
    let traffic: any[] = []
    const f = await fixture(() => ({
      Buffer,
      [programHttpKey]: {
        drain: () => traffic.splice(0),
        stop() {},
      },
    }))
    try {
      await f.breakpoint('point', 4)
      f.points.set(f.session.id, [{ breakpoint_id: 'point', take: [] }], [])
      f.recorder.attach(f.session)
      const chain = f.recorder.chain(f.session.id, {
        method: 'POST',
        url: 'http://localhost/events',
      })!
      traffic.push({
        id: 'n1',
        direction: 'incoming',
        method: 'POST',
        url: 'http://localhost/events',
        started: Date.now(),
        ended: Date.now(),
        status: 201,
        request_headers: { 'x-abele-step': chain.id },
        response_headers: {},
        request_body: '',
        response_body: 'ok',
      })
      await f.recorder.flushHttp(f.session.id)
      const step = await chain.close({ label: 'POST /events', status: 201, values: [] })
      const rows = f.store.read(chain.runId).steps
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        id: step,
        sent: true,
        chain: chain.id,
        direction: 'incoming',
      })
    } finally {
      await f.close()
    }
  })
  it('continues an owned record stop when its point is removed during execution intent', async () => {
    const f = await fixture(() => ({}))
    try {
      const id = await f.breakpoint('record', 4)
      f.points.set(f.session.id, [{ breakpoint_id: 'record', take: [] }], [])
      f.recorder.attach(f.session)
      let changed = false
      const off = f.core.debugger.subscribe(f.session.id, () => {
        if (!changed && f.session.snapshot.execution === 'unknown') {
          changed = true
          f.points.set(f.session.id, [], ['record'])
        }
      })
      try {
        f.fake.hit([id])
        await f.recorder.settled(f.session.id)
        await f.until(() => f.fake.running)
        expect(changed).toBe(true)
        expect(f.w.messages.filter((m) => m.command === 'continue')).toHaveLength(1)
        expect(f.fake.running).toBe(true)
      } finally {
        off()
      }
    } finally {
      await f.close()
    }
  })
  it.each(['breakpoint', 'record-point'])(
    'stops capture reads when %s configuration changes during evaluation',
    async (mutation) => {
      const f = await fixture(() => ({ large: 'x'.repeat(100_000), value: 1 }))
      try {
        const id = await f.breakpoint('record', 4)
        f.points.set(f.session.id, [{ breakpoint_id: 'record', take: ['large', 'value'] }], [])
        f.recorder.attach(f.session)
        const reply = f.w.reply
        let changed = false
        vi.spyOn(f.w, 'reply').mockImplementation((request, body = {}, success = true) => {
          if (!changed && request.command === 'evaluate' && 'frameId' in request.arguments) {
            changed = true
            if (mutation === 'breakpoint')
              f.core.debugger.patchBreakpoints(
                f.session.id,
                f.session.snapshot.breakpoint_revision,
                [{ breakpoint_id: 'record', source_id: 'source', line: 8 }],
                []
              )
            else f.points.set(f.session.id, [], ['record'])
          }
          return reply(request, body, success)
        })
        f.fake.hit([id])
        await f.recorder.settled(f.session.id)
        await f.until(() => f.fake.running)
        expect(changed).toBe(true)
        expect(
          f.w.messages.filter((m) => m.command === 'evaluate' && 'frameId' in m.arguments)
        ).toHaveLength(1)
        expect(f.w.messages.filter((m) => m.command === 'continue')).toHaveLength(1)
      } finally {
        vi.restoreAllMocks()
        await f.close()
      }
    }
  )
  it('does not treat an uncorrelated numeric adapter id as a logical record point id', async () => {
    const f = await fixture(() => ({}))
    try {
      await f.breakpoint('9999', 4)
      f.points.set(f.session.id, [{ breakpoint_id: '9999', take: [] }], [])
      f.recorder.attach(f.session)
      f.fake.hit([9999])
      await f.recorder.settled(f.session.id)
      expect(f.w.messages.filter((m) => m.command === 'continue')).toHaveLength(0)
      expect(f.session.snapshot.threads[0]!.stop!.hit_breakpoint_ids).toEqual([])
    } finally {
      await f.close()
    }
  })
  it('updates active run points without losing earlier steps, with either configuration order', async () => {
    const f = await fixture(() => ({}))
    try {
      const first = await f.breakpoint('bp-1', 4)
      f.points.set(f.session.id, [{ breakpoint_id: 'bp-1', take: [] }], [])
      f.recorder.attach(f.session)
      const run = f.recorder.recording(f.session.id)!.run_id
      f.fake.hit([first])
      await f.until(() => f.store.read(run).steps.length === 1 && f.fake.running)
      f.session.admitSources(new Map([['second', '/project/src/service.ts']]))
      f.points.set(f.session.id, [{ breakpoint_id: 'bp-2', take: [], note: 'second' }], [])
      await f.session.patchBreakpoints(
        f.session.snapshot.breakpoint_revision,
        [{ breakpoint_id: 'bp-2', source_id: 'second', line: 9 }],
        []
      )
      expect(f.store.read(run).run.points).toEqual([
        { breakpoint_id: 'bp-1', file: 'src/page.ts', line: 4, take: [] },
        { breakpoint_id: 'bp-2', file: 'src/service.ts', line: 9, take: [], note: 'second' },
      ])
      expect(f.store.read(run).steps).toHaveLength(1)
      f.points.set(f.session.id, [{ breakpoint_id: 'bp-2', take: ['1 as n'], note: 'updated' }], [])
      expect(f.store.read(run).run.points[1]).toMatchObject({ take: ['1 as n'], note: 'updated' })
      expect(f.recorder.recording(f.session.id)!.run_id).toBe(run)
    } finally {
      await f.close()
    }
  })

  it.each(['before', 'after'])(
    'captures and resumes a second-source point hit %s its installation reply in the same turn',
    async (timing) => {
      const f = await fixture(() => ({}))
      try {
        const first = await f.breakpoint('bp-1', 4)
        f.points.set(f.session.id, [{ breakpoint_id: 'bp-1', take: [] }], [])
        f.recorder.attach(f.session)
        const run = f.recorder.recording(f.session.id)!.run_id
        f.fake.hit([first])
        await f.until(() => f.store.read(run).steps.length === 1 && f.fake.running)
        f.session.admitSources(new Map([['second', '/project/src/service.ts']]))
        f.points.set(f.session.id, [{ breakpoint_id: 'bp-2', take: [] }], [])
        const reply = f.w.reply
        vi.spyOn(f.w, 'reply').mockImplementation((request, body: any = {}, success = true) => {
          const hit =
            request.command === 'setBreakpoints' &&
            request.arguments.source.path === '/project/src/service.ts'
          if (hit && timing === 'before') f.fake.hit([body.breakpoints[0].id])
          const result = reply(request, body, success)
          if (hit && timing === 'after') f.fake.hit([body.breakpoints[0].id])
          return result
        })
        await f.session.patchBreakpoints(
          f.session.snapshot.breakpoint_revision,
          [{ breakpoint_id: 'bp-2', source_id: 'second', line: 9 }],
          []
        )
        await f.until(() => f.store.read(run).steps.length === 2 && f.fake.running)
        expect(f.store.read(run).steps[1]).toMatchObject({ point: 'bp-2' })
        expect(f.w.messages.filter((m) => m.command === 'continue')).toHaveLength(2)
      } finally {
        vi.restoreAllMocks()
        await f.close()
      }
    }
  )

  it.each(['breakpoint', 'record-point', 'new-stop'])(
    'preserves capture safety when overtaken by a %s mutation',
    async (mutation) => {
      const f = await fixture(() => ({ value: 1 }))
      try {
        const dapId = await f.breakpoint('bp-1', 4)
        f.points.set(f.session.id, [{ breakpoint_id: 'bp-1', take: ['value'] }], [])
        f.recorder.attach(f.session)
        const reply = f.w.reply
        let changed = false
        vi.spyOn(f.w, 'reply').mockImplementation((request, body = {}, success = true) => {
          if (request.command === 'stackTrace' && !changed) {
            changed = true
            if (mutation === 'breakpoint')
              f.core.debugger.patchBreakpoints(
                f.session.id,
                f.session.snapshot.breakpoint_revision,
                [{ breakpoint_id: 'bp-1', source_id: 'source', line: 8 }],
                []
              )
            else if (mutation === 'record-point') f.points.set(f.session.id, [], ['bp-1'])
            else f.fake.hit([], 'pause')
          }
          return reply(request, body, success)
        })
        f.fake.hit([dapId])
        await f.until(() => changed)
        await f.recorder.settled(f.session.id)
        if (mutation !== 'new-stop') await f.until(() => f.fake.running)
        expect(
          f.w.messages.filter((m) => m.command === 'evaluate' && 'frameId' in m.arguments)
        ).toHaveLength(0)
        expect(f.w.messages.filter((m) => m.command === 'continue')).toHaveLength(
          mutation === 'new-stop' ? 0 : 1
        )
        expect(f.session.snapshot.execution).toBe(mutation === 'new-stop' ? 'stopped' : 'running')
      } finally {
        vi.restoreAllMocks()
        await f.close()
      }
    }
  )
  it('does not attribute an external sink send to a selected server session without incoming evidence', async () => {
    const f = await fixture(() => ({}))
    try {
      await f.breakpoint('bp-1', 4)
      f.points.set(f.session.id, [{ breakpoint_id: 'bp-1', take: [] }], [])
      f.recorder.attach(f.session)
      const chain = f.recorder.chain(f.session.id, {
        method: 'GET',
        url: 'http://localhost:4399/events',
      })!
      expect(await chain.close({ label: 'GET /events', status: 404, values: [] })).toBeUndefined()
      expect(f.store.read(chain.runId).steps).toEqual([])
      const invalid = f.recorder.chain(f.session.id, { method: 'GET', url: 'invalid address' })!
      expect(await invalid.close({ label: 'Invalid address', values: [] })).toBeUndefined()
      const unrelated = f.recorder.chain(f.session.id, {
        method: 'GET',
        url: 'http://localhost:4399/events',
      })!
      f.fake.hit([f.fake.lastBreakpointId()])
      await f.until(() => f.store.read(chain.runId).steps.length === 1)
      expect(await unrelated.close({ label: 'GET /events', values: [] })).toBeUndefined()
      expect(unrelated.steps).toBe(0)
      expect(f.store.read(chain.runId).steps.map((s) => s.kind)).toEqual(['probe'])
    } finally {
      await f.close()
    }
  })

  it('keeps the first probe under its request when the answer closes during continue', async () => {
    let pending = true
    const incoming = {
      id: 'n1',
      direction: 'incoming',
      method: 'POST',
      url: 'http://localhost/carts',
      started: Date.now() - 1000,
      ended: Date.now() + 10000,
      request_headers: {},
      response_headers: {},
      request_body: '',
      response_body: '',
    }
    const f = await fixture(() => ({
      Buffer,
      [programHttpKey]: {
        drain: () => (pending ? ((pending = false), [incoming]) : []),
        stop: () => {},
      },
    }))
    try {
      const dapId = await f.breakpoint('bp-1', 4)
      f.points.set(f.session.id, [{ breakpoint_id: 'bp-1', take: [] }], [])
      f.recorder.attach(f.session)
      const chain = f.recorder.chain(f.session.id)!
      const resume = f.session.continue.bind(f.session)
      f.session.continue = async (...args) => {
        const result = await resume(...args)
        await chain.close({ label: 'POST /carts', values: [] })
        return result
      }
      f.fake.hit([dapId])
      await f.until(() => f.store.read(chain.runId).steps.some((s) => s.kind === 'probe'))
      expect(f.store.read(chain.runId).steps.find((s) => s.kind === 'probe')).toMatchObject({
        chain: chain.id,
        by_time: true,
      })
      expect(chain.steps).toBe(1)
    } finally {
      await f.close()
    }
  })

  it('flushes buffered HTTP before discarding a run when its final point is removed', async () => {
    let ready = false
    const event = {
      id: 'n1',
      direction: 'incoming',
      method: 'GET',
      url: 'http://localhost/api',
      started: Date.now(),
      ended: Date.now(),
      request_headers: {},
      response_headers: {},
      request_body: '',
      response_body: 'kept',
    }
    const f = await fixture(() => ({
      Buffer,
      [programHttpKey]: {
        drain: () => (ready ? ((ready = false), [event]) : []),
        stop: () => {
          ready = true
        },
      },
    }))
    try {
      await f.breakpoint('bp-1', 4)
      f.points.set(f.session.id, [{ breakpoint_id: 'bp-1', take: [] }], [])
      f.recorder.attach(f.session)
      const run = f.recorder.recording(f.session.id)!.run_id
      await f.recorder.settled(f.session.id)
      f.points.set(f.session.id, [], ['bp-1'])
      expect(f.recorder.recording(f.session.id)).toBeUndefined()
      await f.recorder.settled(f.session.id)
      expect(f.store.read(run)).toMatchObject({
        run: { state: 'done' },
        steps: [expect.objectContaining({ kind: 'http' })],
      })
    } finally {
      await f.close()
    }
  })

  it('persists program HTTP through DAP and correlates code steps by the request interval', async () => {
    const captured = {
      id: 'n1',
      direction: 'incoming',
      method: 'POST',
      url: 'http://localhost/api',
      started: Date.now() - 1000,
      ended: Date.now() + 1000,
      status: 201,
      request_headers: {},
      response_headers: {},
      request_body: 'input',
      response_body: 'answer',
    }
    let pending = true
    const f = await fixture(() => ({
      Buffer,
      [programHttpKey]: {
        drain: () => (pending ? ((pending = false), [captured]) : []),
        stop: () => {},
      },
    }))
    try {
      const dapId = await f.breakpoint('bp-1', 4)
      f.points.set(f.session.id, [{ breakpoint_id: 'bp-1', take: [] }], [])
      f.recorder.attach(f.session)
      const run = f.recorder.recording(f.session.id)!.run_id
      f.fake.hit([dapId])
      await f.until(() => f.store.read(run).steps.some((s) => s.kind === 'http'))
      await f.until(() => f.store.read(run).steps.some((s) => s.kind === 'probe'))
      const steps = f.store.read(run).steps
      const http = steps.find((s) => s.kind === 'http')!
      expect(http).toMatchObject({
        label: 'POST /api',
        status: 201,
        host: 'localhost',
        chain: 'n1',
      })
      expect(steps.find((s) => s.kind === 'probe')).toMatchObject({ chain: 'n1', by_time: true })
      expect(
        f.store.text(
          run,
          http.values.find((v) => v.name === 'response')!
        )
      ).toBe('answer')
      expect(
        f.w.messages.some((m) => m.command === 'evaluate' && !('frameId' in m.arguments))
      ).toBe(true)
    } finally {
      await f.close()
    }
  })

  it('ends immediately on removing the final point, discarding only empty runs', async () => {
    const f = await fixture(() => ({}))
    try {
      const dapId = await f.breakpoint('bp-1', 4)
      f.points.set(f.session.id, [{ breakpoint_id: 'bp-1', take: [] }], [])
      f.recorder.attach(f.session)
      f.points.set(f.session.id, [], ['bp-1'])
      expect(f.recorder.recording(f.session.id)).toBeUndefined()
      await new Promise((r) => setTimeout(r, 10))
      expect(f.store.list()).toEqual([])
      f.points.set(f.session.id, [{ breakpoint_id: 'bp-1', take: [] }], [])
      const run = f.recorder.recording(f.session.id)!.run_id
      f.fake.hit([dapId])
      await f.until(() => f.store.read(run).steps.length === 1)
      f.points.set(f.session.id, [], ['bp-1'])
      expect(f.recorder.recording(f.session.id)).toBeUndefined()
      await f.until(() => f.store.read(run).run.state === 'done')
      expect(f.store.read(run).steps).toHaveLength(1)
    } finally {
      await f.close()
    }
  })

  it('discards an empty run when the session ends', async () => {
    const f = await fixture(() => ({}))
    try {
      await f.breakpoint('bp-1', 4)
      f.points.set(f.session.id, [{ breakpoint_id: 'bp-1', take: [] }], [])
      f.recorder.attach(f.session)()
      await new Promise((r) => setTimeout(r, 10))
      expect(f.store.list()).toEqual([])
    } finally {
      await f.close()
    }
  })

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
      await f.close()
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
      // Global HTTP instrumentation is independent of the empty take list.
      expect(
        f.w.messages.filter((m) => m.command === 'evaluate' && 'frameId' in m.arguments)
      ).toEqual([])
      expect(asked.filter((c) => c === 'continue')).toHaveLength(1)
    } finally {
      await f.close()
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
      await f.close()
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
      await f.close()
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
      await f.close()
    }
  })

  it('keeps the run when the program ends, and marks it cut when the connection goes', async () => {
    const f = await fixture(() => ({}))
    try {
      const dapId = await f.breakpoint('bp-1', 4)
      f.points.set(f.session.id, [{ breakpoint_id: 'bp-1', take: [] }], [])
      f.recorder.attach(f.session)
      const run = f.recorder.recording(f.session.id)!.run_id
      f.fake.hit([dapId])
      await f.until(() => f.store.read(run).steps.length === 1)
      expect(f.store.read(run).run.points).toEqual([
        { breakpoint_id: 'bp-1', file: 'src/page.ts', line: 4, take: [] },
      ])
      f.w.dap.close()
      await f.until(() => f.store.read(run).run.state !== 'recording')
      expect(f.store.read(run).run.state).toBe('cut')
      expect(f.recorder.recording(f.session.id)).toBeUndefined()
    } finally {
      await f.close()
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
      await f.close()
    }
  })
})
