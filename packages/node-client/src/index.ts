import {
  ChannelError,
  FrameCodec,
  type NodeConnection,
  type AuthenticatedChannel,
  type ChannelConnector,
  type JournalEvent,
} from '@abele/channel-protocol'
import { LocalChannelConnector, RequestChannel, reconnect } from '@abele/channel-client'
import { DebuggerClient } from './debugger.js'
export { DebuggerClient } from './debugger.js'
export { TraceClient } from './trace.js'
import { TraceClient } from './trace.js'
export type { DebuggerObservationState } from './debugger.js'
import {
  SessionSchema,
  SessionDeletedSchema,
  MethodSchemas,
  DelegationSchema,
  DelegationStatusSchema,
  DelegationSendResultSchema,
  DelegationGrantSchema,
  DelegationGrantRequestSchema,
  type DelegationGrant,
  type Delegation,
  type DelegationCreateRequest,
  type DelegationGrantRequest,
  type DelegationStatus,
  type DelegationSendResult,
  PromptSchema,
  NodeEventSchema,
  validateParams,
  type Prompt,
  type FakeStep,
  ProjectSchema,
  WorkspaceSchema,
  JobSchema,
  WorkspaceJobResultSchema,
  WorkspaceStatusSchema,
  WorkspaceDiffSchema,
  FilePageSchema,
  FileEntrySchema,
  FileContentSchema,
  ContentChunkSchema,
  DiffSnapshotSchema,
  ReviewResultSchema,
  FileMutationResultSchema,
  RepositorySettingsSchema,
  type FileWrite,
  type FileRestore,
  type ReviewBatch,
  type DiffMode,
  type ExpectedExecutionTarget,
  type TurnAdmissionResult,
  TurnAdmissionResultSchema,
  TurnAcceptedSchema,
  LiveSessionStateSchema,
  type SessionSettings,
} from '@abele/node-protocol'
import { NodePathClient } from './node-path.js'
export * from './node-path.js'
import { RepositoryClient } from './repository.js'
export * from './repository.js'
export { LocalChannelConnector, reconnect }
export { PairedWssConnector, type DeviceKeyStore, type PairedDevice } from './paired.js'
export {
  PairingSession,
  type PairingAdapters,
  type PairingDetails,
  type PairingState,
} from './pairing-session.js'
export {
  LocalDiscovery,
  type DesktopRuntime,
  type LocalNode,
  type LocalRegistration,
} from './local-discovery.js'
export type { PairingInvite } from '@abele/node-protocol'
export type { NodeConnection, ChannelConnector, RecordTransport } from '@abele/channel-protocol'
export type {
  Prompt,
  FakeStep,
  Project,
  Workspace,
  Job,
  ReviewAnchor,
  ReviewBatch,
  DiffSnapshot,
  DiffMode,
  FileWrite,
  FileRestore,
  FileMutationResult,
  Delegation,
  DelegationStatus,
  DelegationSendResult,
  DelegationGrant,
  DelegationCreateRequest,
  DelegationGrantRequest,
  WorkerReport,
  ExecutionTarget,
  ExpectedExecutionTarget,
  TargetChangedRefusal,
  TurnAdmissionResult,
  SessionSendRequest,
  ReviewResult,
} from '@abele/node-protocol'
export {
  ExecutionTargetSchema,
  ExpectedExecutionTargetSchema,
  TargetChangedRefusalSchema,
  TurnAdmissionResultSchema,
} from '@abele/node-protocol'
export interface OutboxEntry {
  operation_id: string
  method: string
  params: unknown
}
const normalizedRequest = (method: string, params: unknown) =>
  JSON.stringify([method, validateParams(method, params)], (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value
  )
export interface ClientState {
  operationRequests?: Record<string, { method: string; params: unknown }>
  node_id?: string
  installation_id?: string
  cursors: Record<string, number>
  events: Record<string, JournalEvent[]>
  outbox: OutboxEntry[]
  results: Record<
    string,
    { result?: unknown; error?: string; request?: { method: string; params: unknown } }
  >
}
/** Each transaction must isolate, atomically commit and roll back on rejection. Namespace by installation. */
export interface ClientStore {
  transaction<T>(work: (state: ClientState) => T | Promise<T>): Promise<T>
}
export class MemoryClientStore implements ClientStore {
  private state: ClientState = { cursors: {}, events: {}, outbox: [], results: {} }
  private serial: Promise<unknown> = Promise.resolve()
  fault?: () => void
  transaction<T>(work: (state: ClientState) => T | Promise<T>): Promise<T> {
    const task = this.serial.then(async () => {
      const next = structuredClone(this.state)
      const result = await work(next)
      this.fault?.()
      this.state = next
      return structuredClone(result)
    })
    this.serial = task.catch(() => {})
    return task
  }
}
export class NodeClient {
  readonly nodePath = new NodePathClient(
    (method, params) => this.request(method, params),
    (method, params, operation) => this.mutation(method, params, operation)
  )
  readonly debugger = new DebuggerClient((method, params) => this.request(method, params))
  readonly trace = new TraceClient((method, params) => this.request(method, params))
  readonly repository = new RepositoryClient((method, params) => this.request(method, params), {
    mutation: (method, params, operation) => this.mutation(method, params, operation),
    save: async (method, params, operation) => {
      const operation_id = await this.enqueue(method, params, operation)
      if (this.connected) await this.flush().catch(() => {})
      return { operation_id }
    },
    result: (operation) => this.operationResult(operation),
  })
  private channel?: RequestChannel
  private flushing?: Promise<void>
  private listeners = new Set<(event: JournalEvent) => void>()
  constructor(
    readonly target: NodeConnection,
    readonly store: ClientStore,
    private connector: ChannelConnector = new LocalChannelConnector()
  ) {}
  get connected() {
    return !!this.channel
  }
  async connect() {
    await this.disconnect()
    const stored = await this.store.transaction((s) => s.node_id)
    if (stored && this.target.expected_node_id && stored !== this.target.expected_node_id)
      throw new ChannelError('node_identity_mismatch')
    const channel = await this.connector.connect({
      ...this.target,
      ...(stored ? { expected_node_id: stored } : {}),
    })
    try {
      await this.store.transaction((s) => {
        if (s.node_id && s.node_id !== channel.welcome.node_id)
          throw new ChannelError('node_identity_mismatch')
        if (s.installation_id && s.installation_id !== channel.authority.installation_id)
          throw new ChannelError('installation_identity_mismatch')
        s.node_id = channel.welcome.node_id
        s.installation_id = channel.authority.installation_id
      })
    } catch (error) {
      await channel.transport.close('identity_mismatch')
      throw error
    }
    this.attach(channel)
    this.channel!.start()
    const streams = await this.store.transaction((s) => Object.keys(s.cursors))
    for (const stream of streams) await this.subscribe(stream)
    await this.flush()
  }
  /** For injected transport tests/adapters; connect() is the usual API. */
  attach(channel: AuthenticatedChannel) {
    const requests = new RequestChannel(channel)
    this.channel = requests
    requests.onEvent = (event) => this.ingest(event)
    requests.onClose = () => {
      if (this.channel === requests) {
        this.debugger.disconnected()
        this.channel = undefined
      }
    }
  }
  async disconnect() {
    this.debugger.disconnected()
    const channel = this.channel
    this.channel = undefined
    await channel?.close()
  }
  onEvent(listener: (event: JournalEvent) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  async ingest(raw: unknown) {
    const event = NodeEventSchema.parse(raw)
    let outcome: 'gap' | 'duplicate' | 'stored'
    try {
      outcome = await this.store.transaction((s) => {
        if (s.node_id !== event.node_id) throw new ChannelError('node_identity_mismatch')
        const cursor = s.cursors[event.stream_id] ?? 0
        if (event.seq <= cursor) return 'duplicate'
        if (event.seq !== cursor + 1) return 'gap'
        const history = (s.events[event.stream_id] ??= [])
        history.push(event)
        s.cursors[event.stream_id] = event.seq
        return 'stored'
      })
    } catch (error) {
      await this.channel?.channel.transport.close('cursor_storage_failure')
      throw error
    }
    const seq = await this.cursor(event.stream_id)
    if (this.channel)
      await this.channel.channel.transport.send(
        FrameCodec.encode({
          kind: 'request',
          request_id: crypto.randomUUID(),
          method: outcome === 'gap' ? 'stream.subscribe' : 'stream.ack',
          params:
            outcome === 'gap'
              ? { stream_id: event.stream_id, after_seq: seq }
              : { stream_id: event.stream_id, seq },
        })
      )
    if (outcome === 'stored')
      for (const listener of this.listeners) {
        try {
          listener(event)
        } catch {
          /* presentation cannot undo durable cursor */
        }
      }
  }
  cursor(stream: string) {
    return this.store.transaction((s) => s.cursors[stream] ?? 0)
  }
  history(stream: string) {
    return this.store.transaction((s) => s.events[stream] ?? [])
  }
  pending() {
    return this.store.transaction((s) => s.outbox)
  }
  operationResult(operation: string) {
    return this.store.transaction((s) => s.results[operation])
  }
  async subscribe(stream: string) {
    await this.store.transaction((s) => {
      s.cursors[stream] ??= 0
    })
    return this.request('stream.subscribe', {
      stream_id: stream,
      after_seq: await this.cursor(stream),
    })
  }
  request(method: string, params: unknown): Promise<unknown> {
    if (!this.channel) return Promise.reject(new ChannelError('disconnected'))
    return this.channel.request(method, params)
  }
  async listSessions(after_id?: string) {
    const result = await this.request('session.list', { ...(after_id ? { after_id } : {}) })
    if (!Array.isArray(result)) throw new ChannelError('invalid_result')
    return result.map((r) => SessionSchema.parse(r))
  }
  private async mutation(method: string, params: unknown, operation?: string) {
    if (!this.connected) throw new ChannelError('disconnected')
    const operation_id = await this.enqueue(method, params, operation)
    await this.flush()
    const receipt = await this.operationResult(operation_id)
    if (!receipt) throw new ChannelError('outcome_unknown')
    if (receipt.error) throw new ChannelError(receipt.error)
    return receipt.result
  }
  async createSession(
    title: string,
    workspace_id?: string,
    provider: 'fake' | 'claude' | 'pi' = 'fake',
    settings?: SessionSettings
  ) {
    return SessionSchema.parse(
      await this.mutation('session.create', {
        title,
        provider,
        ...(workspace_id ? { workspace_id } : {}),
        ...(settings ? { settings } : {}),
      })
    )
  }
  /** Model and permission mode switch the running process; effort and account restart it when idle. */
  async configureSession(session_id: string, settings: SessionSettings, operation?: string) {
    return SessionSchema.parse(
      await this.mutation(
        'session.configure',
        MethodSchemas['session.configure'].parse({ session_id, settings }),
        operation
      )
    )
  }
  /** Queued like a message; the session continues afterwards unless continue is false. */
  async compactSession(
    session_id: string,
    options: { focus?: string; continue?: boolean } = {},
    operation?: string
  ) {
    return TurnAcceptedSchema.parse(
      await this.mutation(
        'session.compact',
        MethodSchemas['session.compact'].parse({ session_id, ...options }),
        operation
      )
    )
  }
  /** Ends the session's process and everything it started; queued messages are cancelled. */
  stopSession(session_id: string, operation?: string) {
    return this.mutation('session.stop', { session_id }, operation)
  }
  async sessionState(session_id: string) {
    return LiveSessionStateSchema.parse(await this.request('session.state', { session_id }))
  }
  /** Rename a chat's display title without altering provider-native identity. */
  async renameSession(session_id: string, title: string, operation?: string) {
    return SessionSchema.parse(
      await this.mutation(
        'session.rename',
        MethodSchemas['session.rename'].parse({ session_id, title }),
        operation
      )
    )
  }
  /** Delete only an idle chat. The node retains its audit journal and receipt. */
  async deleteSession(session_id: string, operation?: string) {
    return SessionDeletedSchema.parse(
      await this.mutation(
        'session.delete',
        MethodSchemas['session.delete'].parse({ session_id }),
        operation
      )
    )
  }
  describe() {
    return this.request('node.describe', {})
  }
  /** Human/owner approval surface only. Never register this method as a model tool. */
  async approveDelegationGrant(params: DelegationGrantRequest): Promise<DelegationGrant> {
    return DelegationGrantSchema.parse(
      await this.mutation('delegation.grant.create', DelegationGrantRequestSchema.parse(params))
    )
  }
  async revokeDelegationGrant(grant_id: string): Promise<DelegationGrant> {
    return DelegationGrantSchema.parse(await this.mutation('delegation.grant.revoke', { grant_id }))
  }
  /** A stable delegation_key survives even retries using a fresh operation ID. */
  async createDelegation(params: DelegationCreateRequest): Promise<Delegation> {
    return DelegationSchema.parse(await this.mutation('delegation.create', params))
  }
  async delegationStatus(delegation_id: string): Promise<DelegationStatus> {
    return DelegationStatusSchema.parse(await this.request('delegation.status', { delegation_id }))
  }
  async sendDelegation(
    delegation_id: string,
    text: string,
    observed_seq: number,
    expected_target?: ExpectedExecutionTarget,
    retainedOperationId?: string
  ): Promise<DelegationSendResult> {
    return DelegationSendResultSchema.parse(
      await this.mutation(
        'delegation.send',
        { delegation_id, text, observed_seq, ...(expected_target ? { expected_target } : {}) },
        retainedOperationId
      )
    )
  }
  async cancelDelegation(delegation_id: string): Promise<Delegation> {
    return DelegationSchema.parse(await this.mutation('delegation.cancel', { delegation_id }))
  }
  /** Uses the existing atomic event/cursor storage and reconnect replay, independent of child history. */
  subscribeDelegation(delegation: Pick<Delegation, 'mailbox_stream_id'>) {
    return this.subscribe(delegation.mailbox_stream_id)
  }
  async getSession(session_id: string) {
    return SessionSchema.parse(await this.request('session.get', { session_id }))
  }
  interrupt(session_id: string, run_id: string) {
    return this.mutation('session.interrupt', { session_id, run_id })
  }
  cancelInput(session_id: string, input_id: string) {
    return this.mutation('input.cancel', { session_id, input_id })
  }
  async detachSession(session_id: string) {
    return SessionSchema.parse(await this.mutation('session.detach', { session_id }))
  }
  async registerProject(path: string, trust: 'untrusted' | 'trusted', exact_root?: boolean) {
    return ProjectSchema.parse(
      await this.mutation('project.register', {
        path,
        trust,
        ...(exact_root === undefined ? {} : { exact_root }),
      })
    )
  }
  async setProjectClaudePermissions(project_id: string, use_repository_permissions: boolean) {
    return ProjectSchema.parse(
      await this.mutation('project.claude_permissions', { project_id, use_repository_permissions })
    )
  }
  async listProjects(after_id?: string) {
    const result = await this.request('project.list', { ...(after_id ? { after_id } : {}) })
    if (!Array.isArray(result)) throw new ChannelError('invalid_result')
    return result.map((r) => ProjectSchema.parse(r))
  }
  async listFiles(workspace_id: string, path = '', after?: string, limit = 256) {
    return FilePageSchema.parse(
      await this.request('workspace.files', {
        workspace_id,
        path,
        limit,
        ...(after !== undefined ? { after } : {}),
      })
    )
  }
  async statFile(workspace_id: string, path: string) {
    return FileEntrySchema.parse(await this.request('workspace.stat', { workspace_id, path }))
  }
  /** Persist the exact version/body/operation before sending, even offline. Never allocate a second save on timeout. */
  async writeFile(params: FileWrite, retainedOperationId?: string) {
    const operation_id = await this.enqueue('workspace.write', params, retainedOperationId)
    if (this.connected) await this.flush().catch(() => {})
    return { operation_id }
  }
  async restoreFile(params: FileRestore, retainedOperationId?: string) {
    const operation_id = await this.enqueue('workspace.restore', params, retainedOperationId)
    if (this.connected) await this.flush().catch(() => {})
    return { operation_id }
  }
  async readRecovery(workspace_id: string, recovery_path: string, offset = 0, length = 131072) {
    return ContentChunkSchema.parse(
      await this.request('workspace.recovery.read', { workspace_id, recovery_path, offset, length })
    )
  }
  async fileMutationResult(operation_id: string) {
    const receipt = await this.operationResult(operation_id)
    if (receipt?.error) throw new ChannelError(receipt.error)
    return receipt ? FileMutationResultSchema.parse(receipt.result) : undefined
  }
  async readFile(workspace_id: string, path: string) {
    return FileContentSchema.parse(await this.request('workspace.read', { workspace_id, path }))
  }
  async readContent(workspace_id: string, content_id: string, offset = 0, length = 131072) {
    return ContentChunkSchema.parse(
      await this.request('workspace.content', { workspace_id, content_id, offset, length })
    )
  }
  async captureDiff(workspace_id: string, mode: DiffMode = 'head', commit?: string) {
    return DiffSnapshotSchema.parse(
      await this.request('workspace.diff.capture', {
        workspace_id,
        mode,
        ...(commit ? { commit } : {}),
      })
    )
  }
  async getDiff(workspace_id: string, diff_id: string) {
    return DiffSnapshotSchema.parse(
      await this.request('workspace.diff.get', { workspace_id, diff_id })
    )
  }
  async readDiff(workspace_id: string, diff_id: string, offset = 0, length = 131072) {
    return ContentChunkSchema.parse(
      await this.request('workspace.diff.read', { workspace_id, diff_id, offset, length })
    )
  }
  async showFile(workspace_id: string, commit: string, path: string) {
    return FileContentSchema.parse(
      await this.request('workspace.show', { workspace_id, commit, path })
    )
  }
  async gitLog(
    workspace_id: string,
    offset = 0,
    limit = 50
  ): Promise<{ commit: string; subject: string }[]> {
    const rows = await this.request('workspace.log', { workspace_id, offset, limit })
    if (
      !Array.isArray(rows) ||
      rows.some(
        (r) =>
          !r ||
          typeof r.subject !== 'string' ||
          typeof r.commit !== 'string' ||
          !/^[a-f0-9]{40,64}$/.test(r.commit)
      )
    )
      throw new ChannelError('invalid_result')
    return rows as { commit: string; subject: string }[]
  }
  /** Offline review uses the same durable outbox as ordinary inputs. */
  async submitReview(batch: ReviewBatch) {
    const operation_id = await this.enqueue('review.submit', batch)
    // Admission already committed. Never hide its identity on response/store/transport loss;
    // callers inspect reviewResult or reconnect the same outbox entry, not submit a new batch.
    if (this.connected) await this.flush().catch(() => {})
    return { operation_id }
  }
  async reviewResult(operation_id: string) {
    const receipt = await this.operationResult(operation_id)
    if (receipt?.error) throw new ChannelError(receipt.error)
    return receipt ? ReviewResultSchema.parse(receipt.result) : undefined
  }
  /** Owner-only project browsing opt-in; never expose this mutation as a model tool. */
  async setRepositorySettings(
    params: import('@abele/node-protocol').RepositoryParams<'project.repository_settings'>
  ) {
    return RepositorySettingsSchema.parse(
      await this.mutation('project.repository_settings', params)
    )
  }
  /** The project's browsing opt-in as it stands; a node older than this answers unsupported_method. */
  async getRepositorySettings(project_id: string) {
    return RepositorySettingsSchema.parse(
      await this.request('project.repository_settings.get', { project_id })
    )
  }
  async getProject(project_id: string) {
    return ProjectSchema.parse(await this.request('project.get', { project_id }))
  }
  async removeProject(project_id: string) {
    const result = await this.mutation('project.remove', { project_id })
    if (
      !result ||
      typeof result !== 'object' ||
      !('removed' in result) ||
      result.removed !== true ||
      !('project_id' in result) ||
      result.project_id !== project_id
    )
      throw new ChannelError('invalid_result')
    return { project_id, removed: true as const }
  }
  async createWorkspace(project_id: string, base_ref = 'HEAD', branch?: string) {
    return WorkspaceJobResultSchema.parse(
      await this.mutation('workspace.create', {
        project_id,
        base_ref,
        ...(branch === undefined ? {} : { branch }),
      })
    )
  }
  async listWorkspaces(project_id: string, after_id?: string) {
    const result = await this.request('workspace.list', {
      project_id,
      ...(after_id ? { after_id } : {}),
    })
    if (!Array.isArray(result)) throw new ChannelError('invalid_result')
    return result.map((r) => WorkspaceSchema.parse(r))
  }
  async getWorkspace(workspace_id: string) {
    return WorkspaceSchema.parse(await this.request('workspace.get', { workspace_id }))
  }
  async removeWorkspace(workspace_id: string) {
    return WorkspaceJobResultSchema.parse(await this.mutation('workspace.remove', { workspace_id }))
  }
  async workspaceStatus(workspace_id: string, offset = 0, limit = 256) {
    return WorkspaceStatusSchema.parse(
      await this.request('workspace.status', { workspace_id, offset, limit })
    )
  }
  async workspaceDiff(workspace_id: string) {
    return WorkspaceDiffSchema.parse(await this.request('workspace.diff', { workspace_id }))
  }
  async getJob(job_id: string) {
    return JobSchema.parse(await this.request('job.get', { job_id }))
  }
  async listJobs(project_id?: string, after_id?: string) {
    const result = await this.request('job.list', {
      ...(project_id ? { project_id } : {}),
      ...(after_id ? { after_id } : {}),
    })
    if (!Array.isArray(result)) throw new ChannelError('invalid_result')
    return result.map((r) => JobSchema.parse(r))
  }
  async send(
    session_id: string,
    text: string,
    observed_seq: number,
    script?: FakeStep[],
    expected_target?: ExpectedExecutionTarget,
    retainedOperationId?: string
  ) {
    const operation_id = await this.enqueue(
      'session.send',
      {
        session_id,
        text,
        observed_seq,
        ...(script ? { script } : {}),
        ...(expected_target ? { expected_target } : {}),
      },
      retainedOperationId
    )
    if (this.connected) await this.flush()
    return { operation_id }
  }
  /** Refusals are durable receipts too; reconnect/retry never substitutes a new target. */
  async sendResult(operation_id: string): Promise<TurnAdmissionResult | undefined> {
    const receipt = await this.operationResult(operation_id)
    if (receipt?.error) throw new ChannelError(receipt.error)
    return receipt ? TurnAdmissionResultSchema.parse(receipt.result) : undefined
  }
  async prompts(session_id: string, after_id?: string, state?: Prompt['state']) {
    const result = await this.request('prompt.list', {
      session_id,
      ...(after_id ? { after_id } : {}),
      ...(state ? { state } : {}),
    })
    if (!Array.isArray(result)) throw new ChannelError('invalid_result')
    return result.map((r) => PromptSchema.parse(r))
  }
  async answerPrompt(prompt: Prompt, choice: 'allow' | 'deny', value?: string) {
    if (!this.connected) throw new ChannelError('disconnected')
    const { session_id, prompt_id, run_id, revision, action_digest } = prompt
    const id = await this.enqueue('prompt.answer', {
      session_id,
      prompt_id,
      run_id,
      revision,
      action_digest,
      choice,
      ...(value !== undefined ? { value } : {}),
    })
    await this.flush()
    const receipt = await this.operationResult(id)
    if (!receipt) throw new ChannelError('outcome_unknown')
    if (receipt.error) throw new ChannelError(receipt.error)
    return PromptSchema.parse(receipt.result)
  }
  private async enqueue(method: string, params: unknown, retainedOperationId?: string) {
    if (method.startsWith('debugger.v1.')) throw new ChannelError('debugger_online_only')
    params = validateParams(method, params)
    const operation_id = retainedOperationId ?? crypto.randomUUID()
    if (!operation_id || operation_id.length > 128) throw new ChannelError('invalid_params')
    // Enforce byte limits before durable admission, including UTF-8 expansion.
    FrameCodec.encode({ kind: 'request', request_id: 'validation', operation_id, method, params })
    await this.store.transaction((s) => {
      if (!s.node_id) throw new ChannelError('connect_before_queueing')
      const previous =
        s.operationRequests?.[operation_id] ??
        s.outbox.find((e) => e.operation_id === operation_id) ??
        s.results[operation_id]?.request
      if (
        (!previous && s.results[operation_id]) ||
        (previous &&
          (previous.method !== method ||
            normalizedRequest(previous.method, previous.params) !==
              normalizedRequest(method, params)))
      )
        throw new ChannelError('idempotency_mismatch')
      s.operationRequests ??= {}
      s.operationRequests[operation_id] = { method, params }
      if (!s.results[operation_id] && !s.outbox.some((e) => e.operation_id === operation_id))
        s.outbox.push({ operation_id, method, params })
    })
    return operation_id
  }
  async flush(): Promise<void> {
    if (this.flushing) return this.flushing
    this.flushing = (async () => {
      while (this.channel) {
        const entry = await this.store.transaction((s) => s.outbox[0])
        if (!entry) return
        let result: unknown,
          error: string | undefined,
          params = entry.params
        try {
          // Debugger intent cannot be blindly replayed, even if an old/custom
          // client store contains an unsent entry. Reconcile receipts online.
          if (entry.method.startsWith('debugger.v1.'))
            throw new ChannelError('debugger_online_only')
          params = validateParams(entry.method, entry.params)
          result = await this.channel.request(entry.method, params, entry.operation_id)
        } catch (e) {
          if (
            !(e instanceof ChannelError) ||
            ['disconnected', 'outcome_unknown', 'storage_unavailable'].includes(e.code)
          )
            throw e
          error = e.code
        }
        // Failure here intentionally retains the same operation ID for reconnect/retry.
        await this.store.transaction((s) => {
          if (entry.method.startsWith('debugger.v1.')) {
            // Rejected legacy entries never enter the mutation namespace or reach the wire.
            s.results[entry.operation_id] = { error: 'debugger_online_only' }
          } else {
            const request = { method: entry.method, params }
            s.operationRequests ??= {}
            s.operationRequests[entry.operation_id] = request
            s.results[entry.operation_id] = { ...(error ? { error } : { result }), request }
          }
          s.outbox = s.outbox.filter((e) => e.operation_id !== entry.operation_id)
        })
      }
    })()
    try {
      await this.flushing
    } finally {
      this.flushing = undefined
    }
  }
}
