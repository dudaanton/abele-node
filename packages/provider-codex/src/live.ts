import { randomUUID } from 'node:crypto'
import type {
  LiveInput,
  LiveSession,
  LiveSessionContext,
  LiveSessionSink,
  ProcessProbe,
} from '@abele/provider-contract'
import { RpcPeer, ServerRequestRejected, type RpcMessage } from './rpc.js'
import { CodexTools } from './tools.js'
import { CodexEventMapper, opaqueId } from './mapper.js'
import { CodexApprovalBridge } from './approval.js'
import { launchOverrides, policyFingerprint, type PolicyPaths } from './policy.js'
import type { CodexExecutable } from './discovery.js'
import { createProcessScope } from './scope.js'
import { checkNativeBinding, openCodexThread, type NativeBinding } from './thread.js'
import { LIVE, commandList, contextUsage, skillInput, type Skill } from './live-events.js'

export interface CodexLiveOptions {
  executable: CodexExecutable
  paths: PolicyPaths
  /** The node's model override; absent means Codex's own selection. */
  model?: string
  context: LiveSessionContext & { native_binding?: NativeBinding }
  probe?: ProcessProbe
}
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh'])
const COMPACT = /^\/compact(\s|$)/
interface Turn {
  id?: string
  trigger: 'input' | 'compact'
  inputs: string[]
  mapper: CodexEventMapper
  abort: AbortController
  announced: boolean
  compacted: boolean
  interrupt: boolean
}
const plain = (content: LiveInput['content']) =>
  typeof content === 'string'
    ? content
    : content
        .map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
        .join('\n')

/** One Codex app-server and its thread for one owner session. Inputs that arrive while a turn
 * runs are steered into it; between turns they start the next one. Nothing bounds a turn's
 * length: the owner stops it. */
export async function startCodexLiveSession(
  options: CodexLiveOptions,
  sink: LiveSessionSink
): Promise<LiveSession> {
  const { paths, context } = options
  const model = options.model || undefined
  if (
    context.cwd !== paths.workspace ||
    !opaqueId(context.run_id) ||
    !opaqueId(context.session_id) ||
    !EFFORTS.has(context.settings.effort)
  )
    throw new Error('codex_invalid_turn')
  checkNativeBinding(paths, model, context.native_session_id, context.native_binding)
  const generation = randomUUID()
  // Lifecycle records carry exactly what the node's own session records hold.
  const emit = (type: string, data: Record<string, unknown>) =>
    sink.event({ type, data: { run_id: context.run_id, ...data } })
  let thread: string | undefined
  let threadModel: string | null = context.native_binding?.model ?? null
  let turnParams: Record<string, unknown> = {}
  let turn: Turn | undefined
  let skills: Skill[] = []
  let stopReason: string | undefined
  const queue: LiveInput[] = []
  const scope = createProcessScope(paths.state, context.run_id)
  sink.ipc?.(scope.directory)
  // The current turn's evidence, for answering its approval requests.
  const current = {
    get threadId() {
      return thread
    },
    get turnId() {
      return turn?.id
    },
    item: (id: string) => turn?.mapper.item(id),
  }
  let bridge!: CodexApprovalBridge
  const tools = new CodexTools(sink.debugger, () => ({ thread, turn: turn?.id }))
  const peer = await RpcPeer.start({
    marker: scope.marker,
    executable: options.executable,
    cwd: paths.workspace,
    home: paths.home,
    isolated: paths.isolated,
    configArgs: launchOverrides(paths),
    streamLimit: Number.POSITIVE_INFINITY,
    processes: (p) => sink.processes(p),
    probe: options.probe,
    notification: (msg) => notification(msg),
    serverRequest: (msg, signal) => {
      const activeSignal = turn ? AbortSignal.any([signal, turn.abort.signal]) : AbortSignal.abort()
      return msg.method === 'item/tool/call'
        ? tools.handle(msg.params, activeSignal).catch(() => {
            throw new ServerRequestRejected(-32602, 'invalid_tool_call')
          })
        : bridge.handle(msg, activeSignal)
    },
  })
  const request = (method: string, params?: unknown) => peer.request(method, params)
  bridge = new CodexApprovalBridge({
    generation,
    workspace: paths.workspace,
    mapper: current,
    ask: (action, signal) =>
      sink.permission({ ...action, ttl_ms: action.ttl_ms ?? context.permission_ttl_ms }, signal),
    cancel: () => interrupt(),
  })
  const done = peer.lost.then(async (reason) => {
    try {
      await peer.close()
    } catch {
      return { reason: 'process_cleanup_unconfirmed' }
    }
    return {
      reason: stopReason ?? reason,
      exit_code: peer.child.exitCode,
      signal: peer.child.signalCode,
    }
  })
  const settle = (status: string, duration_ms: number | null) => {
    const ended = turn!
    turn = undefined
    ended.abort.abort()
    if (ended.trigger === 'compact') {
      if (status === 'completed' && !ended.compacted)
        emit(LIVE.compacted, { trigger: 'manual', pre_tokens: null, post_tokens: null })
      else if (status !== 'completed')
        emit(LIVE.status, { status: null, compact_result: 'failed', compact_error: status })
    }
    emit(LIVE.turnCompleted, {
      outcome:
        status === 'completed' ? 'success' : status === 'interrupted' ? 'interrupted' : 'failed',
      input_ids: ended.inputs,
      subtype: status === 'completed' ? 'success' : status,
      num_turns: null,
      duration_ms,
      total_cost_usd: null,
      terminal_reason: status === 'interrupted' ? 'interrupted' : null,
    })
    pump()
  }
  const announce = (id: string) => {
    if (!turn) return
    if (turn.id && turn.id !== id) throw new Error('codex_turn_mismatch')
    turn.id = id
    turn.mapper.accepted(id)
    if (!turn.announced) {
      turn.announced = true
      emit(LIVE.turnStarted, { trigger: turn.trigger })
      for (const input_id of turn.inputs) emit(LIVE.delivered, { input_id })
    }
    if (turn.interrupt) void interrupt()
    // Inputs that arrived before the turn had an id are steered into it now.
    else if (queue.length) pump()
  }
  function notification(msg: RpcMessage) {
    const method = msg.method!,
      p = msg.params
    if (thread && p?.threadId !== undefined && p.threadId !== thread)
      throw new Error('codex_thread_mismatch')
    if (method === 'thread/tokenUsage/updated') {
      const usage = contextUsage(p?.tokenUsage, threadModel)
      if (usage) emit(LIVE.context, usage)
      return
    }
    if (method === 'skills/changed') {
      void loadCommands()
      return
    }
    if (method === 'thread/status/changed' || method === 'thread/started') return
    if (!turn) return
    if (method === 'turn/started') return announce(p?.turn?.id)
    const item = p?.item
    if (item?.type === 'contextCompaction') {
      if (method === 'item/started') emit(LIVE.status, { status: 'compacting' })
      if (method === 'item/completed') {
        turn.compacted = true
        emit(LIVE.compacted, {
          trigger: turn.trigger === 'compact' ? 'manual' : 'auto',
          pre_tokens: null,
          post_tokens: null,
        })
      }
      return
    }
    turn.mapper.notification(msg)
    if (method === 'turn/completed') settle(p.turn.status, p.turn.durationMs ?? null)
  }
  const input = (content: LiveInput['content']) => {
    const text = plain(content)
    const skill = skillInput(text, skills)
    return skill ?? [{ type: 'text', text, text_elements: [] }]
  }
  const begin = (trigger: Turn['trigger'], inputs: string[]): Turn => {
    const mapper = new CodexEventMapper(context.run_id, (e) =>
      sink.event({ ...e, data: { ...e.data, generation } })
    )
    mapper.bind(thread!)
    turn = {
      trigger,
      inputs,
      mapper,
      abort: new AbortController(),
      announced: false,
      compacted: false,
      interrupt: false,
    }
    return turn
  }
  const failed = (started: Turn) => {
    if (turn !== started) return
    if (!started.announced) emit(LIVE.turnStarted, { trigger: started.trigger })
    settle('failed', null)
  }
  // Serialized: one decision about the queue at a time.
  let chain = Promise.resolve()
  const pump = () => {
    chain = chain.then(step, step)
  }
  async function step() {
    if (!thread || stopReason || peer.signal.aborted || !queue.length) return
    if (turn) {
      // Steering needs the turn's id; until it is known the input waits.
      if (!turn.id || turn.trigger === 'compact') return
      const next = queue[0]!
      if (COMPACT.test(plain(next.content))) return
      const active = turn
      try {
        await request('turn/steer', {
          threadId: thread,
          expectedTurnId: active.id,
          input: input(next.content),
        })
      } catch {
        // The turn ended first: the input starts the next one.
        return
      }
      queue.shift()
      active.inputs.push(next.input_id)
      emit(LIVE.delivered, { input_id: next.input_id })
      return pump()
    }
    const first = queue[0]!
    if (COMPACT.test(plain(first.content))) {
      queue.shift()
      const started = begin('compact', [first.input_id])
      emit(LIVE.status, { status: 'compacting' })
      try {
        await request('thread/compact/start', { threadId: thread })
      } catch {
        failed(started)
      }
      return
    }
    // Everything waiting up to the next compaction goes into one turn.
    const taken: LiveInput[] = []
    while (queue.length && !COMPACT.test(plain(queue[0]!.content))) taken.push(queue.shift()!)
    const started = begin(
      'input',
      taken.map((i) => i.input_id)
    )
    try {
      const accepted = await request('turn/start', {
        ...turnParams,
        threadId: thread,
        effort: context.settings.effort,
        input: taken.flatMap((i) => input(i.content)),
      })
      if (turn === started) announce(accepted?.turn?.id)
    } catch {
      failed(started)
    }
    if (queue.length) pump()
  }
  async function loadCommands() {
    try {
      const listed = await request('skills/list', { cwds: [paths.workspace] })
      skills = (Array.isArray(listed?.data) ? listed.data : [])
        .flatMap((entry: any) => (Array.isArray(entry?.skills) ? entry.skills : []))
        .filter((s: any) => s?.enabled === true)
    } catch {
      skills = []
    }
    emit(LIVE.commands, { commands: commandList(skills) })
  }
  async function interrupt() {
    if (!turn || peer.signal.aborted) return
    turn.abort.abort()
    if (!turn.id) {
      turn.interrupt = true
      return
    }
    await request('turn/interrupt', { threadId: thread, turnId: turn.id }).catch(() => {})
  }
  const stop = async (reason?: string) => {
    stopReason ??= reason ?? 'stopped'
    turn?.abort.abort()
    await peer.close().catch(() => {})
    await done
  }
  try {
    const opened = await openCodexThread(request, () => peer.initialized(), {
      paths,
      model,
      native_session_id: context.native_session_id,
      binding: context.native_binding,
      tools: sink.debugger?.tools,
    })
    await opened.inspect()
    // The node commits the exact binding before any input is written.
    sink.event({
      type: 'codex.session.bound',
      data: {
        run_id: context.run_id,
        generation,
        native_session_id: opened.thread_id,
        workspace_path: paths.workspace,
        policy_fingerprint: policyFingerprint(paths),
        model: opened.model,
      },
    })
    thread = opened.thread_id
    threadModel = opened.model
    turnParams = opened.params
    await loadCommands()
  } catch (error) {
    await stop('codex_start_failed')
    throw error instanceof Error && /^codex_/.test(error.message)
      ? error
      : new Error('codex_start_failed')
  }
  return {
    done,
    send(next: LiveInput) {
      if (stopReason || peer.signal.aborted) throw new Error('codex_session_closed')
      queue.push(next)
      pump()
    },
    interrupt,
    async control(subtype: string) {
      throw new Error(`codex_control_unsupported:${subtype.slice(0, 64)}`)
    },
    stop,
  }
}
