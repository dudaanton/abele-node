import type {
  ProcessIdentity,
  TurnContext,
  ProviderEventSink,
  ProviderRun,
  ProviderAction,
  Answer,
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
}
