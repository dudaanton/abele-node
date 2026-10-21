import type { PlanEntry, SessionCommand, SessionUpdate, ToolContent } from './session-update.js'

/**
 * Codex's journal records (`codex.*`, bounded runs and live sessions) as session updates. Pure
 * and stateless: the node maps each record as it is written, and a client replays a journal
 * written before the node did. Records kept as artifacts carry no fields and map to nothing.
 */
type Data = Record<string, unknown>
const TEXT = 65536
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const cut = (text: string, max = TEXT) =>
  text.length > max ? { text: text.slice(0, max), truncated: true } : { text }
const line = (text: string, max = 256) => {
  const first = text.split('\n', 1)[0]!.trim()
  return first.length > max ? first.slice(0, max - 1) + '…' : first
}
const content = (text: string): ToolContent => ({ type: 'content', ...cut(text) })

type Change = { path: string; kind: string; diff: string }
function changes(v: unknown): Change[] {
  if (!Array.isArray(v)) return []
  return v.slice(0, 64).flatMap((c) => {
    const path = str(c?.path),
      kind = str(c?.kind?.type)
    return path && kind ? [{ path, kind, diff: str(c?.diff) ?? '' }] : []
  })
}
/** A new file is its whole text; an update or deletion is Codex's unified diff. */
function changeContent(list: Change[]): ToolContent[] {
  return list.map((c) =>
    c.kind === 'add'
      ? {
          type: 'diff',
          path: c.path,
          old_text: null,
          new_text: c.diff.slice(0, TEXT),
          ...(c.diff.length > TEXT ? { truncated: true } : {}),
        }
      : content(c.diff)
  )
}
function describe(d: Data) {
  if (d.tool === 'commandExecution') {
    const command = str(d.command) ?? ''
    return {
      title: line(command) || 'Command',
      tool_kind: 'execute' as const,
      name: 'commandExecution',
      raw_input: { command, cwd: str(d.cwd) ?? null },
    }
  }
  const list = changes(d.changes)
  const verbs = new Set(list.map((c) => c.kind))
  return {
    title: list.length === 1 ? `Edit ${list[0]!.path}` : `Edit ${list.length} files`,
    tool_kind: verbs.size === 1 && verbs.has('delete') ? ('delete' as const) : ('edit' as const),
    name: 'fileChange',
    ...(list.length ? { locations: list.map((c) => ({ path: c.path })) } : {}),
    ...(list.length ? { content: changeContent(list) } : {}),
  }
}
const STATUS: Record<string, 'pending' | 'in_progress' | 'completed' | 'failed'> = {
  inProgress: 'in_progress',
  completed: 'completed',
  failed: 'failed',
  declined: 'failed',
}
const PLAN: Record<string, PlanEntry['status']> = {
  pending: 'pending',
  inProgress: 'in_progress',
  in_progress: 'in_progress',
  completed: 'completed',
}

export function codexSessionUpdates(type: string, data: unknown): SessionUpdate[] {
  const d = (data && typeof data === 'object' ? data : {}) as Data
  const item = str(d.item_id)
  switch (type) {
    case 'codex.dependencies.warning':
      return [
        {
          kind: 'notice',
          level: 'warning',
          code: 'missing_dependencies',
          text:
            d.network_enabled === true
              ? 'Project dependencies are missing. Install them before running builds or tests; project network access is enabled.'
              : 'Project dependencies are missing. Network is disabled: install dependencies first or ask the owner to enable project network access before running builds or tests.',
        },
      ]
    case 'codex.message.delta':
      return item && str(d.delta)
        ? [{ kind: 'agent_message_chunk', message_id: item, text: str(d.delta)!.slice(0, TEXT) }]
        : []
    case 'codex.message.final':
      return item && str(d.text) !== undefined
        ? [{ kind: 'agent_message', message_id: item, ...cut(str(d.text)!) }]
        : []
    case 'codex.thinking':
      return item && str(d.delta)
        ? [{ kind: 'agent_thought_chunk', message_id: item, text: str(d.delta)!.slice(0, TEXT) }]
        : []
    case 'codex.tool.call':
      return item
        ? [{ kind: 'tool_call', tool_call_id: item, status: 'in_progress', ...describe(d) }]
        : []
    case 'codex.tool.proposal': {
      const list = changes(d.changes)
      return item && list.length
        ? [
            {
              kind: 'tool_call_update',
              tool_call_id: item,
              locations: list.map((c) => ({ path: c.path })),
              content: changeContent(list),
            },
          ]
        : []
    }
    case 'codex.tool.result': {
      if (!item) return []
      const exit = num(d.exit_code)
      const status =
        STATUS[str(d.status) ?? ''] ?? (exit !== null && exit !== 0 ? 'failed' : 'completed')
      const output = str(d.output)
      return [
        {
          kind: 'tool_call_update',
          tool_call_id: item,
          status: exit !== null && exit !== 0 ? 'failed' : status,
          ...(d.tool === 'commandExecution'
            ? output
              ? { content: [content(output)] }
              : {}
            : { content: changeContent(changes(d.changes)) }),
        },
      ]
    }
    case 'codex.plan': {
      if (!Array.isArray(d.plan)) return []
      const entries = d.plan.slice(0, 256).flatMap((e: any) =>
        str(e?.step) !== undefined
          ? [
              {
                content: str(e.step)!.slice(0, 4096),
                priority: 'medium' as const,
                status: PLAN[str(e.status) ?? ''] ?? 'pending',
              },
            ]
          : []
      )
      return [{ kind: 'plan', entries }]
    }
    case 'codex.commands':
      return Array.isArray(d.commands)
        ? [{ kind: 'available_commands_update', commands: d.commands as SessionCommand[] }]
        : []
    case 'live.status':
      if (d.status === 'compacting') return [{ kind: 'compaction_update', state: 'started' }]
      if (d.compact_result === 'failed')
        return [
          {
            kind: 'compaction_update',
            state: 'failed',
            error: str(d.compact_error)?.slice(0, 256) ?? null,
          },
        ]
      return []
    // The context meter and a finished compaction are the node's own events in a live session.
    default:
      return []
  }
}
