import { randomUUID } from 'node:crypto'
import { ActiveDeadline } from '@abele/provider-contract'
import type {
  ProviderRun,
  ProviderEventSink,
  TurnContext,
  ProcessProbe,
} from '@abele/provider-contract'
import { RpcPeer, ServerRequestRejected } from './rpc.js'
import { CodexTools } from './tools.js'
import { CodexEventMapper, opaqueId } from './mapper.js'
import { CodexApprovalBridge } from './approval.js'
import { launchOverrides, policyFingerprint, type PolicyPaths } from './policy.js'
import { checkNativeBinding, openCodexThread } from './thread.js'
import type { CodexExecutable } from './discovery.js'
import { createProcessScope } from './scope.js'
import { systemDeadlineTimers, type DeadlineTimers } from './timers.js'
export interface WorkerOptions {
  /** Node-local process supervision seam, never a protocol field. */
  probe?: ProcessProbe
  /** Node-local logical deadline seam, never a protocol field. */
  timers?: DeadlineTimers
  executable: CodexExecutable
  paths: PolicyPaths
  model?: string
  deadlineMs: number
  turn: TurnContext
}
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
export async function startCodexTurn(
  options: WorkerOptions,
  sink: ProviderEventSink
): Promise<ProviderRun> {
  const { paths, turn } = options
  const model = options.model || undefined
  const timers = options.timers ?? systemDeadlineTimers
  const fingerprint = policyFingerprint(paths)
  if (turn.cwd !== paths.workspace || !opaqueId(turn.run_id) || !opaqueId(turn.session_id))
    throw new Error('codex_invalid_turn')
  checkNativeBinding(paths, model, turn.native_session_id, turn.native_binding)
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
  const tools = new CodexTools(sink.debugger, () => ({
    thread: mapper.threadId,
    turn: mapper.turnId,
  }))
  const scope = createProcessScope(paths.state, turn.run_id)
  sink.ipc?.(scope.directory)
  peer = await RpcPeer.start({
    marker: scope.marker,
    executable: options.executable,
    cwd: paths.workspace,
    home: paths.home,
    isolated: paths.isolated,
    configArgs: launchOverrides(paths),
    processes: (p) => sink.processes(p),
    probe: options.probe,
    notification: (msg) => {
      mapper.notification(msg)
      if (mapper.result) resolveTerminal()
    },
    serverRequest: async (msg, signal) => {
      const combined = AbortSignal.any([signal, localAbort.signal])
      if (msg.method !== 'item/tool/call') return bridge.handle(msg, combined)
      const resume = msg.params?.tool?.startsWith('obsidian_') ? timer.pause() : () => {}
      try {
        return await tools.handle(msg.params, combined)
      } catch {
        throw new ServerRequestRejected(-32602, 'invalid_tool_call')
      } finally {
        resume()
      }
    },
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
      timers.clearTimeout(retryTimer)
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
      timer.close()
      finish({
        ...(mapper.result ? { result: mapper.result } : {}),
        ...(reason ? { reason } : !mapper.result ? { reason: 'codex_no_terminal_result' } : {}),
      })
      return true
    })().catch(() => {
      cleanup = undefined
      const retryDelay = cleanupRetryDelays[cleanupAttempts - 1]
      if (retryDelay !== undefined)
        retryTimer = timers.setTimeout(() => {
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
    ask: async (action, signal) => {
      const resume = timer.pause()
      try {
        return await (action.kind === 'permission'
          ? sink.permission(action, signal)
          : (sink.question?.(action, signal) ??
            Promise.resolve({ choice: 'deny' as const, delivered: () => false })))
      } finally {
        resume()
      }
    },
    cancel: interrupt,
  })
  const timer = new ActiveDeadline(
    options.deadlineMs,
    () => {
      reason = 'deadline'
      void interrupt().catch(() => {})
    },
    timers
  )
  const request = (method: string, params?: unknown) =>
    localAbort.signal.aborted
      ? Promise.reject(new Error('interrupted'))
      : peer.request(method, params)
  void (async () => {
    try {
      const native = await openCodexThread(request, () => peer.initialized(), {
        paths,
        model,
        native_session_id: turn.native_session_id,
        binding: turn.native_binding,
        tools: sink.debugger?.tools,
      })
      const { params, inspect } = native
      mapper.bind(native.thread_id)
      await inspect()
      if (localAbort.signal.aborted) throw new Error('interrupted')
      // The sink commits the exact binding synchronously before any user text is sent.
      sink.event({
        type: 'codex.session.bound',
        data: {
          run_id: turn.run_id,
          generation,
          native_session_id: native.thread_id,
          workspace_path: paths.workspace,
          policy_fingerprint: fingerprint,
          model: native.model,
        },
      })
      const accepted = await request('turn/start', {
        ...params,
        threadId: native.thread_id,
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
