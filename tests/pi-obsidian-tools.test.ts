import { expect, it } from 'vitest'
import { registerDebuggerTools } from '../packages/provider-pi/src/debugger.js'

it('registers and executes advertised Obsidian schemas through the ordinary supervised tool interface', async () => {
  const registered: any[] = []
  const calls: any[] = []
  const result = {
    invocation_id: 'invocation',
    state: 'succeeded',
    result: { content: [{ type: 'text', text: 'created' }] },
  }
  registerDebuggerTools(
    { registerTool: (tool: any) => registered.push(tool) },
    {
      tools: [
        {
          name: 'obsidian_create',
          description: 'Create',
          inputSchema: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
      async call(...args) {
        calls.push(args)
        return result
      },
      publish: (_args, value) => value,
      close() {},
    }
  )
  const signal = new AbortController().signal
  const output = await registered[0].execute('call', { path: 'note' }, signal)
  expect(calls).toEqual([['obsidian_create', { path: 'note' }, signal]])
  expect(output.details).toBe(result)
  expect(JSON.parse(output.content[0].text)).toEqual(result)
  expect(registered[0].parameters.required).toEqual(['path'])
})
