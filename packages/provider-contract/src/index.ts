export interface ProcessIdentity {
  pid: number
  fingerprint: string
  group: number
}
export interface ProcessProbe {
  identity(pid: number): ProcessIdentity | undefined
  groupMembers(leader: ProcessIdentity): ProcessIdentity[]
}
export interface ProviderEvent {
  type: string
  data: Record<string, any>
}
export interface PermissionAction {
  tool_use_id: string
  tool_name: string
  input: Record<string, unknown>
}
export interface ProviderAction extends PermissionAction {
  native_session_id?: string
  kind?: 'permission' | 'select' | 'confirm' | 'input' | 'trust'
  title?: string
  options?: string[]
  ttl_ms?: number
}
export interface Answer {
  choice: 'allow' | 'deny'
  value?: string
  delivered(): boolean | void
}
export interface TurnContext {
  session_id: string
  run_id: string
  cwd: string
  text: string
  native_session_id?: string
  native_session_file?: string
  native_binding?: { workspace_path: string; policy_fingerprint: string; model: string }
  use_repository_claude_permissions?: boolean
}
export interface ProviderEventSink {
  event(event: ProviderEvent): void
  processes(evidence: ProcessIdentity[]): void
  ipc?(directory: string): void
  permission(action: PermissionAction, signal: AbortSignal): Promise<Answer>
  question?(action: ProviderAction, signal: AbortSignal): Promise<Answer>
  report?(report: unknown): { recorded: boolean }
  reaped?(leader: ProcessIdentity): void
}
export interface ProviderRun {
  done: Promise<{ result?: Record<string, any>; reason?: string }>
  interrupt(): Promise<void>
}
