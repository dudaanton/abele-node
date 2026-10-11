import { expect, it } from 'vitest'
import { registerDebuggerContext } from '../../packages/provider-pi/src/debugger.js'
import { agentFixture } from './review-fixture.js'

it('pi only republishes results from their originally granted session and incarnation', async () => {
  const f = agentFixture(),
    oldGrant = f.grant(),
    oldBinding = f.binding(oldGrant)
  let nextBinding: ReturnType<typeof f.binding> | undefined
  try {
    const original = await oldBinding.call('debug_status', { debug_session_id: f.id })
    f.core.debugger.recordHistory(f.id, {
      actor: { kind: 'agent', principal_id: f.owner.installation_id, run_id: 'run' },
      operation_id: 'old-value',
      operation: 'variables',
      outcome: 'completed',
      requested_data: 'private-incarnation-a',
    })
    f.control.revokeGrant(f.owner, oldGrant.grant_id)
    const next = f.core.debugger.replaceTarget(f.id, original.snapshot.target)
    const nextGrant = f.grant({ incarnation: next.incarnation, actions: ['read'] })
    nextBinding = f.binding(nextGrant)
    expect(await nextBinding.call('debug_history', { debug_session_id: f.id })).toMatchObject({
      entries: [],
    })
    let context!: (event: any, ctx: any) => Promise<any>
    registerDebuggerContext(
      {
        on: (_kind: any, handler: any) => {
          context = handler
          return () => {}
        },
      } as any,
      nextBinding
    )
    const message = (snapshot: any, data: string) => ({
      role: 'toolResult',
      toolName: 'debug_variables',
      toolCallId: 'call-' + snapshot.debug_session_id,
      content: [{ type: 'text', text: JSON.stringify({ snapshot, requested: { data } }) }],
      details: { requested_data: data },
    })
    const messages = [
      message(original.snapshot, 'private-incarnation-a'),
      message(next, 'permitted-incarnation-b'),
      message({ ...next, debug_session_id: 'other-session' }, 'private-other-session'),
    ]
    const updated = await context({ messages }, {})
    expect(JSON.stringify(updated.messages[0])).not.toContain('private-incarnation-a')
    expect(JSON.stringify(updated.messages[1])).toContain('permitted-incarnation-b')
    expect(JSON.stringify(updated.messages[2])).not.toContain('private-other-session')
    expect(JSON.stringify(messages[0])).toContain('private-incarnation-a')
  } finally {
    nextBinding?.close()
    oldBinding.close()
    f.close()
  }
})

it('pi fails closed on historical results missing original incarnation evidence', async () => {
  const f = agentFixture(),
    g = f.grant(),
    binding = f.binding(g)
  try {
    let context!: (event: any, ctx: any) => Promise<any>
    registerDebuggerContext(
      {
        on: (_kind: any, handler: any) => {
          context = handler
          return () => {}
        },
      } as any,
      binding
    )
    const message = {
      role: 'toolResult',
      toolName: 'debug_variables',
      toolCallId: 'old',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            snapshot: { debug_session_id: f.id },
            requested: { data: 'unscoped-value' },
          }),
        },
      ],
      details: { data: 'unscoped-value' },
    }
    const updated = await context({ messages: [message] }, {})
    expect(JSON.stringify(updated.messages)).not.toContain('unscoped-value')
  } finally {
    binding.close()
    f.close()
  }
})
