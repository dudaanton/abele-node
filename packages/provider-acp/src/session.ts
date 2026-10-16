// One long-lived ACP agent process per node session. Inputs that arrive during a turn wait and
// go in together as the next prompt (ACP has no steering). Everything the agent reports, and every
// permission decision, including the ones the session's mode answers by itself, is journaled.
import { spawn } from 'node:child_process'
import { ProcessSupervisor, type ProcessProbe } from '@abele/provider-claude'
import type {
  LiveInput,
  LiveSession,
  LiveSessionContext,
  LiveSessionSink,
  ProcessIdentity,
} from '@abele/provider-contract'
import { AcpConnection, AcpRequestError } from './rpc.js'
import { AcpEventMapper, EVENTS } from './mapper.js'
import type { AcpAgent } from './agents.js'

export const ACP_PROTOCOL_VERSION = 1
/** Lifecycle records the node's session host reads; they are not journaled as they are. */
export const LIFECYCLE = {
  native: 'live.native',
  delivered: 'live.input.delivered',
  started: 'live.turn.started',
  completed: 'live.turn.completed',
  context: 'live.context',
} as const
export interface AcpLaunch {
  agent: AcpAgent & { executable: string }
  probe: ProcessProbe
  /** How long initialize and session setup may take. */
  setupTimeoutMs?: number
  clientVersion?: string
}
type Option = { optionId: string; name?: string; kind?: string }

const withTimeout = <T>(promise: Promise<T>, ms: number, code: string) =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(code)), ms)
    promise.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e))
    )
  })
const failure = (error: unknown, fallback: string) => {
  if (error instanceof AcpRequestError)
    return error.error.code === -32000 ? 'acp_auth_required' : fallback
  return error instanceof Error && /^acp_[a-z_]+$/.test(error.message) ? error.message : fallback
}
const promptBlocks = (content: LiveInput['content']) =>
  typeof content === 'string' ? [{ type: 'text', text: content }] : content

export async function startAcpSession(
  launch: AcpLaunch,
  context: LiveSessionContext,
  sink: LiveSessionSink
): Promise<LiveSession> {
  const { agent, probe } = launch
  const setupMs = launch.setupTimeoutMs ?? 60000
  const child = spawn(agent.executable, agent.args, {
    cwd: context.cwd,
    env: { ...process.env, ...agent.env },
    detached: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stderr.resume()
  let leader: ProcessIdentity | undefined
  let exitInfo: { code: number | null; signal: string | null } | undefined
  const exited = new Promise<void>((resolve) => {
    child.once('exit', (code, signal) => {
      exitInfo = { code, signal }
      resolve()
    })
    child.once('error', () => {
      exitInfo ??= { code: null, signal: null }
      resolve()
    })
  })
  const conn = new AcpConnection(child.stdout, child.stdin)
  void exited.then(() => conn.close(new Error('acp_process_exited')))
  try {
    if (child.pid) leader = probe.identity(child.pid)
  } catch {}
  if (leader) sink.processes([leader])

  let stopReason: string | undefined
  const cleanup = async () => {
    conn.close()
    try {
      child.stdin.end()
    } catch {}
    if (leader) await ProcessSupervisor.cleanup([leader], 300, probe)
    else if (!exitInfo) child.kill('SIGKILL')
    await exited
  }
  const done = (async () => {
    await exited
    try {
      if (leader) await ProcessSupervisor.cleanup([leader], 300, probe)
    } catch {
      return { reason: 'process_cleanup_unconfirmed', exit_code: exitInfo?.code ?? null }
    }
    return {
      reason: stopReason ?? 'process_exited',
      exit_code: exitInfo?.code ?? null,
      signal: exitInfo?.signal ?? null,
    }
  })()

  let nativeId = ''
  let loading = false
  let mode = context.settings.permission_mode
  let model: string | null = null
  let modelOption: string | undefined
  const mapper = new AcpEventMapper((event) => sink.event(event))
  const permissions = new Set<AbortController>()
  conn.on('session/update', (params) => {
    if (loading || !params || params.sessionId !== nativeId || !params.update) return
    mapper.update(params.update)
    const u = params.update
    if (u.sessionUpdate === 'usage_update' && typeof u.used === 'number') {
      const size = typeof u.size === 'number' && u.size > 0 ? u.size : null
      sink.event({
        type: LIFECYCLE.context,
        data: {
          total_tokens: u.used,
          max_tokens: size,
          percentage: size ? Math.round((u.used / size) * 1000) / 10 : null,
          auto_compact_threshold: null,
          auto_compact_enabled: null,
          model,
          categories: [],
        },
      })
    }
  })
  conn.handle('session/request_permission', async (params) => {
    const options: Option[] = Array.isArray(params?.options) ? params.options : []
    const call = params?.toolCall ?? {}
    // Only one-shot answers: an "always" choice would outlive the owner's decision.
    const allow = options.find((o) => o.kind === 'allow_once')
    const reject = options.find((o) => o.kind === 'reject_once')
    const record = (decision: string, by: string) =>
      sink.event({
        type: EVENTS.permission,
        data: {
          tool_call_id: String(call.toolCallId ?? ''),
          title: typeof call.title === 'string' ? call.title : null,
          kind: typeof call.kind === 'string' ? call.kind : null,
          decision,
          by,
        },
      })
    const answer = (option?: Option) =>
      option
        ? { outcome: { outcome: 'selected', optionId: option.optionId } }
        : { outcome: { outcome: 'cancelled' } }
    if (params?.sessionId !== nativeId || stopReason) return answer(undefined)
    if (!allow) {
      record('rejected', 'no_single_use_option')
      return answer(reject)
    }
    if (mode === 'bypassPermissions') {
      record('allowed', 'session_mode')
      return answer(allow)
    }
    const controller = new AbortController()
    permissions.add(controller)
    try {
      const result = await sink.permission(
        {
          tool_use_id: String(call.toolCallId || 'acp-permission').slice(0, 128),
          tool_name: String(call.kind ?? 'other').slice(0, 256) || 'other',
          input:
            call.rawInput && typeof call.rawInput === 'object' && !Array.isArray(call.rawInput)
              ? call.rawInput
              : {},
          kind: 'permission',
          ...(typeof call.title === 'string' ? { title: call.title.slice(0, 4096) } : {}),
          options: [allow, reject]
            .filter((o): o is Option => !!o)
            .map((o) => String(o.name ?? o.optionId).slice(0, 4096)),
          ttl_ms: context.permission_ttl_ms,
        },
        controller.signal
      )
      if (result.choice === 'allow' && !controller.signal.aborted && result.delivered() !== false) {
        record('allowed', 'owner')
        return answer(allow)
      }
      record(controller.signal.aborted ? 'cancelled' : 'rejected', 'owner')
      return answer(controller.signal.aborted ? undefined : reject)
    } catch {
      // A question the node could not put to the owner is never an allow.
      record('cancelled', 'node')
      return answer(undefined)
    } finally {
      permissions.delete(controller)
    }
  })

  // Setup: initialize, then open the agent's session, resuming the earlier one where it can.
  try {
    const init = await withTimeout(
      conn.request('initialize', {
        protocolVersion: ACP_PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'abele-node', version: launch.clientVersion ?? '0' },
      }),
      setupMs,
      'acp_initialize_timeout'
    )
    if (Number(init?.protocolVersion) !== ACP_PROTOCOL_VERSION)
      throw new Error('acp_protocol_version_unsupported')
    const capabilities = init?.agentCapabilities ?? {}
    const base = { cwd: context.cwd, mcpServers: [] }
    let opened: any
    if (context.native_session_id && capabilities.sessionCapabilities?.resume) {
      nativeId = context.native_session_id
      opened = await withTimeout(
        conn.request('session/resume', { ...base, sessionId: nativeId }),
        setupMs,
        'acp_resume_timeout'
      )
    } else if (context.native_session_id && capabilities.loadSession) {
      // The agent replays its whole history; the node's journal already has it.
      nativeId = context.native_session_id
      loading = true
      try {
        opened = await withTimeout(
          conn.request('session/load', { ...base, sessionId: nativeId }),
          setupMs,
          'acp_load_timeout'
        )
      } finally {
        loading = false
      }
    } else {
      opened = await withTimeout(conn.request('session/new', base), setupMs, 'acp_new_timeout')
      if (
        typeof opened?.sessionId !== 'string' ||
        !/^[A-Za-z0-9_:-]{1,256}$/.test(opened.sessionId)
      )
        throw new Error('acp_invalid_session_id')
      nativeId = opened.sessionId
      if (context.native_session_id)
        sink.event({
          type: EVENTS.notice,
          data: {
            level: 'warning',
            code: 'acp_resume_unsupported',
            text: 'The agent could not resume its earlier session; this is a new one.',
          },
        })
    }
    sink.event({ type: LIFECYCLE.native, data: { native_session_id: nativeId } })
    const configOptions: any[] = Array.isArray(opened?.configOptions) ? opened.configOptions : []
    const modelConfig = configOptions.find((o) => o?.category === 'model')
    modelOption = typeof modelConfig?.id === 'string' ? modelConfig.id : undefined
    model = typeof modelConfig?.currentValue === 'string' ? modelConfig.currentValue : null
    // What the session opened with, as the updates the agent sends when they change.
    if (opened?.modes?.currentModeId)
      mapper.update({
        sessionUpdate: 'current_mode_update',
        currentModeId: String(opened.modes.currentModeId),
      })
    if (configOptions.length)
      mapper.update({ sessionUpdate: 'config_option_update', configOptions })
    if (context.settings.model !== 'default' && context.settings.model !== model) {
      if (!modelOption) throw new Error('acp_model_unsupported')
      await withTimeout(
        conn.request('session/set_config_option', {
          sessionId: nativeId,
          configId: modelOption,
          value: context.settings.model,
        }),
        setupMs,
        'acp_model_timeout'
      )
      model = context.settings.model
    }
  } catch (error) {
    stopReason = 'setup_failed'
    await cleanup().catch(() => {})
    throw new Error(failure(error, 'acp_setup_failed'))
  }

  const queue: LiveInput[] = []
  let turn: Promise<void> | undefined
  const runTurn = () => {
    if (turn || !queue.length || stopReason || conn.closed) return
    const batch = queue.splice(0)
    const input_ids = batch.map((i) => i.input_id)
    for (const input_id of input_ids) sink.event({ type: LIFECYCLE.delivered, data: { input_id } })
    sink.event({ type: LIFECYCLE.started, data: { trigger: 'input' } })
    const started = Date.now()
    turn = conn
      .request('session/prompt', {
        sessionId: nativeId,
        prompt: batch.flatMap((i) => promptBlocks(i.content)),
      })
      .then(
        (result) => ({ stop: String(result?.stopReason ?? 'end_turn'), error: null }),
        (error) => ({ stop: 'error', error: failure(error, 'acp_prompt_failed') })
      )
      .then(({ stop, error }) => {
        mapper.flush()
        // A process that died ends its turn through the node's own exit handling.
        if (exitInfo || conn.closed) return
        sink.event({
          type: LIFECYCLE.completed,
          data: {
            input_ids,
            outcome:
              stop === 'cancelled'
                ? 'interrupted'
                : stop === 'error' || stop === 'refusal'
                  ? 'failed'
                  : 'success',
            subtype: stop.slice(0, 64),
            num_turns: null,
            duration_ms: Date.now() - started,
            total_cost_usd: null,
            terminal_reason: error,
          },
        })
      })
      .finally(() => {
        turn = undefined
        runTurn()
      })
  }

  return {
    done,
    send(input) {
      if (stopReason || conn.closed) throw new Error('acp_session_closed')
      queue.push(input)
      runTurn()
    },
    async interrupt() {
      if (!turn) return
      for (const controller of permissions) controller.abort()
      conn.notify('session/cancel', { sessionId: nativeId })
    },
    async control(subtype, params = {}) {
      switch (subtype) {
        case 'set_permission_mode':
          mode = String(params.mode)
          return {}
        case 'set_model': {
          if (!modelOption) throw new Error('acp_model_unsupported')
          await conn.request('session/set_config_option', {
            sessionId: nativeId,
            configId: modelOption,
            value: String(params.model),
          })
          model = String(params.model)
          return {}
        }
        case 'set_mode':
          return (
            (await conn.request('session/set_mode', {
              sessionId: nativeId,
              modeId: String(params.mode_id),
            })) ?? {}
          )
        default:
          throw new Error('acp_control_unsupported')
      }
    },
    async stop(reason) {
      stopReason ??= reason ?? 'stopped'
      for (const controller of permissions) controller.abort()
      await cleanup()
    },
  }
}
