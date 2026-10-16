import { expect, it } from 'vitest'
import {
  ConfigurationSchema,
  LiveConfigurationSchema,
  ParentMessageSchema,
} from '../packages/provider-pi/src/wire.js'
import { LspTools } from '../packages/node-core/src/lsp/tools.js'

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
