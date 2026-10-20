import type { SessionUpdate, SessionUpdateOf, ToolContent } from './session-update.js'

/**
 * pi's journal records (`pi.*`) as session updates. Pure and stateless, like the Claude mapping:
 * the node maps each record as it is written, and a client replays a journal written before it
 * did. Records kept as artifacts carry no fields and map to nothing. The lifecycle a long-lived
 * session turns into node events (turns, context, a finished compaction) is not mapped here.
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
const block = (v: unknown) => (Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : null)
/** Message counters restart with each worker; the run (when the record has it) and the
 * runtime generation keep two messages apart. */
const messageId = (d: Data) =>
  [str(d.run_id), d.runtime_generation, str(d.message_id)]
    .filter((v) => v !== undefined && v !== null)
    .join(':')
    .slice(0, 256)
const parentOf = (d: Data) => ({ parent_tool_call_id: str(d.parent_tool_use_id) ?? null })

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

/** pi's built-in tools by name; anything else (extension and node tools) is `other`. */
export function describePiTool(
  name: string,
  input: Data
): Omit<SessionUpdateOf<'tool_call'>, 'kind' | 'tool_call_id'> {
  const path = str(input.path)
  const at = path ? [{ path, line: num(input.offset) }] : undefined
  const named = (tool_kind: SessionUpdateOf<'tool_call'>['tool_kind'], title: string) => ({
    tool_kind,
    title,
    ...(at ? { locations: at } : {}),
  })
  switch (name) {
    case 'read':
      return named('read', path ? `Read ${path}` : 'Read')
    case 'write':
      return {
        ...named('edit', path ? `Write ${path}` : 'Write'),
        ...(path ? { content: [diff(path, null, str(input.content) ?? '')] } : {}),
      }
    case 'edit': {
      const edits = Array.isArray(input.edits) ? input.edits.slice(0, 64).map(obj) : [input]
      return {
        ...named('edit', path ? `Edit ${path}` : 'Edit'),
        ...(path
          ? {
              content: edits.map((e) => diff(path, str(e.oldText) ?? '', str(e.newText) ?? '')),
            }
          : {}),
      }
    }
    case 'bash': {
      const command = str(input.command) ?? ''
      return { tool_kind: 'execute', title: command ? line(command) : 'Run a command' }
    }
    case 'grep': {
      const pattern = str(input.pattern) ?? ''
      return named('search', `Search ${line(pattern, 128)}${path ? ` in ${path}` : ''}`)
    }
    case 'find': {
      const pattern = str(input.pattern) ?? ''
      return named('search', `Find ${line(pattern, 128)}${path ? ` in ${path}` : ''}`)
    }
    case 'ls':
      return named('read', path ? `List ${path}` : 'List files')
    default:
      return { tool_kind: 'other', title: name.slice(0, 256) || 'Tool' }
  }
}

/** The text of a tool result: its text blocks, or the text itself. */
function resultText(result: unknown) {
  if (typeof result === 'string') return result
  const content = obj(result).content
  if (!Array.isArray(content)) return ''
  return content
    .map(obj)
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text as string)
    .join('\n')
}

export function piSessionUpdates(type: string, data: unknown): SessionUpdate[] {
  const d = obj(data)
  switch (type) {
    case 'pi.message.delta': {
      const delta = obj(d.delta)
      const text = str(delta.delta)
      if (!text) return []
      const at = { message_id: messageId(d), block: block(delta.contentIndex) }
      if (delta.type === 'text_delta') return [{ kind: 'agent_message_chunk', ...at, text }]
      if (delta.type === 'thinking_delta') return [{ kind: 'agent_thought_chunk', ...at, text }]
      return []
    }
    case 'pi.message.final': {
      const message = obj(d.message)
      if (message.role !== 'assistant' || !Array.isArray(message.content)) return []
      const message_id = messageId(d)
      const updates: SessionUpdate[] = []
      message.content.map(obj).forEach((b, index) => {
        if (b.type === 'text' && typeof b.text === 'string')
          updates.push({ kind: 'agent_message', message_id, block: index, ...cut(b.text) })
        else if (b.type === 'thinking' && typeof b.thinking === 'string')
          updates.push({
            kind: 'agent_thought',
            message_id,
            block: index,
            ...cut(b.thinking),
            ...(b.redacted === true ? { redacted: true } : {}),
          })
      })
      if (str(message.stopReason) === 'error')
        updates.push({ kind: 'notice', level: 'error', text: 'The model request failed' })
      return updates
    }
    case 'pi.tool.call': {
      const tool_call_id = str(d.tool_use_id)
      const name = str(d.name) ?? ''
      if (!tool_call_id) return []
      const input = obj(d.input)
      return [
        {
          kind: 'tool_call',
          tool_call_id,
          ...describePiTool(name, input),
          status: 'in_progress',
          name: name.slice(0, 256),
          raw_input: input,
          ...parentOf(d),
        },
      ]
    }
    case 'pi.tool.update':
    case 'pi.tool.result': {
      const tool_call_id = str(d.tool_use_id)
      if (!tool_call_id) return []
      const text = resultText(d.result)
      const done = type === 'pi.tool.result'
      return [
        {
          kind: 'tool_call_update',
          tool_call_id,
          status: !done ? 'in_progress' : d.is_error === true ? 'failed' : 'completed',
          ...(text ? { content: [{ type: 'content', ...cut(text) }] } : {}),
        },
      ]
    }
    case 'pi.commands': {
      // Run by sending `/name input`; a name the shared list cannot carry is left out.
      const names = new Set<string>()
      const commands = (Array.isArray(d.commands) ? d.commands : [])
        .map(obj)
        .filter((c) => {
          const name = str(c.name)
          if (!name || !/^[^\s/][^\s]{0,127}$/.test(name) || names.has(name)) return false
          names.add(name)
          return true
        })
        .slice(0, 512)
        .map((c) => ({
          name: c.name as string,
          description: str(c.description)?.slice(0, 512) ?? null,
          ...(str(c.source) ? { source: str(c.source)!.slice(0, 32) } : {}),
        }))
      return [{ kind: 'available_commands_update', commands }]
    }
    case 'pi.model.catalog': {
      const model = str(d.model_id)
      if (!model) return []
      const models = (Array.isArray(d.models) ? d.models : [])
        .map(obj)
        .filter((m) => str(m.value) && str(m.name))
        .slice(0, 256)
        .map((m) => ({ value: String(m.value).slice(0, 256), name: String(m.name).slice(0, 256) }))
      return [
        {
          kind: 'config_option_update',
          options: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              current_value: model.slice(0, 256),
              options: models,
            },
            {
              id: 'account',
              name: 'Account',
              category: 'other',
              current_value: 'default',
              options: [
                {
                  value: 'default',
                  name: (str(d.account_label) ?? 'pi credentials on this node').slice(0, 256),
                },
              ],
            },
          ],
        },
      ]
    }
    case 'pi.model.selected': {
      const model = str(d.model_id)
      return model
        ? [
            {
              kind: 'config_option_update',
              options: [
                {
                  id: 'model',
                  name: 'Model',
                  category: 'model',
                  current_value: model.slice(0, 256),
                },
              ],
            },
          ]
        : []
    }
    case 'pi.thinking_level_changed': {
      const level = str(d.level)
      return level
        ? [
            {
              kind: 'config_option_update',
              options: [
                {
                  id: 'thought_level',
                  name: 'Thinking',
                  category: 'thought_level',
                  current_value: level.slice(0, 256),
                },
              ],
            },
          ]
        : []
    }
    case 'pi.compaction_start':
      return [
        {
          kind: 'compaction_update',
          state: 'started',
          trigger: d.reason === 'manual' ? 'manual' : 'auto',
        },
      ]
    case 'pi.compaction_end':
      // A finished one is the node's own compaction.completed; only a failure is said here.
      return d.aborted === true || !d.result
        ? [
            {
              kind: 'compaction_update',
              state: 'failed',
              trigger: d.reason === 'manual' ? 'manual' : 'auto',
              error: d.aborted === true ? 'aborted' : 'compaction_failed',
            },
          ]
        : []
    case 'compaction.summary': {
      const text = str(d.text)
      return text ? [{ kind: 'compaction_summary', ...cut(text) }] : []
    }
    case 'pi.auto_retry_start':
      return [
        {
          kind: 'notice',
          level: 'warning',
          text: `The model request failed; retrying (attempt ${num(d.attempt) ?? '?'} of ${num(d.maxAttempts) ?? '?'})`,
          code: 'retry',
        },
      ]
    case 'pi.ui.notification': {
      const text = str(d.message)
      const level = d.level === 'error' || d.level === 'warning' ? d.level : 'info'
      return text ? [{ kind: 'notice', level, text: text.slice(0, 4096) }] : []
    }
    case 'pi.capability.error':
      return [
        {
          kind: 'notice',
          level: 'warning',
          text: `An extension asked for ${line(str(d.capability) ?? 'a feature', 64)}, which this node does not offer`,
          code: 'unsupported_extension_ui',
        },
      ]
    case 'pi.extension.error':
    case 'pi.extension.warning':
      return [
        {
          kind: 'notice',
          level: type === 'pi.extension.warning' ? 'warning' : 'error',
          text: str(d.extension)
            ? `pi extension ${line(str(d.extension)!, 256)} failed${str(d.event) ? ` (${line(str(d.event)!, 128)})` : ''}: ${line(str(d.error) ?? 'Unknown error', 2048)}`
            : 'A pi extension failed',
          code: type === 'pi.extension.warning' ? 'extension_warning' : 'extension_error',
        },
      ]
  }
  return []
}
