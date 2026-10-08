// Assertions for the explicit real-adapter checks. No production service imports.
import assert from 'node:assert/strict'

export async function initialize(dap, adapterID) {
  const capabilities = await dap.request('initialize', {
    clientID: 'abele-b0',
    adapterID,
    linesStartAt1: true,
    columnsStartAt1: true,
    pathFormat: 'path',
    supportsVariableType: true,
    supportsRunInTerminalRequest: true,
    supportsStartDebuggingRequest: true,
  })
  assert.equal(capabilities.supportsConfigurationDoneRequest, true)
  return capabilities
}

export async function configure(dap, source, line, filters = []) {
  await dap.event('initialized')
  const bp = await dap.request('setBreakpoints', {
    source: { path: source },
    breakpoints: [{ line }],
  })
  assert.equal(bp.breakpoints.length, 1)
  await dap.request('setExceptionBreakpoints', { filters })
  await dap.request('configurationDone')
  return bp.breakpoints[0] // verification may arrive later, not a false assertion of success
}

// Observe both promises immediately: an early launch/attach refusal must abort a
// configuration event wait, and a configuration error must settle the start request.
export async function startConfigured(dap, command, args, configuration) {
  const pending = dap.request(command, args)
  const configured = Promise.resolve().then(configuration)
  try {
    const [, result] = await Promise.all([pending, configured])
    return result
  } catch (error) {
    dap.close(error)
    throw error
  }
}

export async function inspectAndStep(dap, source, line, expression, value, after = 0) {
  const stopped = await dap.event('stopped', () => true, after)
  assert.equal(stopped.body.reason, 'breakpoint')
  const { threads } = await dap.request('threads')
  assert.ok(threads.length)
  const threadId = stopped.body.threadId ?? threads[0].id
  const { stackFrames } = await dap.request('stackTrace', { threadId })
  const top = stackFrames[0]
  assert.equal(top.source.path, source)
  assert.equal(top.line, line)
  const { scopes } = await dap.request('scopes', { frameId: top.id })
  assert.ok(scopes.length)
  const { variables } = await dap.request('variables', {
    variablesReference: scopes[0].variablesReference,
  })
  assert.ok(variables.length)
  const result = await dap.request('evaluate', { frameId: top.id, expression, context: 'repl' })
  assert.equal(result.result, value)
  const cursor = dap.cursor
  await dap.request('next', { threadId })
  const stepped = await dap.event('stopped', () => true, cursor)
  assert.equal(stepped.body.reason, 'step')
  const nextStack = await dap.request('stackTrace', { threadId })
  // Each synthetic fixture's next executable statement is immediately after BREAKPOINT.
  assert.equal(nextStack.stackFrames[0].source.path, source)
  assert.equal(nextStack.stackFrames[0].line, line + 1)
  const nextScopes = await dap.request('scopes', { frameId: nextStack.stackFrames[0].id })
  const fresh = await dap.request('variables', {
    variablesReference: nextScopes.scopes[0].variablesReference,
  })
  return {
    stopped: stopped.body,
    top,
    variables,
    result,
    next: nextStack.stackFrames[0],
    nextVariables: fresh.variables,
    threadId,
  }
}
