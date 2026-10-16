// ACP `session/update` notifications as the provider's journal records. The node maps them into
// its shared `session.update` vocabulary (node-protocol `acp-updates.ts`); that mapping is
// stateless, so what needs the stream's history is settled here: which message a chunk belongs to,
// and the whole text of a message once it is finished.
import { randomUUID } from 'node:crypto'
import type { ProviderEvent } from '@abele/provider-contract'

export const EVENTS = {
  /** One ACP update as the agent sent it, with the message it belongs to. */
  update: 'acp.update',
  /** The whole text of a finished agent message or thought. */
  message: 'acp.message',
  compaction_summary: 'acp.compaction.summary',
  /** A permission decision, including the ones the session's mode made. */
  permission: 'acp.permission',
  notice: 'acp.notice',
} as const

export const blockText = (content: any) =>
  content && content.type === 'text' && typeof content.text === 'string' ? content.text : ''
const JOINED = {
  agent_message_chunk: 'message',
  agent_thought_chunk: 'thought',
  compaction_summary_chunk: 'summary',
} as const
type Joined = (typeof JOINED)[keyof typeof JOINED]

export class AcpEventMapper {
  private open?: { role: Joined; message_id: string; text: string }
  constructor(private emit: (event: ProviderEvent) => void) {}
  /** The text being streamed is finished: another kind of update came, or the turn ended. */
  flush() {
    const open = this.open
    this.open = undefined
    if (!open || !open.text) return
    if (open.role === 'summary')
      this.emit({ type: EVENTS.compaction_summary, data: { text: open.text } })
    else
      this.emit({
        type: EVENTS.message,
        data: { role: open.role, message_id: open.message_id, text: open.text },
      })
  }
  update(update: Record<string, any>) {
    const kind = String(update?.sessionUpdate ?? '')
    // The node journals the owner's own input; the echo adds nothing.
    if (kind === 'user_message_chunk') return
    const role = Object.hasOwn(JOINED, kind) ? JOINED[kind as keyof typeof JOINED] : undefined
    if (this.open && this.open.role !== role) this.flush()
    if (role) {
      // An agent that names its messages starts a new one when the name changes.
      const named = typeof update.messageId === 'string' ? update.messageId : undefined
      if (this.open && named && named !== this.open.message_id) this.flush()
      this.open ??= { role, message_id: named ?? randomUUID(), text: '' }
      this.open.text += blockText(update.content)
      return this.emit({
        type: EVENTS.update,
        data: { message_id: this.open.message_id, update },
      })
    }
    this.emit({ type: EVENTS.update, data: { update } })
  }
}
