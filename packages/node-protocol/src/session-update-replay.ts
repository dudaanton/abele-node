import { claudeSessionUpdates } from './claude-updates.js'
import { piSessionUpdates } from './pi-updates.js'
import { acpSessionUpdates } from './acp-updates.js'
import { codexSessionUpdates } from './codex-updates.js'
import {
  isKnownSessionUpdate,
  SessionUpdateEventSchema,
  type SessionUpdate,
} from './session-update.js'

interface JournalEvent {
  type: string
  actor: { kind: string; provider?: string }
  data: unknown
}
type Mapper = (type: string, data: unknown) => SessionUpdate[]
/** One pure mapper per provider; the node and a replaying client both use it. */
const mappers: Record<string, Mapper> = {
  claude: claudeSessionUpdates,
  pi: piSessionUpdates,
  acp: acpSessionUpdates,
  codex: codexSessionUpdates,
}
/** The updates a provider record stands for; only valid known kinds, never a throw. */
export function providerSessionUpdates(
  provider: string,
  type: string,
  data: unknown
): SessionUpdate[] {
  if (type === 'session.update' || !Object.hasOwn(mappers, provider)) return []
  try {
    return mappers[provider]!(type, data).filter(
      (update) => SessionUpdateEventSchema.safeParse({ update }).success
    )
  } catch {
    return []
  }
}
/**
 * The session updates one journal event stands for. A `session.update` gives its own; a
 * provider record the node did not map (a journal from before the node wrote updates) is mapped
 * here the way the node would have. Unknown kinds are left out.
 */
export function sessionUpdatesOf(event: JournalEvent): SessionUpdate[] {
  if (event.type === 'session.update') {
    const parsed = SessionUpdateEventSchema.safeParse(event.data)
    return parsed.success && isKnownSessionUpdate(parsed.data.update) ? [parsed.data.update] : []
  }
  const data = event.data as Record<string, unknown> | null
  if (
    event.type === 'input.accepted' &&
    data &&
    data.mapped !== true &&
    typeof data.input_id === 'string' &&
    typeof data.text === 'string'
  )
    return [
      {
        kind: 'user_message',
        message_id: data.input_id,
        text: data.text.slice(0, 65536),
        ...(data.text.length > 65536 ? { truncated: true } : {}),
      },
    ]
  if (event.actor.kind === 'node') return nodeUpdates(event.type, data ?? {})
  if (event.actor.kind !== 'provider' || !data || typeof data !== 'object' || data.mapped === true)
    return []
  return providerSessionUpdates(event.actor.provider ?? '', event.type, data)
}
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
/**
 * The node's own events that a long-lived session writes in place of the provider's records:
 * the context meter and a finished compaction. Its start and a failure come from the provider's
 * status records, so they are not repeated here.
 */
function nodeUpdates(type: string, d: Record<string, unknown>): SessionUpdate[] {
  if (type === 'session.context')
    return [
      {
        kind: 'usage_update',
        used_tokens: num(d.total_tokens),
        max_tokens: num(d.max_tokens),
        percentage: num(d.percentage),
      },
    ]
  if (type === 'compaction.completed' && d.result === 'success')
    return [
      {
        kind: 'compaction_update',
        state: 'completed',
        trigger: typeof d.trigger === 'string' ? d.trigger : null,
        pre_tokens: num(d.pre_tokens),
        post_tokens: num(d.post_tokens),
      },
    ]
  return []
}
