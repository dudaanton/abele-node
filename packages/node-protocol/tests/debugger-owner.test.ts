import { it, expect } from 'vitest'
import { DebuggerControlMethodSchemas, DebuggerAddSourcesResultSchema } from '../src/index.js'

it('accepts bounded addSources requests with a session owner', () => {
  const schema = DebuggerControlMethodSchemas['debugger.v1.addSources']
  const input = { operation_id: 'add', debug_session_id: 'session', sources: ['late.js'] }
  expect(schema.parse(input)).toEqual(input)
  expect(schema.safeParse({ ...input, sources: Array(257).fill('a.js') }).success).toBe(false)
  expect(schema.safeParse({ ...input, sources: [''] }).success).toBe(false)
  expect(schema.safeParse({ ...input, operation_id: '' }).success).toBe(false)
  expect(schema.safeParse({ ...input, folder: {} }).success).toBe(false)
  const result = {
    incarnation: 'i',
    sources: [{ source_id: 's2', path: 'late.js' }],
    refused: [{ path: '../outside.js', code: 'debugger_source_outside_folder' }],
  }
  expect(DebuggerAddSourcesResultSchema.parse(result)).toEqual(result)
  expect(DebuggerAddSourcesResultSchema.safeParse({ ...result, incarnation: '' }).success).toBe(
    false
  )
  expect(DebuggerAddSourcesResultSchema.safeParse({ ...result, extra: true }).success).toBe(false)
})

it('accepts a folder owner without a chat and rejects an absent owner', () => {
  const folder = { kind: 'workspace', workspace_id: 'w' }
  for (const method of ['start', 'attachProgram', 'programs', 'sessions'] as const) {
    const schema = DebuggerControlMethodSchemas[`debugger.v1.${method}`]
    const params =
      method === 'start'
        ? { operation_id: 'o', program: 'app.js' }
        : method === 'attachProgram'
          ? { operation_id: 'o', pid: 1, port: 9229 }
          : {}
    expect(schema.safeParse({ ...params, folder }).success).toBe(true)
    expect(schema.safeParse(params).success).toBe(false)
    expect(schema.safeParse({ ...params, conversation_id: 'c' }).success).toBe(true)
  }
})
