import { randomUUID } from 'node:crypto'
import type {
  ProviderRun,
  ProviderEventSink,
  TurnContext,
  ProcessProbe,
} from '@abele/provider-contract'
import { RpcPeer } from './rpc.js'
import { CodexEventMapper, opaqueId } from './mapper.js'
import { CodexApprovalBridge } from './approval.js'
import { checkEffective, launchOverrides, policyFingerprint, type PolicyPaths } from './policy.js'
import type { CodexExecutable } from './discovery.js'
import { createProcessScope } from './scope.js'
export interface WorkerOptions {
  /** Node-local process supervision seam, never a protocol field. */
  probe?: ProcessProbe
  executable: CodexExecutable
  paths: PolicyPaths
  model: string
  deadlineMs: number
  turn: TurnContext
}
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
export async function startCodexTurn(
  options: WorkerOptions,
  sink: ProviderEventSink
): Promise<ProviderRun> {
  const { paths, turn, model } = options
  const fingerprint = policyFingerprint(paths)
  if (turn.cwd !== paths.workspace || !opaqueId(turn.run_id) || !opaqueId(turn.session_id))
    throw new Error('codex_invalid_turn')
  if (
    turn.native_session_id &&
    (!opaqueId(turn.native_session_id) ||
      turn.native_binding?.workspace_path !== paths.workspace ||
      turn.native_binding?.policy_fingerprint !== fingerprint ||
      turn.native_binding?.model !== model)
  )
    throw new Error('codex_native_binding_mismatch')
  const localAbort = new AbortController(),
    generation = randomUUID()
  const mapper = new CodexEventMapper(turn.run_id, (e) =>
    sink.event({ ...e, data: { ...e.data, generation } })
  )
  // Resume can announce the recorded thread before its RPC response arrives.
  if (turn.native_session_id) mapper.bind(turn.native_session_id)
  let resolveTerminal!: () => void
  const terminal = new Promise<void>((r) => {
    resolveTerminal = r
  })
  let peer!: RpcPeer, bridge!: CodexApprovalBridge
  const scope = createProcessScope(paths.state, turn.run_id)
  sink.ipc?.(scope.directory)
  peer = await RpcPeer.start({
    marker: scope.marker,
    executable: options.executable,
    cwd: paths.workspace,
    home: paths.home,
    configArgs: launchOverrides(paths),
    processes: (p) => sink.processes(p),
    probe: options.probe,
    notification: (msg) => {
      mapper.notification(msg)
      if (mapper.result) resolveTerminal()
    },
    serverRequest: (msg, signal) =>
      bridge.handle(msg, AbortSignal.any([signal, localAbort.signal])),
  })
  let reason: string | undefined,
    settled = false,
    cleanup: Promise<boolean> | undefined,
    cleanupAttempts = 0,
    retryTimer: ReturnType<typeof setTimeout> | undefined
  const cleanupRetryDelays = [100, 250, 500]
  let finish!: (result: { result?: Record<string, any>; reason?: string }) => void
  const done = new Promise<{ result?: Record<string, any>; reason?: string }>((r) => {
    finish = r
  })
  const finalize = () => {
    if (cleanup) return cleanup
    if (retryTimer) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
    cleanupAttempts++
    cleanup = (async () => {
      localAbort.abort()
      await peer.close()
      if (settled) return true
      sink.event({
        type: 'codex.worker.exit',
        data: { run_id: turn.run_id, generation, cleanup_confirmed: true },
      })
      settled = true
      clearTimeout(timer)
      finish({
        ...(mapper.result ? { result: mapper.result } : {}),
        ...(reason ? { reason } : !mapper.result ? { reason: 'codex_no_terminal_result' } : {}),
      })
      return true
    })().catch(() => {
      cleanup = undefined
      const retryDelay = cleanupRetryDelays[cleanupAttempts - 1]
      if (retryDelay !== undefined)
        retryTimer = setTimeout(() => {
          retryTimer = undefined
          void finalize()
        }, retryDelay)
      // Report dispatch/cleanup failure without journaling unrestricted diagnostics.
      // Ownership and done remain unsettled until a later attempt confirms reaping.
      try {
        sink.event({
          type: 'codex.cleanup.failed',
          data: {
            run_id: turn.run_id,
            generation,
            code: 'process_cleanup_unconfirmed',
            attempt: cleanupAttempts,
            retrying: retryDelay !== undefined,
            ...(retryDelay !== undefined ? { retry_in_ms: retryDelay } : {}),
          },
        })
      } catch {
        reason ??= 'codex_journal_failed'
      }
      return false
    })
    return cleanup
  }
  const interrupt = async () => {
    if (settled) return
    reason ??= 'interrupted'
    localAbort.abort()
    if (mapper.threadId && mapper.turnId && !peer.signal.aborted)
      await Promise.race([
        peer.request('turn/interrupt', { threadId: mapper.threadId, turnId: mapper.turnId }).then(
          () => {},
          () => {}
        ),
        delay(200),
      ])
    if ((await finalize()) !== true) throw new Error('process_cleanup_unconfirmed')
  }
  bridge = new CodexApprovalBridge({
    generation,
    workspace: paths.workspace,
    mapper,
    ask: (action, signal) =>
      action.kind === 'permission'
        ? sink.permission(action, signal)
        : (sink.question?.(action, signal) ??
          Promise.resolve({ choice: 'deny', delivered: () => false })),
    cancel: interrupt,
  })
  const timer = setTimeout(() => {
    reason = 'deadline'
    void interrupt().catch(() => {})
  }, options.deadlineMs)
  const request = (method: string, params?: unknown) =>
    localAbort.signal.aborted
      ? Promise.reject(new Error('interrupted'))
      : peer.request(method, params)
  void (async () => {
    try {
      const init = await request('initialize', {
        clientInfo: { name: 'abele-node', version: '0.3.7' },
        capabilities: { experimentalApi: true },
      })
      if (init.codexHome !== paths.home) throw new Error('codex_home_mismatch')
      await peer.initialized()
      const inspect = async () => {
        const requirements = await request('configRequirements/read')
        const effective = await request('config/read', {
          cwd: paths.workspace,
          includeLayers: true,
        })
        checkEffective(effective.config, requirements, paths)
      }
      await inspect()
      const account = await request('account/read', { refreshToken: false })
      if (account?.account?.type !== 'chatgpt')
        throw new Error('codex_chatgpt_authentication_required')
      const models = await request('model/list', { includeHidden: false, limit: 100 })
      if (
        !Array.isArray(models?.data) ||
        models.data.length > 100 ||
        !models.data.some(
          (m: any) =>
            m.model === model &&
            m.hidden !== true &&
            m.supportedReasoningEfforts?.some((e: any) => e.reasoningEffort === 'low')
        )
      )
        throw new Error('codex_selected_model_unavailable')
      const params = {
        model,
        cwd: paths.workspace,
        runtimeWorkspaceRoots: [paths.workspace],
        approvalPolicy: 'on-request',
        approvalsReviewer: 'user',
        permissions: 'abele',
      }
      const native = await request(
        turn.native_session_id ? 'thread/resume' : 'thread/start',
        turn.native_session_id
          ? {
              ...params,
              modelProvider: 'openai',
              threadId: turn.native_session_id,
              excludeTurns: true,
            }
          : { ...params, modelProvider: 'openai', ephemeral: false }
      ).catch((error) => {
        if (
          turn.native_session_id &&
          error instanceof Error &&
          error.message.startsWith('codex_rpc_error:')
        )
          throw new Error('codex_native_context_unavailable')
        throw error
      })
      if (
        !opaqueId(native?.thread?.id) ||
        (turn.native_session_id && native.thread.id !== turn.native_session_id) ||
        native.model !== model ||
        native.modelProvider !== 'openai' ||
        native.cwd !== paths.workspace ||
        native.approvalPolicy !== 'on-request' ||
        native.approvalsReviewer !== 'user' ||
        native.activePermissionProfile?.id !== 'abele' ||
        native.activePermissionProfile.extends !== null ||
        JSON.stringify(native.runtimeWorkspaceRoots) !== JSON.stringify([paths.workspace])
      )
        throw new Error('codex_thread_policy_mismatch')
      mapper.bind(native.thread.id)
      await inspect()
      if (localAbort.signal.aborted) throw new Error('interrupted')
      // The sink commits the exact binding synchronously before any user text is sent.
      sink.event({
        type: 'codex.session.bound',
        data: {
          run_id: turn.run_id,
          generation,
          native_session_id: native.thread.id,
          workspace_path: paths.workspace,
          policy_fingerprint: fingerprint,
          model,
        },
      })
      const accepted = await request('turn/start', {
        ...params,
        threadId: native.thread.id,
        input: [{ type: 'text', text: turn.text, text_elements: [] }],
        effort: 'low',
      })
      mapper.accepted(accepted?.turn?.id)
      await Promise.race([
        terminal,
        peer.lost.then((r) => {
          throw new Error(r)
        }),
      ])
    } catch (error) {
      reason ??= localAbort.signal.aborted
        ? 'interrupted'
        : error instanceof Error && /^(codex_|interrupted)/.test(error.message)
          ? error.message
          : 'codex_worker_failed'
    }
    await finalize()
  })().catch(() => {
    reason ??= 'codex_worker_failed'
    void finalize()
  })
  return { done, interrupt }
}
