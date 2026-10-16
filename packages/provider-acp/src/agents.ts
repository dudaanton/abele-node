// The agents this node can start over ACP: a built-in list the owner can change, extend or switch
// off in the node's state directory. An agent whose command is not installed is listed as unavailable.
import { accessSync, constants, readFileSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'

export interface AcpAgentConfig {
  /** The name sessions are created with. */
  id: string
  /** What the owner sees. */
  name: string
  command: string
  args: string[]
  /** Added to the node's environment for this agent only. */
  env: Record<string, string>
  enabled: boolean
}
export interface AcpAgent extends AcpAgentConfig {
  /** The resolved executable, when the command is installed. */
  executable?: string
  available: boolean
  diagnostic: string | null
}
export const AGENTS_FILE = 'acp-agents.json'
export const AGENT_ID = /^[a-z0-9][a-z0-9_-]{0,31}$/
export const BUILTIN_AGENTS: AcpAgentConfig[] = [
  {
    id: 'gemini',
    name: 'Gemini CLI',
    command: 'gemini',
    args: ['--experimental-acp'],
    env: { GEMINI_TELEMETRY_ENABLED: 'false' },
    enabled: true,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    args: ['acp'],
    env: { OPENCODE_DISABLE_AUTOUPDATE: 'true' },
    enabled: true,
  },
]

const text = (v: unknown, max: number) =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0')
/** One entry of the owner's file; throws for anything that is not a complete, plain description. */
function parseEntry(raw: any, base?: AcpAgentConfig): AcpAgentConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('acp_agents_invalid')
  if (typeof raw.id !== 'string' || !AGENT_ID.test(raw.id)) throw new Error('acp_agents_invalid')
  const merged = { ...base, ...raw }
  if (!text(merged.name ?? merged.id, 128) || !text(merged.command, 4096))
    throw new Error('acp_agents_invalid')
  const args = merged.args ?? []
  if (
    !Array.isArray(args) ||
    args.length > 64 ||
    !args.every((a: unknown) => text(a, 4096) || a === '')
  )
    throw new Error('acp_agents_invalid')
  const env = merged.env ?? {}
  if (
    typeof env !== 'object' ||
    Array.isArray(env) ||
    !Object.entries(env).every(
      ([k, v]) =>
        /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k) && typeof v === 'string' && v.length <= 4096
    )
  )
    throw new Error('acp_agents_invalid')
  if (merged.enabled !== undefined && typeof merged.enabled !== 'boolean')
    throw new Error('acp_agents_invalid')
  return {
    id: raw.id,
    name: merged.name ?? raw.id,
    command: merged.command,
    args: [...args],
    env: { ...env },
    enabled: merged.enabled ?? true,
  }
}
/** The built-in list with the owner's file laid over it: same id changes an entry, a new id adds one. */
export function readAgentConfig(stateDir: string, builtins = BUILTIN_AGENTS): AcpAgentConfig[] {
  const agents = new Map(
    builtins.map((a) => [a.id, { ...a, args: [...a.args], env: { ...a.env } }])
  )
  let raw: string
  try {
    raw = readFileSync(join(stateDir, AGENTS_FILE), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [...agents.values()]
    throw new Error('acp_agents_unreadable')
  }
  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('acp_agents_invalid')
  }
  if (!parsed || !Array.isArray(parsed.agents) || parsed.agents.length > 64)
    throw new Error('acp_agents_invalid')
  for (const entry of parsed.agents) {
    const agent = parseEntry(entry, agents.get(entry?.id))
    agents.set(agent.id, agent)
  }
  return [...agents.values()]
}
function executable(path: string) {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}
/** An absolute command must exist as given; a bare name is looked up where installers put it. */
export function resolveCommand(command: string, path?: string): string | undefined {
  if (isAbsolute(command)) return executable(command) ? command : undefined
  if (command.includes('/')) return undefined
  // A service starts with a short PATH; installers' usual places are searched too unless one is given.
  const roots = [
    ...(path ?? process.env.PATH ?? '').split(delimiter).filter(isAbsolute),
    ...(path === undefined
      ? [join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']
      : []),
  ]
  for (const root of new Set(roots)) {
    const candidate = join(root, command)
    if (executable(candidate)) return candidate
  }
  return undefined
}
export function discoverAgents(configs: AcpAgentConfig[], path?: string): AcpAgent[] {
  return configs.map((config) => {
    if (!config.enabled) return { ...config, available: false, diagnostic: 'acp_agent_disabled' }
    const found = resolveCommand(config.command, path)
    return found
      ? { ...config, executable: found, available: true, diagnostic: null }
      : { ...config, available: false, diagnostic: 'acp_agent_not_installed' }
  })
}
