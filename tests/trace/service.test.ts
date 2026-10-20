import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DapDebuggerBackend, NodeCore } from '../../packages/node-core/src/index.js'
import { DapSession } from '../../packages/node-core/src/debugger/driver.js'
import { TraceClient } from '../../packages/node-client/src/trace.js'
import { wire } from '../debugger/dap-wire.js'
import { target } from '../debugger/helpers.js'
import { adapter } from './adapter.js'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function setup(frame: () => Record<string, unknown>, enabled = true) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'trace-service-')))
  dirs.push(dir)
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  spawnSync('/usr/bin/git', ['init', '-q', '-b', 'main'], { cwd: repo })
  const core = new NodeCore(join(dir, 'state'), { debuggerEnabled: enabled })
  const actor = core.authority.authenticate(core.createToken('test').token)
  const request = (method: string, p: unknown) =>
    core.request(actor, method, p, crypto.randomUUID()) as any
  const project = (await request('project.register', { path: repo, trust: 'trusted' })) as {
    project_id: string
  }
  return { dir, repo, core, request, project_id: project.project_id, frame }
}

async function live(s: Awaited<ReturnType<typeof setup>>) {
  const w = wire()
  const fake = adapter(w, s.frame, s.repo)
  const state = s.core.debugger.create({
    ...target,
    project_id: s.project_id,
    build_identity: 'matched',
  })
  const session = new DapSession(
    s.core.debugger,
    state,
    w.dap,
    new Map([['source', join(s.repo, 'src/page.ts')]])
  )
  await session.start('attach', { type: 'pwa-node', port: 1 })
  const off = s.core.debuggerControl.registerBackend(session.id, new DapDebuggerBackend(session))
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 500 && !check(); i++) await new Promise((r) => setTimeout(r, 2))
    expect(check()).toBe(true)
  }
  const point = async (id: string, line: number, take: string[], note?: string) => {
    s.request('trace.v1.points.set', {
      debug_session_id: session.id,
      upsert: [{ breakpoint_id: id, take, ...(note ? { note } : {}) }],
      remove: [],
    })
    await session.patchBreakpoints(
      session.snapshot.breakpoint_revision,
      [{ breakpoint_id: id, source_id: 'source', line }],
      []
    )
    return fake.lastBreakpointId()
  }
  return {
    w,
    fake,
    session,
    until,
    point,
    close() {
      off()
      fake.stop()
      w.dap.close()
    },
  }
}

describe('recorded runs through the node', () => {
  it('links a handler step when its request completes later, including the HTTP-only view', async () => {
    const s = await setup(() => ({}))
    try {
      const store = s.core.trace.store(s.project_id)
      const writer = store.create({ session: 'fixture', points: [] })
      writer.append({ kind: 'probe', at: 20, label: 'handler', values: [] })
      writer.append({
        kind: 'probe',
        at: 1000,
        label: 'unrelated',
        chain: 'unconfirmed-send',
        by_time: true,
        values: [],
      })
      writer.append({
        kind: 'http',
        at: 10,
        label: 'GET /api',
        direction: 'incoming',
        duration_ms: 50,
        chain: 'n1',
        status: 200,
        values: [],
      })
      writer.close('done', 100)
      const p = { project_id: s.project_id, run_id: writer.id }
      const run = s.request('trace.v1.run', p)
      expect(run.steps.find((step: any) => step.kind === 'probe')).toMatchObject({
        chain: 'n1',
        by_time: true,
      })
      expect(run.steps.find((step: any) => step.label === 'unrelated').chain).toBeUndefined()
      expect(s.request('trace.v1.run', { ...p, kind: ['http'] }).steps).toEqual([
        expect.objectContaining({ kind: 'http', direction: 'incoming', status: 200 }),
      ])
    } finally {
      s.core.close()
    }
  })

  it('returns recording null immediately after the last point becomes a normal breakpoint', async () => {
    const s = await setup(() => ({}))
    const l = await live(s)
    try {
      await l.point('bp-1', 4, [])
      expect(
        s.request('trace.v1.status', { debug_session_id: l.session.id }).recording
      ).not.toBeNull()
      s.request('trace.v1.points.set', {
        debug_session_id: l.session.id,
        upsert: [],
        remove: ['bp-1'],
      })
      expect(s.request('trace.v1.status', { debug_session_id: l.session.id }).recording).toBeNull()
      expect(l.session.snapshot.breakpoints).toHaveLength(1)
      await s.core.trace.recorder.settled(l.session.id)
      expect(s.request('trace.v1.runs', { project_id: s.project_id }).runs).toEqual([])
    } finally {
      l.close()
      s.core.close()
    }
  })

  it('is not offered where the debugger is off', async () => {
    const s = await setup(() => ({}), false)
    try {
      expect(() => s.request('trace.v1.runs', { project_id: s.project_id })).toThrow(
        /unsupported_method/
      )
      expect(s.core.capabilities().capabilities).not.toHaveProperty('trace_v1')
    } finally {
      s.core.close()
    }
  })

  it('records a run while a record point is set and reads it back in bounded views', async () => {
    let n = 0
    const s = await setup(() => ({
      get result() {
        return {
          id: 'C-100',
          items: Array.from({ length: 3 }, (_, i) => ({ amount: String(i + n) })),
        }
      },
    }))
    const l = await live(s)
    try {
      expect(s.core.capabilities().capabilities).toHaveProperty('trace_v1')
      const status = s.request('trace.v1.status', { debug_session_id: l.session.id })
      expect(status.folder).toBe(join(s.repo, '.abele/runs'))
      expect(status.chosen).toBe(false)
      const dapId = await l.point('bp-1', 4, ['result'], 'Contract read')
      const recording = s.request('trace.v1.status', { debug_session_id: l.session.id }).recording
      expect(recording).toMatchObject({ steps: 0 })
      // The runs folder keeps itself out of the project's commits.
      expect(readFileSync(join(s.repo, '.abele/runs/.gitignore'), 'utf8')).toBe('*\n')

      l.fake.hit([dapId])
      await l.until(() => l.fake.running)
      n = 5
      l.fake.hit([dapId])
      await l.until(() => s.core.trace.recorder.recording(l.session.id)?.steps === 2)
      await l.until(() => l.fake.running)

      const runs = s.request('trace.v1.runs', { project_id: s.project_id }).runs
      expect(runs).toHaveLength(1)
      const run = s.request('trace.v1.run', { project_id: s.project_id, run_id: runs[0].id })
      expect(run.points).toEqual([
        expect.objectContaining({ breakpoint_id: 'bp-1', file: 'src/page.ts', line: 4, hits: 2 }),
      ])
      expect(run.steps.map((x: any) => x.label)).toEqual(['Contract read', 'Contract read'])
      expect(run.steps[0].values[0]).toMatchObject({
        name: 'result',
        format: 'json',
        brief: '{ id: "C-100", items: 3 }',
      })

      const shape = s.request('trace.v1.value', {
        project_id: s.project_id,
        run_id: run.run.id,
        step: 't0001',
        name: 'result',
        view: 'shape',
      })
      expect(shape.shape.children.map((c: any) => c.key)).toEqual(['id', 'items'])
      const slice = s.request('trace.v1.value', {
        project_id: s.project_id,
        run_id: run.run.id,
        step: 't0002',
        name: 'result',
        view: 'slice',
        path: '$.items[0].amount',
      })
      expect(slice.page.lines).toEqual(['"5"'])
      const changes = s.request('trace.v1.value', {
        project_id: s.project_id,
        run_id: run.run.id,
        step: 't0002',
        name: 'result',
        view: 'changes',
      })
      expect(changes.changes.against).toEqual({ step: 't0001', name: 'result' })
      expect(changes.changes.summary).toMatch(/changed value/)

      expect(
        s.request('trace.v1.find', { project_id: s.project_id, run_id: run.run.id, value: 'C-100' })
          .hits
      ).toEqual([
        { step: 't0001', name: 'result', path: '$.id' },
        { step: 't0002', name: 'result', path: '$.id' },
      ])
      const trail = s.request('trace.v1.follow', {
        project_id: s.project_id,
        run_id: run.run.id,
        value: 'C-100',
      })
      expect(trail.stops.map((x: any) => x.step)).toEqual(['t0001', 't0002'])

      s.request('trace.v1.mark', {
        project_id: s.project_id,
        run_id: run.run.id,
        step: 't0002',
        name: 'result',
        path: '$.items',
        comment: 'amounts shift here',
        tags: ['question'],
      })
      // The typed client reads the same answers through the protocol's schemas.
      const client = new TraceClient(async (method, params) => s.request(method, params))
      expect((await client.runs(s.project_id)).runs[0]!.id).toBe(run.run.id)
      expect(
        (await client.run({ project_id: s.project_id, run_id: run.run.id })).steps
      ).toHaveLength(2)
      expect(
        (
          await client.value({
            project_id: s.project_id,
            run_id: run.run.id,
            step: 't0001',
            name: 'result',
            view: 'page',
          })
        ).page!.lines[0]
      ).toBe('{')
      expect(await client.status(l.session.id)).toMatchObject({ recording: { steps: 2 } })
      const marked = s.request('trace.v1.run', { project_id: s.project_id, run_id: run.run.id })
      expect(marked.steps[1].marked).toBe(true)
      expect(marked.marks[0]).toMatchObject({ comment: 'amounts shift here', tags: ['question'] })
    } finally {
      l.close()
      s.core.close()
    }
  })

  it('answers plainly about what is not there, without dropping the connection', async () => {
    const s = await setup(() => ({}))
    try {
      expect(() =>
        s.request('trace.v1.run', { project_id: s.project_id, run_id: 'missing-run' })
      ).toThrow(/trace_run_not_found/)
      expect(() =>
        s.request('trace.v1.run', { project_id: s.project_id, run_id: '../escape' })
      ).toThrow(/invalid_params/)
      expect(() => s.request('trace.v1.runs', { project_id: 'no-such-project' })).toThrow(
        /not_found/
      )
    } finally {
      s.core.close()
    }
  })

  it('writes runs where the owner chose, renames and deletes them', async () => {
    const s = await setup(() => ({ v: 1 }))
    const chosen = join(s.dir, 'chosen-runs')
    expect(s.request('trace.v1.folder.set', { project_id: s.project_id, folder: chosen })).toEqual({
      folder: chosen,
      chosen: true,
    })
    const l = await live(s)
    try {
      const dapId = await l.point('bp-1', 4, ['v'])
      l.fake.hit([dapId])
      await l.until(() => s.core.trace.recorder.recording(l.session.id)?.steps === 1)
      const [run] = s.request('trace.v1.runs', { project_id: s.project_id }).runs
      expect(existsSync(join(chosen, run.id, 'timeline.jsonl'))).toBe(true)
      s.request('trace.v1.rename', { project_id: s.project_id, run_id: run.id, name: 'Toggle on' })
      expect(s.request('trace.v1.runs', { project_id: s.project_id }).runs[0].name).toBe(
        'Toggle on'
      )
      l.close()
      s.request('trace.v1.delete', { project_id: s.project_id, run_id: run.id })
      expect(existsSync(join(chosen, run.id))).toBe(false)
      expect(
        s.request('trace.v1.folder.set', { project_id: s.project_id, folder: '' }).chosen
      ).toBe(false)
    } finally {
      l.close()
      s.core.close()
    }
  })
})
