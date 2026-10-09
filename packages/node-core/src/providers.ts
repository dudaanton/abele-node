import type {
  ProcessIdentity,
  TurnContext,
  ProviderEventSink,
  ProviderRun,
} from '@abele/provider-claude'
import type { PiAction, Answer } from '@abele/provider-pi'
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
      question?(action: PiAction, signal: AbortSignal): Promise<Answer>
      reaped?(leader: ProcessIdentity): void
    }
  ): Promise<ProviderRun>
  reconcile(evidence: ProcessIdentity[], ipcDirectory?: string): Promise<void>
}
