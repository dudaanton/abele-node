// What a long-lived Codex session reports to the node. The lifecycle uses the node's
// provider-neutral `live.*` names; the command list is Codex's own record, mapped onto the
// shared session updates by the node's Codex mapper.
export const LIVE = {
  delivered: 'live.input.delivered',
  turnStarted: 'live.turn.started',
  turnCompleted: 'live.turn.completed',
  context: 'live.context',
  status: 'live.status',
  compacted: 'live.compact.boundary',
  commands: 'codex.commands',
} as const

export interface Skill {
  name: string
  description?: string
  shortDescription?: string
  path: string
}
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/

/** The "/" commands a Codex session offers: compaction, and each enabled skill by name. */
export function commandList(skills: Skill[]) {
  const commands: {
    name: string
    description: string | null
    input_hint: string | null
    source: string
  }[] = [
    {
      name: 'compact',
      description: 'Summarize the conversation to free context',
      input_hint: 'focus (optional)',
      source: 'builtin',
    },
  ]
  for (const skill of skills.slice(0, 256))
    if (typeof skill.name === 'string' && NAME.test(skill.name) && skill.name !== 'compact')
      commands.push({
        name: skill.name,
        description:
          String(skill.shortDescription ?? skill.description ?? '').slice(0, 1024) || null,
        input_hint: null,
        source: 'skill',
      })
  return commands
}

/** `/name rest` for an enabled skill becomes Codex's own skill input plus the rest as text. */
export function skillInput(text: string, skills: Skill[]) {
  const match = /^\/([^\s/]+)(?:\s+([\s\S]*))?$/.exec(text)
  if (!match) return undefined
  const skill = skills.find((s) => s.name === match[1])
  if (!skill || typeof skill.path !== 'string') return undefined
  const rest = match[2]?.trim()
  return [
    { type: 'skill', name: skill.name, path: skill.path },
    ...(rest ? [{ type: 'text', text: rest, text_elements: [] }] : []),
  ]
}

/** Codex's token usage as the node's context meter: the last request fills the window. */
export function contextUsage(usage: any, model: string | null) {
  const used = usage?.last?.totalTokens
  if (!Number.isSafeInteger(used) || used < 0) return undefined
  const window = Number.isSafeInteger(usage.modelContextWindow) ? usage.modelContextWindow : null
  return {
    total_tokens: used,
    max_tokens: window,
    percentage: window ? Math.min(100, Math.round((used / window) * 1000) / 10) : null,
    auto_compact_threshold: null,
    auto_compact_enabled: null,
    model,
    categories: [],
  }
}
