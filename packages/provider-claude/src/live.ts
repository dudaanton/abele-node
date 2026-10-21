// One long-lived `claude -p --input-format stream-json` process per node session.
// Turns are read from the stream (a result can arrive with no input: a finished background
// task, a cron or a peer message starts a turn by itself), never assumed from requests.
import { spawn } from 'node:child_process'
import { createConnection, createServer, type Socket } from 'node:net'
import { chmodSync, writeFileSync, lstatSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createRunIpc, cleanupRunIpc, isRunIpc, verifyRunIpc, HOST_PROTOCOL } from './ipc.js'
import { ClaudeStreamDecoder, ClaudeEventMapper } from './stream.js'
import { ProcessSupervisor, type ProcessIdentity, type ProcessProbe } from './supervisor.js'
import type {
  LiveInput,
  LiveSession,
  LiveSessionContext,
  LiveSessionSink,
} from '@abele/provider-contract'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
const canonical = (v: any): string =>
  Array.isArray(v)
    ? '[' + v.map(canonical).join(',') + ']'
    : v && typeof v === 'object'
      ? '{' +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
          .join(',') +
        '}'
      : JSON.stringify(v)
/** Records that begin a turn when the process is idle. Task and rate events do not. */
const turnStart = (r: Record<string, any>) =>
  (r.type === 'system' && r.subtype === 'init') ||
  (r.type === 'system' && r.subtype === 'status' && typeof r.status === 'string') ||
  r.type === 'assistant' ||
  r.type === 'stream_event' ||
  (r.type === 'command_lifecycle' && r.state === 'started') ||
  (r.type === 'user' && r.isReplay === true)
const summaryText = (r: Record<string, any>) => {
  const c = r.message?.content
  if (typeof c === 'string') return c
  if (Array.isArray(c))
    return c
      .filter((b: any) => b?.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n')
  return ''
}

export interface LiveLaunch {
  executable: string
  args: string[]
  env?: { CLAUDE_CONFIG_DIR?: string }
  probe: ProcessProbe
  /** How long a control request may wait for its answer. */
  controlTimeoutMs?: number
  /** How long the process keeps running after its node went away without one taking it over. */
  detachedMs?: number
}

export async function startLiveSession(
  launch: LiveLaunch,
  context: LiveSessionContext,
  sink: LiveSessionSink
): Promise<LiveSession> {
  const adopt = context.adopt
  const record = adopt ? adoptionRecord(adopt.record) : undefined
  const dir = record?.ipc ?? createRunIpc()
  if (!record)
    try {
      sink.ipc?.(dir)
    } catch (error) {
      cleanupRunIpc(dir)
      throw error
    }
  const socketPath = join(dir, 'p.sock'),
    configPath = join(dir, 'mcp.json'),
    hostSocket = join(dir, 'h.sock')
  // An adopted process keeps the tokens its MCP bridge and host were started with.
  const token = record?.token ?? randomBytes(32).toString('hex'),
    generation = record?.generation ?? randomUUID(),
    hostToken = record?.host_token ?? randomBytes(32).toString('hex')
  // Throws for a directory that is not the private one this provider made: the session is lost.
  if (record) verifyRunIpc(dir, hostSocket)
  // The node that left this process running is gone; its listener file is not.
  if (record)
    try {
      if (lstatSync(socketPath).isSocket()) unlinkSync(socketPath)
    } catch {}
  const abort = new AbortController(),
    sockets = new Set<Socket>()
  // The node's own tools for the agent (debugger, worktree switch) share the per-run socket.
  // Permissions do not: they arrive as stdio control requests on the session's own stream.
  const server = createServer((socket) => {
    if (sockets.size >= 8 || abort.signal.aborted || !sink.debugger) {
      socket.destroy()
      return
    }
    sockets.add(socket)
    let pending = Buffer.alloc(0),
      requested = false
    socket.on('error', () => {})
    socket.on('close', () => sockets.delete(socket))
    socket.setTimeout(10 * 60000, () => socket.destroy())
    socket.on('data', (data) => {
      pending = Buffer.concat([pending, data])
      if (pending.length > 256 * 1024) return void socket.destroy()
      const nl = pending.indexOf(10)
      if (nl < 0 || requested) return
      requested = true
      const line = pending.subarray(0, nl)
      void (async () => {
        let p: any
        try {
          p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))
        } catch {
          return void socket.destroy()
        }
        if (
          p.version !== 1 ||
          p.kind !== 'debugger' ||
          typeof p.token !== 'string' ||
          p.token.length !== token.length ||
          !timingSafeEqual(Buffer.from(p.token), Buffer.from(token)) ||
          p.session_id !== context.session_id ||
          p.run_id !== context.run_id ||
          p.generation !== generation ||
          !sink.debugger
        )
          return void socket.destroy()
        const loss = new AbortController()
        const lost = () => loss.abort()
        socket.once('close', lost)
        abort.signal.addEventListener('abort', lost, { once: true })
        try {
          if (p.action === 'list') socket.end(JSON.stringify({ tools: sink.debugger.tools }) + '\n')
          else if (p.action === 'call' && typeof p.name === 'string') {
            if (p.name.startsWith('obsidian_')) socket.setTimeout(0)
            const result = await (p.name.startsWith('obsidian_') &&
            typeof p.call_id === 'string' &&
            p.call_id.length <= 128
              ? sink.debugger.call(p.name, p.args, loss.signal, p.call_id)
              : sink.debugger.call(p.name, p.args, loss.signal))
            if (!loss.signal.aborted) {
              const published = sink.debugger.publish(p.args, result)
              const out = JSON.stringify(published) + '\n'
              socket.end(
                Buffer.byteLength(out) <= 256 * 1024
                  ? out
                  : JSON.stringify({
                      code: 'debugger_response_too_large',
                      snapshot: null,
                      observation: 'unknown',
                    }) + '\n'
              )
            }
          } else socket.destroy()
        } finally {
          abort.signal.removeEventListener('abort', lost)
        }
      })().catch(() => socket.destroy())
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    chmodSync(socketPath, 0o600)
    if (!record)
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: sink.debugger?.tools.length
            ? {
                abele_debugger: {
                  command: process.execPath,
                  args: [fileURLToPath(new URL('./debugger-bridge.js', import.meta.url))],
                  env: {
                    ABELE_APPROVAL_SOCKET: socketPath,
                    ABELE_APPROVAL_TOKEN: token,
                    ABELE_SESSION_ID: context.session_id,
                    ABELE_RUN_ID: context.run_id,
                    ABELE_GENERATION: generation,
                  },
                },
              }
            : {},
        }),
        { mode: 0o600 }
      )
  } catch (error) {
    abort.abort()
    await new Promise<void>((resolve) => server.close(() => resolve()))
    if (!record) cleanupRunIpc(dir)
    throw error
  }
  // Re-passed on every launch and every resume: a resumed process has only what it is given.
  const args = [...launch.args, '--mcp-config', configPath, '--']
  const decoder = new ClaudeStreamDecoder(16 * 1024 * 1024),
    mapper = new ClaudeEventMapper()
  const evidence = new Map<number, ProcessIdentity>()
  let childPid: number | undefined = record?.child_pid
  let messagingSocket: string | undefined = record?.messaging_socket
  let hostPid: number | undefined
  let connection: Socket | undefined
  let detaching = false
  const hostSend = (message: unknown) => {
    if (!connection || connection.destroyed) throw new Error('session_closed')
    connection.write(JSON.stringify(message) + '\n')
  }
  const remember = () =>
    sink.attachment?.({
      version: HOST_PROTOCOL,
      ipc: dir,
      token,
      generation,
      host_token: hostToken,
      ...(childPid ? { child_pid: childPid } : {}),
      ...(messagingSocket ? { messaging_socket: messagingSocket } : {}),
    })
  let reason: string | undefined
  let started = false
  let resolveStarted!: () => void, rejectStarted!: (e: Error) => void
  const startedPromise = new Promise<void>((resolve, reject) => {
    resolveStarted = resolve
    rejectStarted = reject
  })
  const backlog: string[] = []
  const write = (record: unknown) => {
    const line = JSON.stringify(record)
    if (!started) backlog.push(line)
    else hostSend({ kind: 'write', line })
  }
  // Turn state is derived from the stream; an adopted process continues where the node stopped.
  let running = adopt?.running ?? false
  let interruptRequested = false
  let sawNotification = false
  let sawCommand = false
  let awaitingSummary = false
  let turnStartedAt = 0
  let turnInputs: string[] = adopt?.running ? [...adopt.delivered] : []
  const writes: { input_id: string; key: string; at: number; compact: boolean }[] = (
    adopt?.dispatching ?? []
  ).map((input) => ({
    input_id: input.input_id,
    key: canonical(input.content),
    at: 0,
    compact: typeof input.content === 'string' && /^\/compact(\s|$)/.test(input.content),
  }))
  const controls = new Map<
    string,
    { resolve: (v: Record<string, any>) => void; reject: (e: Error) => void }
  >()
  const permissions = new Map<string, AbortController>()
  const emit = (type: string, data: Record<string, unknown>) => sink.event({ type, data })
  const delivered = (input_id: string) => {
    turnInputs.push(input_id)
    emit('claude.input.delivered', { input_id })
  }
  const control = (subtype: string, params: Record<string, unknown> = {}) =>
    new Promise<Record<string, any>>((resolve, reject) => {
      if (abort.signal.aborted) return reject(new Error('session_closed'))
      const request_id = randomUUID()
      const timer = setTimeout(() => {
        controls.delete(request_id)
        reject(new Error('control_timeout'))
      }, launch.controlTimeoutMs ?? 30000)
      controls.set(request_id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      try {
        write({ type: 'control_request', request_id, request: { subtype, ...params } })
      } catch (error) {
        controls.delete(request_id)
        clearTimeout(timer)
        reject(error as Error)
      }
    })
  const refreshContext = () => {
    void control('get_context_usage')
      .then((u) => {
        const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
        emit('claude.context', {
          total_tokens: n(u.totalTokens),
          max_tokens: n(u.maxTokens),
          percentage: n(u.percentage),
          auto_compact_threshold: n(u.autoCompactThreshold),
          auto_compact_enabled:
            typeof u.isAutoCompactEnabled === 'boolean' ? u.isAutoCompactEnabled : null,
          model: typeof u.model === 'string' ? u.model : null,
          categories: Array.isArray(u.categories)
            ? u.categories
                .filter((c: any) => typeof c?.name === 'string' && typeof c?.tokens === 'number')
                .slice(0, 32)
                .map((c: any) => ({
                  name: String(c.name).slice(0, 128),
                  tokens: c.tokens,
                  ...(c.isDeferred === true ? { deferred: true } : {}),
                }))
            : [],
        })
      })
      .catch(() => {})
  }
  const answerPermission = async (request_id: string, request: Record<string, any>) => {
    const input = request.input && typeof request.input === 'object' ? request.input : {}
    const tool_name = typeof request.tool_name === 'string' ? request.tool_name : 'unknown'
    const tool_use_id =
      typeof request.tool_use_id === 'string' ? request.tool_use_id : 'request-' + request_id
    const reply = (response: Record<string, unknown>) => {
      try {
        write({ type: 'control_response', response: { subtype: 'success', request_id, response } })
      } catch {}
    }
    if (tool_name === 'AskUserQuestion') {
      emit('claude.unsupported_tool', {
        tool_name,
        tool_use_id,
        reason: 'Question-response bridge unsupported',
      })
      return reply({ behavior: 'deny', message: 'AskUserQuestion is unsupported by this node' })
    }
    // A question re-sent by the host after a node restart may also be in the replayed stream.
    if (permissions.has(request_id)) return
    const loss = new AbortController()
    permissions.set(request_id, loss)
    const lost = () => loss.abort()
    abort.signal.addEventListener('abort', lost, { once: true })
    try {
      const answer = await sink.permission(
        {
          tool_use_id,
          tool_name,
          input,
          kind: 'permission',
          ttl_ms: context.permission_ttl_ms,
          ...(typeof request.description === 'string'
            ? { title: request.description.slice(0, 4096) }
            : {}),
        },
        loss.signal
      )
      // An interrupted turn still gets its answer; a closed process needs none.
      if (loss.signal.aborted) {
        if (!abort.signal.aborted) reply({ behavior: 'deny', message: 'Turn interrupted' })
        return
      }
      const allowed = answer.choice === 'allow' && answer.delivered() !== false
      reply(
        allowed
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'Node denied or expired this exact action' }
      )
    } catch {
      if (!abort.signal.aborted)
        reply({ behavior: 'deny', message: 'Node approval unavailable, invalid or expired' })
    } finally {
      permissions.delete(request_id)
      abort.signal.removeEventListener('abort', lost)
    }
  }
  const handle = (r: Record<string, any>) => {
    if (r.type === 'control_response') {
      const response = r.response ?? {}
      const pending = controls.get(response.request_id)
      if (!pending) return
      controls.delete(response.request_id)
      if (response.subtype === 'success') pending.resolve(response.response ?? {})
      else pending.reject(new Error(String(response.error ?? 'control_failed').slice(0, 200)))
      return
    }
    if (r.type === 'control_request') {
      const request = r.request ?? {}
      if (request.subtype === 'can_use_tool' && typeof r.request_id === 'string')
        void answerPermission(r.request_id, request)
      else if (typeof r.request_id === 'string')
        write({
          type: 'control_response',
          response: { subtype: 'error', request_id: r.request_id, error: 'unsupported' },
        })
      return
    }
    if (r.type === 'control_cancel_request') {
      permissions.get(r.request_id)?.abort()
      return
    }
    // Inputs are delivered when the CLI echoes them back as it consumes them.
    if (r.type === 'user' && r.isReplay === true && !r.parent_tool_use_id) {
      const key = canonical(r.message?.content)
      const at = writes.findIndex((w) => w.input_id === r.uuid || w.key === key)
      if (at >= 0) delivered(writes.splice(at, 1)[0]!.input_id)
    }
    if (r.type === 'system' && r.subtype === 'status' && r.status === 'compacting') {
      // A compaction command is not always echoed; its status is the evidence.
      const at = writes.findIndex((w) => w.compact)
      if (at >= 0) delivered(writes.splice(at, 1)[0]!.input_id)
    }
    if (r.type === 'system' && r.subtype === 'task_notification') sawNotification = true
    if (r.type === 'command_lifecycle' && r.state === 'started') sawCommand = true
    if (
      r.type === 'system' &&
      r.subtype === 'init' &&
      typeof r.messaging_socket_path === 'string' &&
      r.messaging_socket_path !== messagingSocket
    ) {
      messagingSocket = r.messaging_socket_path
      remember()
    }
    if (!running && turnStart(r)) {
      running = true
      turnStartedAt = Date.now()
      // Every CLI turn is framed as a command; the owner's input or a finished task says why.
      const pending = writes[0]
      emit('claude.turn.started', {
        trigger:
          (r.type === 'system' && r.status === 'compacting') || pending?.compact
            ? 'compact'
            : turnInputs.length || (r.type === 'user' && r.isReplay)
              ? 'input'
              : sawNotification
                ? 'task'
                : pending
                  ? 'input'
                  : sawCommand
                    ? 'command'
                    : 'unknown',
      })
    }
    if (awaitingSummary && r.type === 'user' && !r.isReplay && !r.parent_tool_use_id) {
      const text = summaryText(r)
      if (text && !text.startsWith('<local-command')) {
        awaitingSummary = false
        emit('claude.compact.summary', { text })
      }
    }
    if (r.type === 'system' && r.subtype === 'compact_boundary') awaitingSummary = true
    for (const event of mapper.map(r)) sink.event(event)
    if (r.type === 'system' && r.subtype === 'compact_boundary') refreshContext()
    if (r.type === 'result') {
      // Nothing waits in the CLI's queue: inputs written before this turn were consumed by it.
      if (r.queued_turn_count === 0)
        for (let i = writes.length - 1; i >= 0; i--)
          if (writes[i]!.at <= turnStartedAt) delivered(writes.splice(i, 1)[0]!.input_id)
      emit('claude.turn.completed', {
        input_ids: turnInputs,
        outcome: interruptRequested
          ? 'interrupted'
          : r.is_error === true || r.subtype !== 'success'
            ? 'failed'
            : 'success',
        subtype: typeof r.subtype === 'string' ? r.subtype : null,
        num_turns: typeof r.num_turns === 'number' ? r.num_turns : null,
        duration_ms: typeof r.duration_ms === 'number' ? r.duration_ms : null,
        total_cost_usd: typeof r.total_cost_usd === 'number' ? r.total_cost_usd : null,
        terminal_reason: typeof r.terminal_reason === 'string' ? r.terminal_reason : null,
      })
      running = false
      interruptRequested = false
      sawNotification = false
      sawCommand = false
      turnInputs = []
      refreshContext()
    }
  }
  const persist = (list: ProcessIdentity[]) => {
    for (const p of list) {
      if (
        !Number.isSafeInteger(p.pid) ||
        p.pid < 2 ||
        typeof p.fingerprint !== 'string' ||
        !Number.isSafeInteger(p.group) ||
        p.group < 2
      )
        throw new Error('invalid_worker_evidence')
      evidence.set(p.pid, p)
    }
    sink.processes(list)
  }
  let resolveDone!: (v: {
    reason?: string
    exit_code?: number | null
    signal?: string | null
  }) => void
  const done = new Promise<{ reason?: string; exit_code?: number | null; signal?: string | null }>(
    (resolve) => (resolveDone = resolve)
  )
  let exit: { code: number | null; signal: string | null } = { code: null, signal: null }
  let finalizing: Promise<void> | undefined
  const finalize = () =>
    (finalizing ??= (async () => {
      abort.abort()
      for (const pending of controls.values()) pending.reject(new Error('session_closed'))
      controls.clear()
      try {
        sink.debugger?.close()
      } catch {}
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      connection?.destroy()
      if (detaching) {
        // The process keeps running in its host; the next node adopts it.
        if (!started) rejectStarted(new Error('detached'))
        return resolveDone({ reason: 'detached' })
      }
      let confirmed = false
      try {
        if (hostPid && !evidence.has(hostPid) && launch.probe.identity(hostPid))
          throw new Error('worker_identity_unconfirmed')
        await ProcessSupervisor.cleanup([...evidence.values()], 500, launch.probe)
        cleanupRunIpc(dir)
        confirmed = true
      } catch {}
      // A killed CLI leaves its peer-messaging socket behind; only ours, only once it is dead.
      const match = messagingSocket && /\/cc-socks\/(\d+)\.sock$/.exec(messagingSocket)
      if (confirmed && match && Number(match[1]) === childPid) {
        try {
          if (lstatSync(messagingSocket!).isSocket()) unlinkSync(messagingSocket!)
        } catch {}
      }
      if (!started) rejectStarted(new Error(reason ?? 'session_start_failed'))
      resolveDone({
        ...(confirmed ? (reason ? { reason } : {}) : { reason: 'process_cleanup_unconfirmed' }),
        exit_code: exit.code,
        signal: exit.signal,
      })
    })())
  const stop = async (why = 'stopped') => {
    reason ??= why
    abort.abort()
    try {
      hostSend({ kind: 'stop' })
    } catch {}
    await Promise.race([done, delay(500)])
    await finalize()
    const result = await done
    if (result.reason === 'process_cleanup_unconfirmed')
      throw new Error('process_cleanup_unconfirmed')
  }
  // Output is taken in whole lines from the position the node journaled last. Only then is it
  // acknowledged, so the host keeps everything a node that dies mid-way has not recorded yet.
  let consumed = adopt?.offset ?? 0
  let partial = Buffer.alloc(0)
  const output = (offset: number, data: Buffer) => {
    const expected = consumed + partial.length
    if (offset > expected) throw new Error('stream_gap')
    if (offset + data.length <= expected) return
    partial = Buffer.concat([partial, data.subarray(expected - offset)])
    const nl = partial.lastIndexOf(10)
    if (nl < 0) {
      if (partial.length > 16 * 1024 * 1024) throw new Error('stream_line_too_long')
      return
    }
    const lines = partial.subarray(0, nl + 1)
    partial = partial.subarray(nl + 1)
    for (let at = 0; at < lines.length; at += 64 * 1024)
      sink.event({
        type: 'claude.raw',
        data: {
          channel: 'stdout',
          base64: lines.subarray(at, Math.min(at + 64 * 1024, lines.length)).toString('base64'),
        },
      })
    for (const r of decoder.push(lines)) handle(r)
    consumed += lines.length
    sink.checkpoint?.(consumed)
    try {
      hostSend({ kind: 'ack', offset: consumed })
    } catch {}
  }
  const onHost = (m: any) => {
    if (m?.kind === 'attached' && m.version === HOST_PROTOCOL && Array.isArray(m.inventory)) {
      persist(m.inventory)
      if (m.child && Number.isSafeInteger(m.child.pid)) childPid = m.child.pid
      started = true
      for (const line of backlog.splice(0)) hostSend({ kind: 'write', line })
      // Questions the CLI is still waiting on, asked again of the owner.
      if (Array.isArray(m.pending))
        for (const line of m.pending)
          if (typeof line === 'string') {
            const r = JSON.parse(line)
            if (r?.type === 'control_request') handle(r)
          }
      resolveStarted()
    } else if (m?.kind === 'inventory' && Array.isArray(m.evidence)) persist(m.evidence)
    else if (
      m?.kind === 'stdout' &&
      Number.isSafeInteger(m.offset) &&
      typeof m.base64 === 'string' &&
      m.base64.length <= 128 * 1024
    )
      output(m.offset, Buffer.from(m.base64, 'base64'))
    else if (m?.kind === 'stderr' && typeof m.base64 === 'string' && m.base64.length <= 128 * 1024)
      sink.event({ type: 'claude.raw', data: { channel: 'stderr', base64: m.base64 } })
    else if (m?.kind === 'exit') {
      exit = { code: m.code ?? null, signal: m.signal ?? null }
      if (m.code !== 0) reason ??= m.reason ?? 'process_exited'
      try {
        decoder.end()
        if (partial.length) throw new Error('truncated_output')
      } catch {
        reason ??= 'truncated_output'
      }
      try {
        hostSend({ kind: 'ack', offset: consumed + partial.length })
      } catch {}
      void finalize()
    }
  }
  const attach = (offset: number) => {
    const socket = createConnection(hostSocket)
    connection = socket
    let pending = Buffer.alloc(0)
    socket.on('connect', () =>
      socket.write(
        JSON.stringify({ kind: 'attach', version: HOST_PROTOCOL, token: hostToken, offset }) + '\n'
      )
    )
    socket.on('error', () => {})
    socket.on('close', () => {
      if (detaching) return
      // The host is gone without saying the process exited.
      reason ??= started ? 'worker_lost' : 'process_lost'
      void finalize()
    })
    socket.on('data', (data) => {
      pending = Buffer.concat([pending, data])
      let nl: number
      while ((nl = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, nl)
        pending = pending.subarray(nl + 1)
        try {
          onHost(JSON.parse(line.toString('utf8')))
        } catch (error) {
          reason ??= error instanceof Error ? error.message : 'sink_failure'
          void stop().catch(() => {})
          return
        }
      }
      if (pending.length > 1024 * 1024) socket.destroy()
    })
  }
  if (record) attach(consumed)
  else {
    const host = spawn(
      process.execPath,
      [fileURLToPath(new URL('./session-host.js', import.meta.url))],
      { detached: true, stdio: ['pipe', 'pipe', 'ignore'] }
    )
    hostPid = host.pid
    host.stdin.on('error', () => {})
    host.stdin.end(
      JSON.stringify({
        executable: launch.executable,
        cwd: context.cwd,
        args,
        ...(launch.env?.CLAUDE_CONFIG_DIR ? { env: launch.env } : {}),
        socket: hostSocket,
        token: hostToken,
        ipc: dir,
        detachedMs: launch.detachedMs ?? 10 * 60000,
        bufferBytes: 32 * 1024 * 1024,
      })
    )
    let announced = ''
    host.stdout.setEncoding('utf8')
    host.stdout.on('data', (data: string) => {
      announced += data
      let nl: number
      while ((nl = announced.indexOf('\n')) >= 0) {
        const line = announced.slice(0, nl)
        announced = announced.slice(nl + 1)
        try {
          const m = JSON.parse(line)
          if (m?.kind === 'host' && m.evidence) persist([m.evidence])
          else if (m?.kind === 'spawned' && m.evidence) {
            persist([m.evidence])
            childPid = m.evidence.pid
            remember()
            // Stopped while starting: the evidence just recorded is what ends it.
            if (!abort.signal.aborted) attach(0)
          } else if (m?.kind === 'failed') {
            reason ??= 'spawn_failed'
            void finalize()
          }
        } catch (error) {
          reason ??= error instanceof Error ? error.message : 'sink_failure'
          void stop().catch(() => {})
        }
      }
    })
    host.once('exit', (code, signal) => {
      if (!connection && !started) {
        if (code !== 0 || signal) reason ??= 'worker_lost'
        void finalize()
      }
    })
    host.unref()
  }
  await startedPromise
  return {
    done,
    send(input: LiveInput) {
      const content = input.content
      writes.push({
        input_id: input.input_id,
        key: canonical(content),
        at: Date.now(),
        compact: typeof content === 'string' && /^\/compact(\s|$)/.test(content),
      })
      write({
        type: 'user',
        uuid: input.input_id,
        message: { role: 'user', content },
        parent_tool_use_id: null,
        session_id: '',
      })
    },
    async interrupt() {
      if (running) interruptRequested = true
      for (const loss of permissions.values()) loss.abort()
      await control('interrupt')
    },
    control,
    stop,
    async detach() {
      detaching = true
      await finalize()
    },
  }
}
interface AdoptionRecord {
  ipc: string
  token: string
  generation: string
  host_token: string
  child_pid?: number
  messaging_socket?: string
}
/** Only a record this provider wrote, for a directory it manages. */
function adoptionRecord(r: Record<string, unknown>): AdoptionRecord {
  const hex = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v)
  if (
    r.version !== HOST_PROTOCOL ||
    typeof r.ipc !== 'string' ||
    !isRunIpc(r.ipc) ||
    !hex(r.token) ||
    !hex(r.host_token) ||
    typeof r.generation !== 'string' ||
    (r.child_pid !== undefined && !Number.isSafeInteger(r.child_pid)) ||
    (r.messaging_socket !== undefined && typeof r.messaging_socket !== 'string')
  )
    throw new Error('invalid_adoption_record')
  return r as unknown as AdoptionRecord
}
