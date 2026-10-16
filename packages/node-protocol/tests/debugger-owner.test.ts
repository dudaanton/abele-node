import { it, expect } from 'vitest'
import { DebuggerControlMethodSchemas } from '../src/index.js'

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
