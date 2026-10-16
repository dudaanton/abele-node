import type {
  ProcessIdentity,
  TurnContext,
  ProviderEventSink,
  ProviderRun,
  ProviderAction,
  Answer,
  LiveSession,
  LiveSessionContext,
  LiveSessionSink,
  LiveSessionSettings,
} from '@abele/provider-contract'
/** Both real adapters use one queue, journal, fenced worker and prompt-delivery service. */
export interface ProviderAdapter {
  readonly available: boolean
  readonly configuration: Record<string, any>
  capabilities(): Record<string, any>
  configurationForTurn(
    turn: Pick<TurnContext, 'use_repository_claude_permissions'>
  ): Record<string, unknown>
  startTurn(
    turn: TurnContext & { native_session_file?: string },
    sink: ProviderEventSink & {
      /** Optional run-bound node reporting tool; model inputs never supply authority. */
      report?(report: unknown): { recorded: boolean }
      question?(action: ProviderAction, signal: AbortSignal): Promise<Answer>
      reaped?(leader: ProcessIdentity): void
    }
  ): Promise<ProviderRun>
  reconcile(evidence: ProcessIdentity[], ipcDirectory?: string): Promise<void>
  /** Long-lived owner sessions; absent or false means one process per message. */
  readonly liveAvailable?: boolean
  /** Providers that host several agents: whether this one can be started here. */
  agentAvailable?(agent: string): boolean
  startSession?(context: LiveSessionContext, sink: LiveSessionSink): Promise<LiveSession>
  sessionDefaults?(): LiveSessionSettings
  /** Throws for a model, effort, mode or account name this node cannot launch. */
  validateSettings?(settings: Partial<LiveSessionSettings>): void
}
