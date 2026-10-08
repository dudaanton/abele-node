// Explicit B0 check only: real adapters, synthetic programs; never calls an LLM.
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createConnection, createServer } from 'node:net'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Dap } from './debug-dap.mjs'
import { ProbeRuntime } from './debug-runtime.mjs'
import { initialize, configure, startConfigured, inspectAndStep } from './debug-check.mjs'

const root = resolve('.')
const scratch = resolve('.scratch')
const evidence = resolve(scratch, 'evidence')
await mkdir(evidence, { recursive: true })
const runtime = new ProbeRuntime()
const owned = runtime.children
const transcript = []
let label = ''
const log = (session) => (direction, message) =>
  transcript.push({ scenario: label, session, direction, message })
const sleep = (ms) => runtime.pause(ms)
function start(command, args, options = {}) {
  return runtime.start(command, args, {
    ...options,
    env: { ...process.env, TMPDIR: scratch, ...options.env },
  })
}
async function until(check, description) {
  for (let i = 0; i < 300; i++) {
    const value = check()
    if (value) return value
    await sleep(50)
  }
  throw new Error(`timeout: ${description}`)
}
async function connect(port) {
  runtime.check()
  const socket = runtime.trackSocket(createConnection({ host: '127.0.0.1', port }))
  await once(socket, 'connect')
  return socket
}
async function freePort() {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address()
  await new Promise((r) => server.close(r))
  return port
}
function alive(child) {
  return child.exitCode === null && child.signalCode === null
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function jsSession(port, source, line, config, reverseEnabled = true) {
  const children = []
  const reverse = async (request) => {
    if (!reverseEnabled) throw new Error('B0 red: child sessions not implemented')
    if (request.command === 'runInTerminal') {
      const { args, cwd, env } = request.arguments
      const child = start(args[0], args.slice(1), { cwd, env })
      return { processId: child.pid }
    }
    assert.equal(request.command, 'startDebugging')
    const { configuration, request: mode } = request.arguments
    assert.ok(configuration.__pendingTargetId)
    const socket = await connect(port)
    const child = runtime.trackDap(
      new Dap(socket, socket, { log: log(configuration.__pendingTargetId), reverse })
    )
    await initialize(child, 'pwa-node')
    await configure(child, source, line, ['all'])
    await child.request(mode, configuration)
    children.push(child)
    return {}
  }
  const socket = await connect(port)
  const dap = runtime.trackDap(new Dap(socket, socket, { reverse, log: log('root') }))
  const capabilities = await initialize(dap, 'pwa-node')
  await configure(dap, source, line, ['all'])
  const { request = 'launch', ...args } = config
  await dap.request(request, { ...args, request })
  const child = await until(() => children[0], 'startDebugging child session')
  return { root: dap, dap: child, capabilities, children }
}

async function jsCheck(port, kind, mode, terminal = false) {
  label = `${kind}-${mode}${terminal ? '-terminal' : ''}`
  const source = resolve(root, `probes/fixtures/debug-program.${kind === 'ts' ? 'ts' : 'cjs'}`)
  const program = kind === 'ts' ? resolve(scratch, 'compiled/debug-program.js') : source
  const line =
    (await readFile(source, 'utf8')).split('\n').findIndex((l) => l.includes('// BREAKPOINT')) + 1
  let debuggee
  let config = {
    type: 'pwa-node',
    name: label,
    program,
    cwd: root,
    sourceMaps: true,
    pauseForSourceMap: true,
    stopOnEntry: true,
    smartStep: false,
    outFiles: [resolve(scratch, 'compiled/**/*.js')],
    runtimeExecutable: process.execPath,
    console: terminal ? 'integratedTerminal' : 'internalConsole',
    env: mode === 'terminate' ? {} : { PROBE_TEST: '1' },
  }
  if (mode === 'attach') {
    debuggee = start(process.execPath, ['--inspect-brk=127.0.0.1:0', program])
    const inspectorPort = Number(
      (await until(() => /ws:\/\/127\.0\.0\.1:(\d+)/.exec(debuggee.text), 'Node inspector'))[1]
    )
    config = {
      type: 'pwa-node',
      name: label,
      request: 'attach',
      address: '127.0.0.1',
      port: inspectorPort,
      cwd: root,
      sourceMaps: true,
      outFiles: [resolve(scratch, 'compiled/**/*.js')],
      restart: false,
      continueOnAttach: false,
      smartStep: false,
    }
  }
  const session = await jsSession(port, source, line, config, !process.env.PROBE_NO_CHILD)
  const { dap } = session
  const verified = await dap.event(
    'breakpoint',
    (e) => e.body.breakpoint.verified === true && e.body.breakpoint.line === line
  )
  let entryCursor = 0
  {
    const initial = await dap.event('stopped')
    if (initial.body.reason !== 'breakpoint') {
      assert.ok(
        ['pause', 'entry', 'step'].includes(initial.body.reason),
        `unexpected startup stop: ${initial.body.reason}`
      )
      // --inspect-brk stops at entry; wait for TS breakpoint binding before resuming.
      await dap.event('breakpoint', (e) => e.body.breakpoint.verified === true)
      entryCursor = dap.cursor
      await dap.request('continue', { threadId: initial.body.threadId })
    }
  }
  const inspection = await inspectAndStep(dap, source, line, 'input + 2', '42', entryCursor)
  const frameId = inspection.next.id
  const pid = await dap.request('evaluate', { frameId, expression: 'process.pid', context: 'repl' })
  if (debuggee) {
    assert.equal(
      pid.result,
      String(debuggee.pid),
      'attach must inspect the pre-existing process, not launch another'
    )
  }
  const getter = await dap.request('evaluate', {
    frameId,
    expression: 'globalThis.getterCalls',
    context: 'repl',
  })
  assert.equal(getter.result, '0')
  const object = inspection.nextVariables.find((v) => v.name === 'object')
  assert.ok(object?.variablesReference)
  const properties = await dap.request('variables', {
    variablesReference: object.variablesReference,
  })
  const afterInspect = await dap.request('evaluate', {
    frameId,
    expression: 'globalThis.getterCalls',
    context: 'repl',
  })
  assert.equal(afterInspect.result, '0')
  await dap.request('evaluate', { frameId, expression: 'object.computed', context: 'repl' })
  const afterEvaluate = await dap.request('evaluate', {
    frameId,
    expression: 'globalThis.getterCalls',
    context: 'repl',
  })
  assert.equal(afterEvaluate.result, '1')
  await dap.request('setBreakpoints', { source: { path: source }, breakpoints: [] })
  let cursor = dap.cursor
  await dap.request('continue', { threadId: inspection.threadId })
  const exception = await dap.event('stopped', (e) => e.body.reason === 'exception', cursor)
  const exceptionInfo = await dap.request('exceptionInfo', { threadId: exception.body.threadId })
  await dap.request('setExceptionBreakpoints', { filters: [] })
  cursor = dap.cursor
  await dap.request('continue', { threadId: exception.body.threadId })
  if (mode === 'attach') {
    await until(() => debuggee.text.includes('HEARTBEAT'), 'attached heartbeat')
    await dap.request('disconnect', { terminateDebuggee: false })
    await session.root.request('disconnect', { terminateDebuggee: false })
    const before = debuggee.text.length
    await sleep(300)
    assert.ok(alive(debuggee))
    assert.ok(debuggee.text.length > before)
  } else if (mode === 'terminate') {
    assert.ok(pidAlive(Number(pid.result)))
    await dap.request('disconnect', { terminateDebuggee: true })
    await session.root.request('disconnect', { terminateDebuggee: true })
    await until(() => !pidAlive(Number(pid.result)), 'owned Node debuggee termination')
  } else {
    await dap.event('terminated', () => true, cursor)
    await dap.request('disconnect', { terminateDebuggee: true })
    await session.root.request('disconnect', { terminateDebuggee: true })
  }
  return {
    scenario: label,
    capabilities: session.capabilities,
    verifiedBreakpoint: verified.body.breakpoint,
    inspection,
    properties,
    getter: {
      before: getter.result,
      afterInspect: afterInspect.result,
      afterEvaluate: afterEvaluate.result,
    },
    exception: exception.body,
    exceptionInfo,
    detachAlive: debuggee ? alive(debuggee) : undefined,
    terminatedOwnedProcess: mode === 'terminate' ? !pidAlive(Number(pid.result)) : undefined,
  }
}

async function pythonCheck(mode) {
  label = `python-${mode}`
  const python = resolve(scratch, 'adapters/venv/bin/python')
  const source = resolve(root, 'probes/fixtures/debug-program.py')
  const line =
    (await readFile(source, 'utf8')).split('\n').findIndex((l) => l.includes('# BREAKPOINT')) + 1
  let debuggee
  let dap
  if (mode !== 'attach') {
    const adapter = start(python, ['-m', 'debugpy.adapter'])
    dap = runtime.trackDap(new Dap(adapter.stdout, adapter.stdin, { log: log('stdio') }))
  } else {
    const port = await freePort()
    debuggee = start(python, [
      '-m',
      'debugpy',
      '--listen',
      `127.0.0.1:${port}`,
      '--wait-for-client',
      source,
    ])
    // debugpy's listener is a DAP adapter, not a raw Python inspector.
    let socket
    for (let i = 0; i < 100; i++) {
      try {
        socket = await connect(port)
        break
      } catch {
        await sleep(50)
      }
    }
    assert.ok(socket)
    dap = runtime.trackDap(new Dap(socket, socket, { log: log('tcp') }))
  }
  const capabilities = await initialize(dap, 'debugpy')
  const breakpoint = await startConfigured(
    dap,
    mode === 'attach' ? 'attach' : 'launch',
    mode !== 'attach'
      ? {
          program: source,
          python,
          cwd: root,
          console: 'internalConsole',
          env: mode === 'terminate' ? {} : { PROBE_TEST: '1' },
          justMyCode: true,
        }
      : { justMyCode: true },
    () => configure(dap, source, line, ['raised'])
  )
  // Both promises were observed before waiting; debugpy replies after configurationDone.
  assert.equal(breakpoint.verified, true)
  const inspection = await inspectAndStep(dap, source, line, 'value + 2', '42')
  const frameId = inspection.next.id
  const pid = await dap.request('evaluate', {
    frameId,
    expression: '__import__("os").getpid()',
    context: 'repl',
  })
  if (debuggee) assert.equal(pid.result, String(debuggee.pid))
  const before = await dap.request('evaluate', {
    frameId,
    expression: 'getter_calls',
    context: 'repl',
  })
  const object = inspection.nextVariables.find((v) => v.name === 'obj')
  assert.ok(object?.variablesReference)
  const properties = await dap.request('variables', {
    variablesReference: object.variablesReference,
  })
  const after = await dap.request('evaluate', {
    frameId,
    expression: 'getter_calls',
    context: 'repl',
  })
  assert.equal(before.result, '0')
  assert.equal(after.result, '1', 'default debugpy object expansion invokes the synthetic property')
  await dap.request('setBreakpoints', { source: { path: source }, breakpoints: [] })
  let cursor = dap.cursor
  await dap.request('continue', { threadId: inspection.threadId })
  const exception = await dap.event('stopped', (e) => e.body.reason === 'exception', cursor)
  const exceptionInfo = await dap.request('exceptionInfo', { threadId: exception.body.threadId })
  await dap.request('setExceptionBreakpoints', { filters: [] })
  cursor = dap.cursor
  await dap.request('continue', { threadId: exception.body.threadId })
  if (mode === 'attach') {
    await until(() => debuggee.text.includes('HEARTBEAT'), 'Python heartbeat')
    await dap.request('disconnect', { terminateDebuggee: false })
    const before = debuggee.text.length
    await sleep(300)
    assert.ok(alive(debuggee))
    assert.ok(debuggee.text.length > before)
  } else if (mode === 'terminate') {
    assert.equal(capabilities.supportsTerminateRequest, true)
    assert.ok(pidAlive(Number(pid.result)))
    await dap.request('terminate')
    await dap.event('terminated', () => true, cursor)
    await dap.request('disconnect', { terminateDebuggee: true })
    await until(() => !pidAlive(Number(pid.result)), 'owned Python debuggee termination')
  } else {
    await dap.event('terminated', () => true, cursor)
    await dap.request('disconnect', { terminateDebuggee: true })
  }
  return {
    scenario: label,
    capabilities,
    breakpoint,
    inspection,
    properties,
    getter: { before: before.result, afterInspect: after.result },
    exception: exception.body,
    exceptionInfo,
    detachAlive: debuggee ? alive(debuggee) : undefined,
    terminatedOwnedProcess: mode === 'terminate' ? !pidAlive(Number(pid.result)) : undefined,
  }
}

const results = []
try {
  // Use only the separately pinned scratch compiler, not a new project dependency.
  const compiler = start(process.execPath, [
    resolve(scratch, 'adapters/npm/node_modules/typescript/bin/tsc'),
    'probes/fixtures/debug-program.ts',
    '--sourceMap',
    '--inlineSources',
    '--target',
    'ES2022',
    '--module',
    'commonjs',
    '--outDir',
    resolve(scratch, 'compiled'),
    '--skipLibCheck',
  ])
  assert.equal((await once(compiler, 'exit'))[0], 0, compiler.text)
  await writeFile(resolve(scratch, 'compiled/package.json'), '{"type":"commonjs"}\n')
  const adapter = start(process.execPath, [
    resolve(scratch, 'adapters/js-debug/src/dapDebugServer.js'),
    '0',
    '127.0.0.1',
  ])
  const port = Number(
    (
      await until(() => /listening at 127\.0\.0\.1:(\d+)/.exec(adapter.text), 'js-debug DAP server')
    )[1]
  )
  for (const [kind, mode, terminal] of [
    ['js', 'launch', false],
    ['ts', 'launch', true],
    ['js', 'attach', false],
    ['ts', 'attach', false],
    ['js', 'terminate', false],
  ]) {
    results.push(await jsCheck(port, kind, mode, terminal))
    console.log('PASS', label)
  }
  for (const mode of ['launch', 'attach', 'terminate']) {
    results.push(await pythonCheck(mode))
    console.log('PASS', label)
  }
} catch (error) {
  if (!runtime.signal.aborted) throw error
} finally {
  await runtime.finish(async () => {
    await writeFile(
      resolve(evidence, `${process.env.PROBE_NO_CHILD ? 'no-child' : 'real'}-dap.json`),
      JSON.stringify(transcript, null, 2)
    )
    await writeFile(resolve(evidence, 'real-results.json'), JSON.stringify(results, null, 2))
    await writeFile(
      resolve(evidence, 'process-output.json'),
      JSON.stringify(
        owned.map((c) => ({ pid: c.pid, text: c.text, exit: c.exitCode, signal: c.signalCode })),
        null,
        2
      )
    )
  })
}
