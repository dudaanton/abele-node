import {
  TOOL_KINDS,
  TOOL_STATUSES,
  type ConfigOptionSchema,
  type PlanEntry,
  type SessionCommand,
  type SessionUpdate,
  type ToolContent,
} from './session-update.js'
import { bounded } from './claude-updates.js'
import type { z } from 'zod'

/**
 * The records of agents that speak ACP (`acp.*`) as session updates. ACP's own `session/update`
 * kinds are this vocabulary's model, so most map field for field. Pure and stateless: the provider
 * stamps every streamed chunk with its message and writes the joined text when it is finished.
 * The context meter comes from the node's `session.context`, not from here.
 */
type Data = Record<string, unknown>
const TEXT = 65536
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const ident = (v: unknown) => str(v)?.slice(0, 256)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const obj = (v: unknown): Data =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Data) : {}
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const cut = (text: string, max = TEXT) =>
  text.length > max ? { text: text.slice(0, max), truncated: true } : { text }
const blockText = (content: unknown) => {
  const c = obj(content)
  return c.type === 'text' ? (str(c.text) ?? '') : ''
}
const oneOf = <T extends string>(values: readonly T[], v: unknown) =>
  values.includes(v as T) ? (v as T) : undefined

function toolContent(content: unknown): ToolContent[] | undefined {
  if (!Array.isArray(content)) return undefined
  const out: ToolContent[] = []
  for (const item of content.slice(0, 64).map(obj)) {
    if (item.type === 'content') {
      const text = blockText(item.content)
      if (text) out.push({ type: 'content', ...cut(text) })
    } else if (item.type === 'diff' && str(item.path)) {
      const old_text = str(item.oldText) ?? null,
        new_text = str(item.newText) ?? ''
      out.push({
        type: 'diff',
        path: str(item.path)!.slice(0, 4096),
        old_text: old_text === null ? null : old_text.slice(0, TEXT),
        new_text: new_text.slice(0, TEXT),
        ...((old_text?.length ?? 0) > TEXT || new_text.length > TEXT ? { truncated: true } : {}),
      })
    }
    // Terminal content has no view here.
  }
  return out
}
function tool(u: Data) {
  const locations = list(u.locations)
    .map(obj)
    .filter((l) => str(l.path))
    .slice(0, 64)
    .map((l) => ({ path: str(l.path)!.slice(0, 4096), line: num(l.line) }))
  const content = toolContent(u.content)
  const tool_kind = oneOf(TOOL_KINDS, u.kind)
  const status = oneOf(TOOL_STATUSES, u.status)
  return {
    tool_call_id: ident(u.toolCallId) ?? '',
    ...(str(u.title) !== undefined ? { title: str(u.title)!.slice(0, 4096) } : {}),
    ...(tool_kind ? { tool_kind } : {}),
    ...(status ? { status } : {}),
    ...(Array.isArray(u.locations) ? { locations } : {}),
    ...(content ? { content } : {}),
    ...(u.rawInput && typeof u.rawInput === 'object' && !Array.isArray(u.rawInput)
      ? { raw_input: u.rawInput as Data }
      : {}),
  }
}
function commands(v: unknown): SessionCommand[] {
  return list(v)
    .map(obj)
    .map((c) => ({
      name: (str(c.name) ?? '').replace(/^\//, ''),
      description: str(c.description)?.slice(0, 1024) ?? null,
      input_hint: str(obj(c.input).hint)?.slice(0, 256) ?? null,
    }))
    .filter((c) => /^[^\s/][^\s]*$/.test(c.name) && c.name.length <= 128)
    .slice(0, 512)
}
function configOptions(v: unknown): z.infer<typeof ConfigOptionSchema>[] {
  return list(v)
    .map(obj)
    .filter((o) => str(o.id))
    .slice(0, 32)
    .map((o) => {
      // ACP options are a flat list or grouped; both become one list of values.
      const values = list(o.options).flatMap((x) =>
        Array.isArray(obj(x).options) ? list(obj(x).options) : [x]
      )
      return {
        id: str(o.id)!.slice(0, 64),
        name: (str(o.name) ?? str(o.id)!).slice(0, 128),
        category: oneOf(['mode', 'model', 'thought_level'] as const, o.category) ?? 'other',
        current_value: str(o.currentValue)?.slice(0, 256) ?? null,
        ...(values.length
          ? {
              options: values
                .map(obj)
                .filter((x) => str(x.value))
                .slice(0, 256)
                .map((x) => ({
                  value: str(x.value)!.slice(0, 256),
                  name: (str(x.name) ?? str(x.value)!).slice(0, 256),
                })),
            }
          : {}),
      }
    })
}
function update(d: Data): SessionUpdate[] {
  const u = obj(d.update)
  const message_id = ident(d.message_id)
  switch (u.sessionUpdate) {
    case 'agent_message_chunk':
    case 'agent_thought_chunk': {
      const text = blockText(u.content)
      if (!message_id || !text) return []
      const kind = u.sessionUpdate
      return [{ kind, message_id, text: text.slice(0, TEXT) }]
    }
    case 'tool_call': {
      const call = tool(u)
      return [{ kind: 'tool_call', ...call, title: call.title ?? 'Tool call' }]
    }
    case 'tool_call_update':
      return [{ kind: 'tool_call_update', ...tool(u) }]
    case 'plan':
      return [
        {
          kind: 'plan',
          entries: list(u.entries)
            .map(obj)
            .slice(0, 256)
            .map((e): PlanEntry => ({
              content: (str(e.content) ?? '').slice(0, 4096),
              priority: oneOf(['high', 'medium', 'low'] as const, e.priority) ?? 'medium',
              status:
                oneOf(['pending', 'in_progress', 'completed'] as const, e.status) ?? 'pending',
            })),
        },
      ]
    case 'available_commands_update':
      return [{ kind: 'available_commands_update', commands: commands(u.availableCommands) }]
    case 'current_mode_update':
      return str(u.currentModeId)
        ? [{ kind: 'current_mode_update', mode_id: str(u.currentModeId)!.slice(0, 64) }]
        : []
    case 'config_option_update':
      return [
        {
          kind: 'config_option_update',
          options: configOptions(u.configOptions ?? (u.configOption ? [u.configOption] : [])),
        },
      ]
    case 'compaction_update': {
      const state = oneOf(
        ['started', 'completed', 'failed'] as const,
        str(u.status) ?? str(u.state)
      )
      return state ? [{ kind: 'compaction_update', state }] : []
    }
    case 'notice': {
      const text = str(u.message) ?? blockText(u.content)
      return text
        ? [
            {
              kind: 'notice',
              level: oneOf(['info', 'warning', 'error'] as const, u.level) ?? 'info',
              text: text.slice(0, 4096),
            },
          ]
        : []
    }
    default:
      return []
  }
}
export function acpSessionUpdates(type: string, data: unknown): SessionUpdate[] {
  return mapAcp(type, obj(data)).map(bounded)
}
function mapAcp(type: string, d: Data): SessionUpdate[] {
  switch (type) {
    case 'acp.update':
      return update(d)
    case 'acp.message': {
      const message_id = ident(d.message_id),
        text = str(d.text)
      if (!message_id || text === undefined) return []
      return [
        {
          kind: d.role === 'thought' ? 'agent_thought' : 'agent_message',
          message_id,
          ...cut(text),
        },
      ]
    }
    case 'acp.compaction.summary': {
      const text = str(d.text)
      return text ? [{ kind: 'compaction_summary', ...cut(text) }] : []
    }
    case 'acp.permission': {
      const what = str(d.title) ?? str(d.tool_call_id) ?? 'a tool call'
      const decision = str(d.decision) ?? 'rejected'
      const by =
        d.by === 'session_mode' ? ' by the session mode' : d.by === 'owner' ? ' by the owner' : ''
      return [
        {
          kind: 'notice',
          level: decision === 'allowed' ? 'info' : 'warning',
          text: `${decision[0]!.toUpperCase()}${decision.slice(1)}${by}: ${what}`.slice(0, 4096),
          code: `permission_${decision}`.slice(0, 64),
        },
      ]
    }
    case 'acp.notice': {
      const text = str(d.text)
      return text
        ? [
            {
              kind: 'notice',
              level: oneOf(['info', 'warning', 'error'] as const, d.level) ?? 'info',
              text: text.slice(0, 4096),
              ...(str(d.code) ? { code: str(d.code)!.slice(0, 64) } : {}),
            },
          ]
        : []
    }
    default:
      return []
  }
}
