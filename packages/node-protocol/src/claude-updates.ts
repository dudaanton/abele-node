import type {
  PlanEntry,
  SessionCommand,
  SessionUpdate,
  SessionUpdateOf,
  ToolContent,
} from './session-update.js'

/**
 * Claude's journal records (`claude.*`) as session updates. Pure and stateless: the node maps
 * each record as it is written, and a client replays a journal written before the node did.
 * Records kept as artifacts carry no fields and map to nothing.
 */
type Data = Record<string, unknown>
const TEXT = 65536
const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const obj = (v: unknown): Data =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Data) : {}
const cut = (text: string, max = TEXT) =>
  text.length > max ? { text: text.slice(0, max), truncated: true } : { text }
const line = (text: string, max = 256) => {
  const first = text.split('\n', 1)[0]!.trim()
  return first.length > max ? first.slice(0, max - 1) + '…' : first
}
const parentOf = (d: Data) => ({ parent_tool_call_id: str(d.parent_tool_use_id) ?? null })
const block = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null)

function diff(path: string, old_text: string | null, new_text: string): ToolContent {
  const truncated = (old_text?.length ?? 0) > TEXT || new_text.length > TEXT
  return {
    type: 'diff',
    path,
    old_text: old_text === null ? null : old_text.slice(0, TEXT),
    new_text: new_text.slice(0, TEXT),
    ...(truncated ? { truncated } : {}),
  }
}

/** What a tool call looks like to a reader: its kind, a title, the files it touches. */
export function describeClaudeTool(
  name: string,
  input: Data
): Omit<SessionUpdateOf<'tool_call'>, 'kind' | 'tool_call_id'> {
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path)
  const at = path ? [{ path, line: num(input.offset) ?? num(input.line) }] : undefined
  const named = (tool_kind: SessionUpdateOf<'tool_call'>['tool_kind'], title: string) => ({
    tool_kind,
    title,
    ...(at ? { locations: at } : {}),
  })
  switch (name) {
    case 'Read':
      return named('read', path ? `Read ${path}` : 'Read')
    case 'Write':
      return {
        ...named('edit', path ? `Write ${path}` : 'Write'),
        ...(path ? { content: [diff(path, null, str(input.content) ?? '')] } : {}),
      }
    case 'Edit':
      return {
        ...named('edit', path ? `Edit ${path}` : 'Edit'),
        ...(path
          ? { content: [diff(path, str(input.old_string) ?? '', str(input.new_string) ?? '')] }
          : {}),
      }
    case 'MultiEdit': {
      const edits = Array.isArray(input.edits) ? input.edits.slice(0, 64).map(obj) : []
      return {
        ...named('edit', path ? `Edit ${path}` : 'Edit'),
        ...(path
          ? {
              content: edits.map((e) =>
                diff(path, str(e.old_string) ?? '', str(e.new_string) ?? '')
              ),
            }
          : {}),
      }
    }
    case 'NotebookEdit':
      return named('edit', path ? `Edit ${path}` : 'Edit notebook')
    case 'Bash': {
      const command = str(input.command) ?? ''
      return { tool_kind: 'execute', title: line(str(input.description) ?? command) || 'Bash' }
    }
    case 'BashOutput':
    case 'TaskOutput':
      return { tool_kind: 'execute', title: 'Read output' }
    case 'KillBash':
    case 'KillShell':
    case 'TaskStop':
      return { tool_kind: 'execute', title: 'Stop a background task' }
    case 'Glob':
      return named('search', `Find ${line(str(input.pattern) ?? '')}`.trim())
    case 'Grep':
      return named('search', `Search ${line(str(input.pattern) ?? '')}`.trim())
    case 'LS':
      return named('search', path ? `List ${path}` : 'List')
    case 'WebFetch':
      return { tool_kind: 'fetch', title: line(str(input.url) ?? 'Fetch') }
    case 'WebSearch':
      return { tool_kind: 'fetch', title: `Search the web: ${line(str(input.query) ?? '')}` }
    case 'Task':
    case 'Agent':
      return { tool_kind: 'think', title: line(str(input.description) ?? 'Subagent') }
    case 'TodoWrite':
      return { tool_kind: 'think', title: 'Update the plan' }
    case 'ExitPlanMode':
      return {
        tool_kind: 'switch_mode',
        title: 'Leave plan mode',
        ...(str(input.plan) ? { content: [{ type: 'content', ...cut(str(input.plan)!) }] } : {}),
      }
    case 'EnterPlanMode':
      return { tool_kind: 'switch_mode', title: 'Enter plan mode' }
  }
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name)
  if (mcp) return { tool_kind: 'other', title: `${mcp[1]}: ${mcp[2]}` }
  return { tool_kind: 'other', title: name || 'Tool' }
}

const PLAN_STATUS = new Set(['pending', 'in_progress', 'completed'])
const PRIORITY = new Set(['high', 'medium', 'low'])
function plan(input: Data): PlanEntry[] {
  return (Array.isArray(input.todos) ? input.todos : []).slice(0, 256).map((t) => {
    const todo = obj(t)
    const status = str(todo.status)
    const priority = str(todo.priority)
    return {
      content: (str(todo.content) ?? '').slice(0, 4096),
      status: (status && PLAN_STATUS.has(status) ? status : 'pending') as PlanEntry['status'],
      priority: (priority && PRIORITY.has(priority) ? priority : 'medium') as PlanEntry['priority'],
    }
  })
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      const p = obj(part)
      if (p.type === 'text') return str(p.text) ?? ''
      if (p.type === 'image') return '[image]'
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

/** Commands the CLI's own terminal screen handles, and its internal ones, are not offered. */
export function claudeCommands(configuration: Data): SessionCommand[] {
  const names = Array.isArray(configuration.slash_commands) ? configuration.slash_commands : []
  const terminal = new Set(
    Array.isArray(configuration.terminal_slash_commands)
      ? configuration.terminal_slash_commands
      : []
  )
  const skills = new Set(Array.isArray(configuration.skills) ? configuration.skills : [])
  const seen = new Set<string>()
  const commands: SessionCommand[] = []
  for (const name of names) {
    if (typeof name !== 'string' || !/^[^\s/_][^\s]{0,127}$/.test(name)) continue
    if (terminal.has(name) || seen.has(name)) continue
    seen.add(name)
    commands.push({ name, description: null, source: skills.has(name) ? 'skill' : 'builtin' })
    if (commands.length === 512) break
  }
  return commands
}

/** Fits an update into one journal record: inputs go first, then long content is cut. */
export function bounded(update: SessionUpdate): SessionUpdate {
  const size = () => JSON.stringify(update).length
  if (size() <= 96 * 1024) return update
  if ('raw_input' in update) {
    const { raw_input: _drop, ...rest } = update
    update = rest as SessionUpdate
    if (size() <= 96 * 1024) return update
  }
  if ('content' in update && Array.isArray(update.content))
    update = {
      ...update,
      content: update.content.slice(0, 8).map((c) =>
        c.type === 'diff'
          ? {
              ...c,
              old_text: c.old_text === null ? null : c.old_text.slice(0, 4096),
              new_text: c.new_text.slice(0, 4096),
              truncated: true,
            }
          : { ...c, text: c.text.slice(0, 8192), truncated: true }
      ),
    }
  return update
}

export function claudeSessionUpdates(type: string, data: unknown): SessionUpdate[] {
  return mapClaude(type, obj(data)).map(bounded)
}

function mapClaude(type: string, d: Data): SessionUpdate[] {
  const message_id = str(d.message_id)
  switch (type) {
    case 'claude.block.delta': {
      const text = str(d.text)
      if (!message_id || !text) return []
      return [
        { kind: 'agent_message_chunk', message_id, block: block(d.index), text, ...parentOf(d) },
      ]
    }
    case 'claude.thinking': {
      if (!message_id) return []
      const text = str(d.text) ?? ''
      // A streamed delta carries an estimate; the thinking of a finished message does not.
      if (Object.hasOwn(d, 'estimated_tokens'))
        return text
          ? [
              {
                kind: 'agent_thought_chunk',
                message_id,
                block: block(d.index),
                text,
                ...parentOf(d),
              },
            ]
          : []
      return [
        {
          kind: 'agent_thought',
          message_id,
          block: block(d.index),
          ...cut(text),
          ...(text ? {} : { redacted: true }),
          ...parentOf(d),
        },
      ]
    }
    case 'claude.message.final': {
      if (!message_id || d.role !== 'assistant' || !Array.isArray(d.content)) return []
      const indices = Array.isArray(d.block_indices) ? d.block_indices : []
      const updated = Array.isArray(d.updated_indices) ? new Set(d.updated_indices) : null
      const updates: SessionUpdate[] = []
      d.content.forEach((b, i) => {
        const content = obj(b)
        const index = block(indices[i]) ?? i
        if (content.type !== 'text' || (updated && !updated.has(index))) return
        updates.push({
          kind: 'agent_message',
          message_id,
          block: index,
          ...cut(str(content.text) ?? ''),
          ...parentOf(d),
        })
      })
      return updates
    }
    case 'claude.tool.call': {
      const tool_call_id = str(d.tool_use_id)
      if (!tool_call_id) return []
      const name = str(d.name) ?? ''
      const input = obj(d.input)
      const call: SessionUpdate = {
        kind: 'tool_call',
        tool_call_id,
        ...describeClaudeTool(name, input),
        status: 'pending',
        name: name.slice(0, 256),
        raw_input: input,
        ...parentOf(d),
      }
      return name === 'TodoWrite' ? [call, { kind: 'plan', entries: plan(input) }] : [call]
    }
    case 'claude.tool.result': {
      const tool_call_id = str(d.tool_use_id)
      if (!tool_call_id) return []
      const text = resultText(d.content)
      return [
        {
          kind: 'tool_call_update',
          tool_call_id,
          status: d.is_error === true ? 'failed' : 'completed',
          ...(text ? { content: [{ type: 'content', ...cut(text) }] } : {}),
        },
      ]
    }
    case 'claude.init': {
      const c = obj(d.configuration)
      if (!Object.keys(c).length) return []
      const updates: SessionUpdate[] = [
        { kind: 'available_commands_update', commands: claudeCommands(c) },
      ]
      const mode = str(c.permissionMode)
      if (mode) updates.push({ kind: 'current_mode_update', mode_id: mode.slice(0, 64) })
      const model = str(c.model)
      if (model)
        updates.push({
          kind: 'config_option_update',
          options: [
            { id: 'model', name: 'Model', category: 'model', current_value: model.slice(0, 256) },
          ],
        })
      return updates
    }
    case 'claude.status': {
      const updates: SessionUpdate[] = []
      const mode = str(d.permission_mode)
      if (mode) updates.push({ kind: 'current_mode_update', mode_id: mode.slice(0, 64) })
      if (d.status === 'compacting') updates.push({ kind: 'compaction_update', state: 'started' })
      else if (str(d.compact_result) && d.compact_result !== 'success')
        updates.push({
          kind: 'compaction_update',
          state: 'failed',
          error: str(d.compact_error)?.slice(0, 256) ?? null,
        })
      return updates
    }
    case 'claude.compact.boundary':
      return [
        {
          kind: 'compaction_update',
          state: 'completed',
          trigger: str(d.trigger)?.slice(0, 32) ?? null,
          pre_tokens: num(d.pre_tokens),
          post_tokens: num(d.post_tokens),
        },
      ]
    case 'compaction.summary': {
      const text = str(d.text)
      return text ? [{ kind: 'compaction_summary', ...cut(text) }] : []
    }
    case 'claude.unsupported_tool':
      return [
        {
          kind: 'notice',
          level: 'warning',
          code: 'unsupported_tool',
          text: `${str(d.tool_name) ?? 'A tool'}: ${str(d.reason) ?? 'unsupported'}`.slice(0, 4096),
        },
      ]
    case 'claude.rate_limit': {
      const info = obj(d.info)
      const status = str(info.status)
      if (status !== 'rejected' && status !== 'allowed_warning') return []
      const resets = num(info.resetsAt)
      return [
        {
          kind: 'notice',
          level: status === 'rejected' ? 'error' : 'warning',
          code: 'rate_limit',
          text:
            (status === 'rejected' ? 'Usage limit reached' : 'Usage limit close') +
            (resets ? `, resets ${new Date(resets * 1000).toISOString()}` : ''),
        },
      ]
    }
  }
  return []
}
