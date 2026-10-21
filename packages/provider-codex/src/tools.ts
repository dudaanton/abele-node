import type { DebuggerToolBridge } from '@abele/provider-contract'

/** Dynamic-tool wire shapes are pinned in the recorded experimental app-server schemas. */
export class CodexTools {
  private turn?: string
  private calls = new Map<string, { input: string; result: Promise<any> }>()
  constructor(
    private bridge: DebuggerToolBridge | undefined,
    private current: () => { thread?: string; turn?: string }
  ) {}
  definitions() {
    return (this.bridge?.tools ?? []).map(({ name, description, inputSchema }) => ({
      type: 'function' as const,
      name,
      description,
      inputSchema,
    }))
  }
  async handle(p: any, signal: AbortSignal) {
    const current = this.current()
    if (
      !current.thread ||
      !current.turn ||
      p?.threadId !== current.thread ||
      p?.turnId !== current.turn ||
      typeof p?.callId !== 'string' ||
      !p.callId ||
      p.callId.length > 128
    )
      throw new Error('stale_tool_call')
    if (signal.aborted) throw new Error('cancelled')
    if (!this.bridge || p.namespace != null || !this.bridge.tools.some((t) => t.name === p.tool))
      throw new Error('unsupported_tool')
    if (this.turn !== current.turn) {
      this.calls.clear()
      this.turn = current.turn
    }
    const input = JSON.stringify([p.tool, p.arguments])
    const prior = this.calls.get(p.callId)
    if (prior) {
      if (prior.input !== input) throw new Error('tool_call_conflict')
      return prior.result
    }
    if (this.calls.size >= 128) throw new Error('tool_call_limit')
    const bridge = this.bridge
    const result = Promise.resolve()
      .then(async () => {
        const value = await (p.tool.startsWith('obsidian_')
          ? bridge.call(p.tool, p.arguments, signal, 'codex:' + p.turnId + ':' + p.callId)
          : bridge.call(p.tool, p.arguments, signal))
        if (signal.aborted || this.current().turn !== p.turnId) throw new Error('cancelled')
        const published = bridge.publish(p.arguments, value)
        return {
          contentItems: [{ type: 'inputText', text: JSON.stringify(published) }],
          success: !['failed', 'denied', 'cancelled', 'outcome_unknown'].includes(published?.state),
        }
      })
      .catch((error) => {
        if (signal.aborted || this.current().turn !== p.turnId) throw error
        // A transport error must not encourage a blind retry of a mutation. The
        // node journal remains the authority for any admitted invocation.
        return {
          contentItems: [
            {
              type: 'inputText',
              text: JSON.stringify({
                state: 'outcome_unknown',
                code: 'node_tool_failed',
                message: 'Inspect the recorded invocation before retrying.',
              }),
            },
          ],
          success: false,
        }
      })
    this.calls.set(p.callId, { input, result })
    return result
  }
}
