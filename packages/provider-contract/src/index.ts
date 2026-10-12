export { recoverProviderLauncher } from './launcher.js'

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
export interface DebuggerToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, any>
}
/** Trusted node closure, not model-supplied identity. Call during the active
 * turn, never by queueing chat input. publish rechecks at actual IPC delivery. */
export interface DebuggerToolBridge {
  readonly tools: DebuggerToolDefinition[]
  call(name: string, args: unknown, signal?: AbortSignal): Promise<any>
  publish(args: unknown, result: any): any
  close(): void
}
/** Thin plugin-agent embedding: register these definitions in the host's tool
 * registry. There is deliberately no chat/follow-up or model-start callback. */
export function bindDebuggerTools(bridge: DebuggerToolBridge) {
  return bridge.tools.map((tool) => ({
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    async execute(_modelCallId: string, args: unknown, signal?: AbortSignal) {
      const result = bridge.publish(args, await bridge.call(tool.name, args, signal))
      return { content: [{ type: 'text' as const, text: JSON.stringify(result) }], details: result }
    },
  }))
}
export interface ProviderEventSink {
  debugger?: DebuggerToolBridge
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
