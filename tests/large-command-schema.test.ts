import { expect, it } from 'vitest'
import {
  ManagerMethodSchemas,
  CommandContextMethodSchemas,
} from '../packages/node-protocol/src/manager.js'
it('accepts command text above 16 KiB and gives actionable guidance above 32 Ki characters', () => {
  const schema = ManagerMethodSchemas['command.v1.run']
  const params = {
    session_id: 'sample-session',
    project_id: 'sample-project',
    command: 'x'.repeat(20000),
  }
  expect(schema.parse(params).command).toHaveLength(20000)
  expect(() => schema.parse({ ...params, command: 'x'.repeat(32769) })).toThrow(/split the command/)
  expect(() =>
    schema.parse({
      session_id: 'sample-session',
      project_id: 'sample-project',
      argv: ['x'.repeat(32769)],
    })
  ).toThrow(/node_edit/)
  const context = {
    context_id: 'sample-context',
    parent_chat_id: 'sample-chat',
    permission_mode: 'ask',
    command: 'x'.repeat(32769),
  }
  expect(() => CommandContextMethodSchemas['command.context.v1.prepare'].parse(context)).toThrow(
    /split the command/
  )
})
