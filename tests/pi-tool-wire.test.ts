import { expect, it } from 'vitest'
import {
  ConfigurationSchema,
  LiveConfigurationSchema,
  ParentMessageSchema,
} from '../packages/provider-pi/src/wire.js'
import { LspTools } from '../packages/node-core/src/lsp/tools.js'

it('carries the advertised Obsidian registry alongside native tools', () => {
  const tools = Array.from({ length: 256 }, (_, index) => ({
    name: `obsidian_tool_${index}`,
    description: 'Vault action',
    inputSchema: { type: 'object' },
  }))
  expect(
    ConfigurationSchema.parse({
      cwd: '/repo',
      sessionDir: '/sessions',
      agentDir: '/agent',
      provider: '',
      model: '',
      profile: 'isolated',
      maxTokens: 1024,
      debugger_tools: tools,
    }).debugger_tools
  ).toEqual(tools)
})
import {
  debuggerToolDefinitions,
  debuggerToolSpec,
} from '../packages/node-core/src/debugger/agent.js'

it('carries the complete debugger tool set through pi live and turn startup', () => {
  const config = {
    cwd: '/repo',
    sessionDir: '/sessions',
    agentDir: '/agent',
    provider: '',
    model: '',
    profile: 'isolated',
    maxTokens: 1024,
    debugger_tools: debuggerToolDefinitions,
  }
  expect(
    LiveConfigurationSchema.parse({ config, hostModule: '/host.mjs' }).config.debugger_tools
  ).toEqual(debuggerToolDefinitions)
  expect(
    ParentMessageSchema.parse({ kind: 'start', config, hostModule: '/host.mjs', text: 'hi' })
  ).toMatchObject({ config: { debugger_tools: debuggerToolDefinitions } })
  expect(new Set(debuggerToolDefinitions.map((t) => t.name)).size).toBe(20)
  for (const [name, method] of Object.entries({
    debug_command_result: 'commandResult',
    debug_exception_breakpoints_set: 'exceptionBreakpoints.set',
    debug_set_variable: 'setVariable',
    debug_cancel_wait: 'cancelWait',
  })) {
    expect(debuggerToolDefinitions.some((t) => t.name === name)).toBe(true)
    expect(debuggerToolSpec(name)?.method).toBe(method)
  }
})

it('carries the scheduler LSP tool through both pi worker startup protocols', () => {
  const tools = new LspTools(null as any, 'session', 'owner', () => true).tools
  const config = {
    cwd: '/repo',
    sessionDir: '/sessions',
    agentDir: '/agent',
    provider: '',
    model: '',
    profile: 'isolated',
    maxTokens: 1024,
    debugger_tools: tools,
  }
  expect(ConfigurationSchema.parse(config).debugger_tools).toEqual(tools)
  expect(() =>
    ParentMessageSchema.parse({ kind: 'start', config, hostModule: '/host.mjs', text: 'hi' })
  ).not.toThrow()
  expect(() => LiveConfigurationSchema.parse({ config, hostModule: '/host.mjs' })).not.toThrow()
  for (const name of ['lsp_other', 'shell', 'debug', 'node'])
    expect(() =>
      ConfigurationSchema.parse({ ...config, debugger_tools: [{ ...tools[0], name }] })
    ).toThrow()
})
