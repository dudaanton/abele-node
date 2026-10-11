import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent'
import { bindDebuggerTools, type DebuggerToolBridge } from '@abele/provider-contract'

/** Same trusted bridge and current-state delivery as plugin-agent embeddings.
 * Plain JSON schemas cross IPC; only their SDK type is adapted here. */
export function registerDebuggerTools(
  pi: Pick<ExtensionAPI, 'registerTool'>,
  bridge: DebuggerToolBridge
) {
  for (const tool of bindDebuggerTools(bridge))
    pi.registerTool({ ...tool, parameters: tool.parameters as ToolDefinition['parameters'] })
}

/** Refresh copies of existing debugger tool results only when the SDK is about
 * to make its next already-scheduled request. Never append chat input, persist a
 * synthetic message, alter an inference in flight or request a continuation. */
export function registerDebuggerContext(pi: Pick<ExtensionAPI, 'on'>, bridge: DebuggerToolBridge) {
  const names = new Set(bridge.tools.map((tool) => tool.name))
  return pi.on('context', async (event, ctx) => {
    const fresh = new Map<string, any>()
    const messages = []
    for (const message of event.messages) {
      if (message.role !== 'toolResult' || !names.has(message.toolName)) {
        messages.push(message)
        continue
      }
      let original: any
      try {
        original = JSON.parse(
          message.content
            .filter((c) => c.type === 'text')
            .map((c) => c.text)
            .join('')
        )
      } catch {}
      const session = original?.snapshot?.debug_session_id
      let state: any = { snapshot: null, observation: 'unknown', code: 'debugger_unavailable' }
      if (typeof session === 'string') {
        if (!fresh.has(session) && fresh.size < 128) {
          try {
            const args = { debug_session_id: session }
            fresh.set(
              session,
              bridge.publish(args, await bridge.call('debug_status', args, ctx.signal))
            )
          } catch {
            fresh.set(session, state)
          }
        }
        state = fresh.get(session) ?? state
        // Another session's awaited refresh may have crossed revocation. Recheck
        // cached state at each historical publication, not just once per page.
        try {
          state = bridge.publish({ debug_session_id: session }, state)
        } catch {
          state = { snapshot: null, observation: 'unknown', code: 'debugger_unavailable' }
        }
      }
      // Revocation/expired scope also fences replay of previously requested
      // values in the next provider context. Already-delivered data cannot be
      // recalled from the provider; the persisted local transcript is unmodified.
      // Current read access cannot authorize values from a prior incarnation.
      // The node grant fixes session + incarnation (and thereby the target).
      // Missing original evidence must fail closed too, including old transcripts.
      const permitted =
        state.snapshot &&
        typeof original?.snapshot?.incarnation === 'string' &&
        original.snapshot.incarnation === state.snapshot.incarnation &&
        original.snapshot.debug_session_id === state.snapshot.debug_session_id
      const result = permitted
        ? { ...original, current_observation: state }
        : state.snapshot
          ? { ...state, code: 'historical_scope_expired' }
          : state
      messages.push({
        ...message,
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
        details: permitted ? (message as any).details : result,
      })
    }
    return { messages }
  })
}
