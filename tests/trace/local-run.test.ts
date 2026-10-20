import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OwnedDebugProcess } from '../../packages/node-core/src/debugger/process.js'
import ts from 'typescript'
import { NodeCore } from '../../packages/node-core/src/index.js'
import { JS_DEBUG_PIN, unpackJsAdapter } from '../../packages/node-core/src/debugger/js-install.js'

// Runs real programs under the pinned js-debug. Opt-in like tests/debugger/local-js.test.ts:
// install the adapter into the scratch state first (docs/debugger-js-profile.md).
const scratch = resolve('.scratch/debugger-integration')
const archive = JS_DEBUG_PIN
  ? join(scratch, 'state/debugger/adapters/js-debug', JS_DEBUG_PIN.version, 'archive.tar.gz')
  : ''
const enabled = process.env.ABELE_DEBUGGER_LOCAL_TEST === '1' && !!archive && existsSync(archive)

const dirs: string[] = []
const cores: NodeCore[] = []
afterEach(async () => {
  for (const core of cores.splice(0)) {
    await core.debuggerLaunches.close()
    await core.execution.stop()
    await core.resources.stop()
    core.close()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  vi.restoreAllMocks()
})

async function setup(files: Record<string, string>) {
  mkdirSync(scratch, { recursive: true })
  const dir = realpathSync(mkdtempSync(join(scratch, 'run-')))
  dirs.push(dir)
  const folder = join(dir, 'folder')
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(folder, path, '..'), { recursive: true })
    writeFileSync(join(folder, path), text)
  }
  const state = join(dir, 'state')
  await unpackJsAdapter(
    join(state, 'debugger/adapters/js-debug', JS_DEBUG_PIN!.version),
    JS_DEBUG_PIN!,
    readFileSync(archive)
  )
  const core = new NodeCore(state, { debuggerEnabled: true })
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  const request = async (method: string, p: any) =>
    (await core.request(actor, method, p, p.operation_id ?? crypto.randomUUID())) as any
  const project = await request('project.register', { path: folder, trust: 'trusted' })
  const [workspace] = await request('workspace.list', { project_id: project.project_id })
  const target = { kind: 'workspace', workspace_id: workspace.workspace_id }
  await request('project.execution', { project_id: project.project_id, target, enabled: true })
  const chat = await request('session.create', { provider: 'fake', target })
  const until = async (check: () => boolean | Promise<boolean>, ms = 15000) => {
    const end = Date.now() + ms
    while (!(await check())) {
      if (Date.now() > end) throw new Error('local_run_timeout')
      await new Promise((r) => setTimeout(r, 25))
    }
  }
  return { core, request, folder, project, chat, until }
}

/** Starts `program`, sets one record point taking `take` on `line` of `source`, lets the program
 * go and answers with the steps of the run it left. */
async function record(
  s: Awaited<ReturnType<typeof setup>>,
  program: string,
  source: string,
  line: number,
  take: string[]
) {
  const started = await s.request('debugger.v1.start', {
    operation_id: crypto.randomUUID(),
    conversation_id: s.chat.session_id,
    program,
    sources: [source],
  })
  const id = started.debug_session_id
  const source_id = started.sources.find((x: any) => x.path === source).source_id
  const snapshot = async () =>
    (await s.request('debugger.v1.status', { debug_session_id: id })).snapshot
  // Held on its first line until the record point is in.
  await s.until(async () => (await snapshot()).threads.some((t: any) => t.status === 'stopped'))
  await s.request('trace.v1.points.set', {
    debug_session_id: id,
    upsert: [{ breakpoint_id: 'bp-1', take }],
    remove: [],
  })
  let snap = await snapshot()
  const patched = await s.request('debugger.v1.breakpoints.patch', {
    debug_session_id: id,
    incarnation: snap.incarnation,
    expected_state_revision: snap.state_revision,
    operation_id: crypto.randomUUID(),
    expected_breakpoint_revision: snap.breakpoint_revision,
    upsert: [{ breakpoint_id: 'bp-1', source_id, line }],
    remove: [],
  })
  expect(patched.outcome).toBe('completed')
  await s.until(async () =>
    (await snapshot()).breakpoints.some((b: any) => b.status === 'verified')
  )
  snap = await snapshot()
  await s.request('debugger.v1.continue', {
    debug_session_id: id,
    incarnation: snap.incarnation,
    expected_state_revision: snap.state_revision,
    operation_id: crypto.randomUUID(),
    thread_id: snap.threads.find((t: any) => t.status === 'stopped').thread_id,
  })
  let runs: any[] = []
  await s.until(async () => {
    runs = (await s.request('trace.v1.runs', { project_id: s.project.project_id })).runs
    return runs.length === 1 && runs[0].state !== 'recording'
  })
  const run = await s.request('trace.v1.run', {
    project_id: s.project.project_id,
    run_id: runs[0].id,
  })
  return { run, runId: runs[0].id }
}

const valueOf = async (s: any, runId: string, step: string, name: string) =>
  (
    await s.request('trace.v1.value', {
      project_id: s.project.project_id,
      run_id: runId,
      step,
      name,
      view: 'page',
    })
  ).page.lines
    .map((l: any) => (typeof l === 'string' ? l : l.text))
    .join('\n')

describe.skipIf(!enabled)('real programs under the pinned js-debug', () => {
  it('adds a second-source point during an active recording and keeps the program running', async () => {
    // Match local-scopes.test.ts: restricted runners can replace ps identity
    // discovery while still exercising real direct children and the real adapter.
    if (process.env.ABELE_DEBUGGER_TEST_IDENTITY === 'fixture') {
      const spawn = OwnedDebugProcess.spawn.bind(OwnedDebugProcess)
      vi.spyOn(OwnedDebugProcess, 'spawn').mockImplementation((exe, argv, options) =>
        spawn(
          exe,
          argv,
          {
            ...options,
            env: { ...options.env, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}) },
          },
          async () => 'trace-second-point-fixture'
        )
      )
    }
    const s = await setup({
      'app.cjs': [
        "const { second } = require('./second.cjs')",
        'function first(n) {',
        '  return n',
        '}',
        'let n = 0',
        'const timer = setInterval(() => { first(n); second(n++); if (n === 200) clearInterval(timer) }, 50)',
      ].join('\n'),
      'second.cjs': ['exports.second = function second(n) {', '  return n * 2', '}'].join('\n'),
    })
    const started = await s.request('debugger.v1.start', {
      operation_id: crypto.randomUUID(),
      conversation_id: s.chat.session_id,
      program: 'app.cjs',
      sources: ['second.cjs'],
    })
    const id = started.debug_session_id
    const snapshot = async () =>
      (await s.request('debugger.v1.status', { debug_session_id: id })).snapshot
    await s.until(async () => (await snapshot()).execution === 'stopped')
    const point = async (breakpoint_id: string, path: string, line: number) => {
      await s.request('trace.v1.points.set', {
        debug_session_id: id,
        upsert: [{ breakpoint_id, take: ['n'] }],
        remove: [],
      })
      await s.until(async () => {
        const state = await snapshot()
        const result = await s.request('debugger.v1.breakpoints.patch', {
          debug_session_id: id,
          incarnation: state.incarnation,
          expected_state_revision: state.state_revision,
          expected_breakpoint_revision: state.breakpoint_revision,
          operation_id: crypto.randomUUID(),
          remove: [],
          upsert: [
            {
              breakpoint_id,
              source_id: started.sources.find((x: any) => x.path === path).source_id,
              line,
            },
          ],
        })
        if (result.outcome === 'completed') return true
        expect(result.code).toBe('stale_state')
        return false
      })
    }
    await point('first', 'app.cjs', 3)
    const paused = await snapshot()
    await s.request('debugger.v1.continue', {
      debug_session_id: id,
      incarnation: paused.incarnation,
      expected_state_revision: paused.state_revision,
      operation_id: crypto.randomUUID(),
      thread_id: paused.selected_thread_id,
    })
    let runId = ''
    const read = async () => {
      const runs = (await s.request('trace.v1.runs', { project_id: s.project.project_id })).runs
      if (!runs.length) return undefined
      runId = runs[0].id
      return s.request('trace.v1.run', { project_id: s.project.project_id, run_id: runId })
    }
    await s.until(
      async () => ((await read())?.steps.filter((x: any) => x.point === 'first').length ?? 0) >= 2
    )
    const prior = (await read()).steps[0]
    const originalRun = runId
    await point('second', 'second.cjs', 2)
    await s.until(
      async () => ((await read())?.steps.filter((x: any) => x.point === 'second').length ?? 0) >= 3
    )
    await s.until(async () => (await snapshot()).execution === 'running')
    const run = await read()
    expect(runId).toBe(originalRun)
    expect(run.steps[0]).toEqual(prior)
    expect(run.points.map((p: any) => p.breakpoint_id)).toEqual(['first', 'second'])
    expect(run.run.state).toBe('recording')
  }, 30000)
  it('records the debugged server and its fetch, linking handler steps in the requests contract', async () => {
    const s = await setup({
      'server.cjs': [
        "const http = require('node:http')",
        'const server = http.createServer((req, res) => {',
        "  const answer = 'recorded-response'",
        '  res.end(answer)',
        '})',
        "server.listen(0, '127.0.0.1', async () => {",
        '  const response = await fetch(`http://127.0.0.1:${server.address().port}/api`)',
        '  await response.text()',
        '  setTimeout(() => server.close(), 1200)',
        '})',
      ].join('\n'),
    })
    const { run, runId } = await record(s, 'server.cjs', 'server.cjs', 4, ['answer'])
    const requests = run.steps.filter((step: any) => step.kind === 'http')
    expect(requests.map((r: any) => r.direction).sort()).toEqual(['incoming', 'outgoing'])
    const incoming = requests.find((r: any) => r.direction === 'incoming')
    expect(run.steps.find((step: any) => step.kind === 'probe')).toMatchObject({
      chain: incoming.chain,
      by_time: true,
    })
    expect(await valueOf(s, runId, incoming.id, 'response')).toBe('recorded-response')
    const filtered = await s.request('trace.v1.run', {
      project_id: s.project.project_id,
      run_id: runId,
      kind: ['http'],
    })
    expect(filtered.steps).toHaveLength(2)
  }, 60000)

  it('records a changing function argument at repeated timer hits', async () => {
    const s = await setup({
      'inspect.js': [
        'function inspectItem(n) {',
        '  return n',
        '}',
        'let n = 0',
        'const timer = setInterval(() => {',
        '  inspectItem(n++)',
        '  if (n === 7) clearInterval(timer)',
        '}, 200)',
      ].join('\n'),
    })
    const { run, runId } = await record(s, 'inspect.js', 'inspect.js', 2, ['n'])
    const probes = run.steps.filter((x: any) => x.kind === 'probe')
    expect(probes).toHaveLength(7)
    const values = []
    for (const p of probes) values.push(await valueOf(s, runId, p.id, 'n'))
    expect(values).toEqual(['0', '1', '2', '3', '4', '5', '6'])
  }, 60000)
  it('records what a point takes at each hit of a JavaScript program', async () => {
    const s = await setup({
      'src/total.js': [
        'function total(items) {',
        '  let sum = 0',
        '  for (const item of items) {',
        '    sum += item.price',
        '  }',
        '  return sum',
        '}',
        'console.log(total([{ price: 2 }, { price: 3 }, { price: 5 }]))',
        '',
      ].join('\n'),
    })
    const { run, runId } = await record(s, 'src/total.js', 'src/total.js', 4, ['item', 'sum'])
    const probes = run.steps.filter((x: any) => x.kind === 'probe')
    expect(probes).toHaveLength(3)
    expect(probes.map((x: any) => x.place?.line)).toEqual([4, 4, 4])
    expect(run.points[0]).toMatchObject({ breakpoint_id: 'bp-1', hits: 3 })
    const sums = []
    for (const p of probes) sums.push(await valueOf(s, runId, p.id, 'sum'))
    expect(sums).toEqual(['0', '2', '5'])
    expect(await valueOf(s, runId, probes[2].id, 'item')).toContain('5')
  }, 60000)

  it('records at a line of TypeScript through the source map its build left', async () => {
    const source = [
      'type Item = { price: number }',
      '',
      'function total(items: Item[]): number {',
      '  let sum: number = 0',
      '  for (const item of items) {',
      '    sum += item.price',
      '  }',
      '  return sum',
      '}',
      'console.log(total([{ price: 2 }, { price: 3 }, { price: 5 }]))',
      '',
    ].join('\n')
    const built = ts.transpileModule(source, {
      fileName: 'total.ts',
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        sourceMap: true,
        sourceRoot: '',
      },
    })
    const map = JSON.parse(built.sourceMapText!)
    map.file = 'total.js'
    map.sources = ['../src/total.ts']
    const s = await setup({
      'src/total.ts': source,
      'dist/total.js':
        built.outputText.replace(/\/\/# sourceMappingURL=.*$/m, '') +
        '\n//# sourceMappingURL=total.js.map\n',
      'dist/total.js.map': JSON.stringify(map),
    })
    const { run, runId } = await record(s, 'dist/total.js', 'src/total.ts', 6, ['item', 'sum'])
    const probes = run.steps.filter((x: any) => x.kind === 'probe')
    expect(probes).toHaveLength(3)
    expect(probes[0].place).toMatchObject({ line: 6 })
    expect(probes[0].place.file).toMatch(/total\.ts$/)
    const sums = []
    for (const p of probes) sums.push(await valueOf(s, runId, p.id, 'sum'))
    expect(sums).toEqual(['0', '2', '5'])
  }, 60000)
})
