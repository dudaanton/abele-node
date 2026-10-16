import type {
  LiveSession,
  LiveSessionContext,
  LiveSessionSettings,
  LiveSessionSink,
  ProcessIdentity,
  ProcessProbe,
  ProviderRun,
} from '@abele/provider-contract'
import { ProcessSupervisor, systemProcessProbe } from '@abele/provider-claude'
import { isAbsolute } from 'node:path'
import { discoverAgents, readAgentConfig, AGENT_ID, AGENTS_FILE, type AcpAgent } from './agents.js'
import { startAcpSession, ACP_PROTOCOL_VERSION } from './session.js'

export interface AcpOptions {
  stateDir: string
  enabled?: boolean
  /** How long a permission question waits for the owner before it is denied. */
  permissionTtlMs?: number
  /** Replaces the PATH the agents' commands are looked up in. */
  path?: string
  processProbe?: ProcessProbe
  setupTimeoutMs?: number
  clientVersion?: string
}
const MODES = ['manual', 'bypassPermissions']

/** Agents that speak the Agent Client Protocol over stdio, each session one long-lived process. */
export class AcpProviderAdapter {
  readonly configuration: Record<string, any>
  readonly liveAvailable = true
  private agents: AcpAgent[] = []
  private readAt = 0
  private diagnostic: string | null = null
  private probe: ProcessProbe
  constructor(private options: AcpOptions) {
    const ttl = options.permissionTtlMs ?? 30 * 60000
    if (!isAbsolute(options.stateDir) || !Number.isSafeInteger(ttl) || ttl < 1 || ttl > 86400000)
      throw new Error('invalid_acp_configuration')
    this.probe = options.processProbe ?? systemProcessProbe
    this.configuration = {
      permission_ttl_ms: ttl,
      session_permission_ttl_ms: ttl,
      agents_file: AGENTS_FILE,
      approval_policy:
        'Every permission question is shown to the owner and answered once; "always" answers are never given. In bypass mode the node allows single actions itself and journals each one.',
    }
    this.refresh()
  }
  /** Re-reads the agent list and looks the commands up again. */
  refresh() {
    this.readAt = Date.now()
    if (this.options.enabled === false) {
      this.agents = []
      this.diagnostic = 'acp_disabled'
      return this.agents
    }
    try {
      this.agents = discoverAgents(readAgentConfig(this.options.stateDir), this.options.path)
      this.diagnostic = this.agents.some((a) => a.available) ? null : 'acp_no_agent_installed'
    } catch (error) {
      this.agents = []
      this.diagnostic = error instanceof Error ? error.message : 'acp_agents_invalid'
    }
    return this.agents
  }
  /** The list as of a few seconds ago: an agent installed later shows up without a restart. */
  private current() {
    return Date.now() - this.readAt > 5000 ? this.refresh() : this.agents
  }
  get available() {
    return this.current().some((a) => a.available)
  }
  agentAvailable(id: string) {
    return this.current().find((a) => a.id === id)?.available ?? false
  }
  capabilities() {
    this.current()
    return {
      provider: 'acp',
      provider_version: String(ACP_PROTOCOL_VERSION),
      available: this.available,
      diagnostic: this.diagnostic,
      live_sessions: true,
      session_defaults: this.sessionDefaults(),
      permission_modes: MODES,
      agents: this.agents.map((a) => ({
        id: a.id,
        name: a.name,
        available: a.available,
        diagnostic: a.diagnostic,
      })),
      configuration: this.configuration,
      capabilities: {
        long_lived_sessions: this.available
          ? { status: 'supported', evidence: 'acp-v1-stdio-client' }
          : { status: 'unverified', reason: this.diagnostic ?? 'acp_no_agent_installed' },
      },
    }
  }
  configurationForTurn() {
    return this.configuration
  }
  sessionDefaults(): LiveSessionSettings {
    return { model: 'default', effort: 'medium', account: 'default', permission_mode: 'manual' }
  }
  validateSettings(settings: Partial<LiveSessionSettings>) {
    if (settings.account !== undefined && settings.account !== 'default')
      throw new Error('invalid_session_settings')
    if (settings.permission_mode !== undefined && !MODES.includes(settings.permission_mode))
      throw new Error('invalid_session_settings')
  }
  async reconcile(evidence: ProcessIdentity[]) {
    await ProcessSupervisor.cleanup(evidence, 300, this.probe)
  }
  /** Delegated work runs one process per message; ACP agents are owner sessions only. */
  async startTurn(): Promise<ProviderRun> {
    throw new Error('acp_bounded_unsupported')
  }
  async startSession(context: LiveSessionContext, sink: LiveSessionSink): Promise<LiveSession> {
    if (!context.agent || !AGENT_ID.test(context.agent)) throw new Error('acp_agent_required')
    const agent = this.refresh().find((a) => a.id === context.agent)
    if (!agent?.available || !agent.executable)
      throw new Error(agent?.diagnostic ?? 'acp_agent_unknown')
    this.validateSettings(context.settings)
    return startAcpSession(
      {
        agent: { ...agent, executable: agent.executable },
        probe: this.probe,
        ...(this.options.setupTimeoutMs ? { setupTimeoutMs: this.options.setupTimeoutMs } : {}),
        ...(this.options.clientVersion ? { clientVersion: this.options.clientVersion } : {}),
      },
      context,
      sink
    )
  }
}
