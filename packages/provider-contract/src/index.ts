export { recoverProviderLauncher } from './launcher.js'
export { ActiveDeadline } from './deadline.js'
export { ToolWaitDeadline } from './tool-deadline.js'

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
  durable_permissions?: boolean
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
  call(name: string, args: unknown, signal?: AbortSignal, callId?: string): Promise<any>
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
/** Per-session choices for a long-lived provider process. Names, never paths or secrets. */
export interface LiveSessionSettings {
  model: string
  effort: string
  /** A named Claude configuration known to the node; 'default' inherits the node's own. */
  account: string
  permission_mode: string
}
export interface LiveSessionContext {
  session_id: string
  run_id: string
  cwd: string
  native_session_id?: string
  /** The exact native session file to reopen, for providers that keep one (pi). */
  native_session_file?: string
  /** Which configured agent a provider that hosts several (ACP) starts. */
  agent?: string
  /** What a recorded Codex thread was bound under; resuming it anywhere else is refused. */
  native_binding?: { workspace_path: string; policy_fingerprint: string; model: string }
  /** Copy the native transcript from this account's configuration before resuming. */
  previous_account?: string
  use_repository_claude_permissions?: boolean
  settings: LiveSessionSettings
  /** How long a permission question waits for the owner before it is denied. */
  permission_ttl_ms: number
  /** Re-attach to a process an earlier node left running instead of starting one. */
  adopt?: LiveAdoption
}
/** What the node journaled of a process it left running, so another node can take it over. */
export interface LiveAdoption {
  /** The provider's own record, as it last reported it through `attachment`. */
  record: Record<string, unknown>
  /** Stream position up to which everything was journaled. */
  offset: number
  /** A turn was running when the earlier node stopped reading. */
  running: boolean
  /** Inputs the running turn already took. */
  delivered: string[]
  /** Inputs written into the process that it had not taken yet. */
  dispatching: LiveInput[]
}
export interface LiveInput {
  input_id: string
  /** Plain text or provider content blocks, written as one user message. */
  content: string | Record<string, unknown>[]
}
export interface LiveSessionSink {
  debugger?: DebuggerToolBridge
  event(event: ProviderEvent): void
  processes(evidence: ProcessIdentity[]): void
  ipc?(directory: string): void
  permission(action: ProviderAction, signal: AbortSignal): Promise<Answer>
  /** A record another node needs to re-attach to this process; replaces the previous one. */
  attachment?(record: Record<string, unknown>): void
  /** Everything up to this stream position has been reported. */
  checkpoint?(offset: number): void
}
/** One provider process that outlives turns. Turns are reported as events, not as calls. */
export interface LiveSession {
  /** Settles when the process is gone and its cleanup is confirmed (or not). */
  done: Promise<{ reason?: string; exit_code?: number | null; signal?: string | null }>
  /** Writes one user message into the running process; the CLI queues it. */
  send(input: LiveInput): void
  /** Stops the current turn and keeps the process. */
  interrupt(): Promise<void>
  /** A provider control request answered on the same stream. */
  control(subtype: string, params?: Record<string, unknown>): Promise<Record<string, any>>
  /** Ends the process and every process it started. */
  stop(reason?: string): Promise<void>
  /** Stops reading and leaves the process running for a later node to adopt. */
  detach?(): Promise<void>
}
