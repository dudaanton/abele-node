// One long-lived pi SDK worker per node session, held by the same detachable session host as a
// Claude session: a node restart or update leaves it and its turn running, and the next node
// takes it over from the last line it journaled.
import { spawn } from 'node:child_process'
import { createConnection, type Socket } from 'node:net'
import { lstatSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID } from 'node:crypto'
import {
  createRunIpc,
  cleanupRunIpc,
  isRunIpc,
  verifyRunIpc,
  HOST_PROTOCOL,
  SESSION_HOST,
  ProcessSupervisor,
  type ProcessIdentity,
  type ProcessProbe,
} from '@abele/provider-claude'
import type {
  Answer,
  LiveInput,
  LiveSession,
  LiveSessionContext,
  LiveSessionSink,
} from '@abele/provider-contract'
import { LiveWorkerMessageSchema } from './wire.js'
import type { HostConfiguration } from './sdk-runtime.js'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
export interface PiLiveLaunch {
  probe: ProcessProbe
  hostModule: string
  /** The session's own native directory; its file is checked to stay inside it. */
  root: string
  config: HostConfiguration
  detachedMs: number
  controlTimeoutMs?: number
}
type Done = { reason?: string; exit_code?: number | null; signal?: string | null }

export async function startPiLiveSession(
  launch: PiLiveLaunch,
  context: LiveSessionContext,
  sink: LiveSessionSink
): Promise<LiveSession> {
  const adopt = context.adopt
  const record = adopt ? adoptionRecord(adopt.record) : undefined
  const dir = record?.ipc ?? createRunIpc()
  const hostSocket = join(dir, 'h.sock'),
    configPath = join(dir, 'pi.json')
  const hostToken = record?.host_token ?? randomBytes(32).toString('hex')
  if (record) verifyRunIpc(dir, hostSocket)
  else
    try {
      sink.ipc?.(dir)
      writeFileSync(
        configPath,
        JSON.stringify({ hostModule: launch.hostModule, config: launch.config }),
        {
          mode: 0o600,
        }
      )
    } catch (error) {
      cleanupRunIpc(dir)
      throw error
    }
  const abort = new AbortController()
  const evidence = new Map<number, ProcessIdentity>()
  const questions = new Map<string, AbortController>(),
    answers = new Map<string, Answer>(),
    claims = new Set<string>(),
    debuggerCalls = new Map<string, AbortController>(),
    controls = new Map<string, { resolve(v: Record<string, any>): void; reject(e: Error): void }>()
  let childPid = record?.child_pid
  let hostPid: number | undefined
  let connection: Socket | undefined
  let detaching = false,
    started = false,
    reason: string | undefined
  let resolveStarted!: () => void, rejectStarted!: (e: Error) => void
  const startedPromise = new Promise<void>((res, rej) => {
    resolveStarted = res
    rejectStarted = rej
  })
  const backlog: string[] = []
  let attached = false
  const hostSend = (message: unknown) => {
    if (!connection || connection.destroyed) throw new Error('session_closed')
    connection.write(JSON.stringify(message) + '\n')
  }
  const write = (message: unknown) => {
    const line = JSON.stringify(message)
    if (!attached) backlog.push(line)
    else hostSend({ kind: 'write', line })
  }
  const remember = () =>
    sink.attachment?.({
      version: HOST_PROTOCOL,
      provider: 'pi',
      ipc: dir,
      host_token: hostToken,
      ...(childPid ? { child_pid: childPid } : {}),
    })
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
  const ask = async (id: string, action: any) => {
    const question = new AbortController()
    questions.set(id, question)
    const signal = AbortSignal.any([abort.signal, question.signal])
    let answer: Answer | undefined
    try {
      answer = await sink.permission(action, signal)
    } catch {}
    if (signal.aborted) return
    if (!answer) return write({ kind: 'answer', id, choice: 'deny' })
    answers.set(id, answer)
    write({
      kind: 'answer',
      id,
      choice: answer.choice,
      ...(answer.value !== undefined ? { value: answer.value } : {}),
    })
  }
  const debuggerCall = async (id: string, name: string, args: unknown) => {
    if (!sink.debugger || debuggerCalls.size >= 64) throw new Error('invalid_debugger_call')
    const call = new AbortController()
    debuggerCalls.set(id, call)
    const signal = AbortSignal.any([abort.signal, call.signal])
    try {
      const result = await sink.debugger.call(name, args, signal)
      if (!signal.aborted)
        write({ kind: 'debugger_result', id, result: sink.debugger.publish(args, result) })
    } finally {
      debuggerCalls.delete(id)
    }
  }
  const handle = (raw: unknown) => {
    const m = LiveWorkerMessageSchema.parse(raw)
    if (m.kind === 'ready') {
      if (!record) {
        started = true
        resolveStarted()
      }
    } else if (m.kind === 'failed') {
      reason ??= m.reason
      void stop().catch(() => {})
    } else if (m.kind === 'event') {
      if (m.event.type === 'pi.session.bound') {
        const file = m.event.data.native_session_file
        if (typeof file !== 'string' || resolve(dirname(file)) !== launch.root)
          throw new Error('invalid_pi_session_mapping')
      }
      sink.event(m.event)
    } else if (m.kind === 'control_result') {
      const pending = controls.get(m.id)
      controls.delete(m.id)
      if (m.ok) pending?.resolve(m.result ?? {})
      else pending?.reject(new Error(m.error ?? 'control_failed'))
    } else if (m.kind === 'question') {
      // Asked again by the worker after a takeover, or replayed from the host: once.
      if (questions.has(m.id)) return
      if (questions.size >= 256) throw new Error('invalid_pi_approval')
      void ask(m.id, { ...m.action, ttl_ms: m.action.ttl_ms ?? context.permission_ttl_ms })
    } else if (m.kind === 'question_cancel') {
      questions.get(m.id)?.abort()
      answers.delete(m.id)
    } else if (m.kind === 'consume') {
      const answer = answers.get(m.id),
        question = questions.get(m.id)
      answers.delete(m.id)
      const confirmed =
        !abort.signal.aborted &&
        !!question &&
        !question.signal.aborted &&
        answer?.delivered() === true
      write({ kind: 'confirmed', id: m.id, confirmed })
    } else if (m.kind === 'process_claim') {
      if (claims.has(m.id)) return
      claims.add(m.id)
      const p = m.evidence
      const actual = launch.probe.identity(p.pid)
      if (
        p.pid !== p.group ||
        p.pid === childPid ||
        p.pid === process.pid ||
        !actual ||
        actual.group !== p.group ||
        actual.fingerprint !== p.fingerprint
      )
        throw new Error('invalid_process_claim')
      persist([p]) // committed before the shell may start in that group
      write({ kind: 'registered', id: m.id, confirmed: true })
    } else if (m.kind === 'group_reaped') {
      if (claims.has(m.id)) return
      claims.add(m.id)
      const p = m.evidence,
        known = evidence.get(p.pid)
      if (!known || known.fingerprint !== p.fingerprint || p.pid !== p.group)
        throw new Error('invalid_group_release')
      if (launch.probe.groupMembers(p).length) throw new Error('process_cleanup_unconfirmed')
      write({ kind: 'registered', id: m.id, confirmed: true })
    } else if (m.kind === 'debugger_call') {
      if (debuggerCalls.has(m.id)) return
      void debuggerCall(m.id, m.name, m.args).catch(() => {})
    } else if (m.kind === 'debugger_cancel') {
      debuggerCalls.get(m.id)?.abort()
    }
  }
  let resolveDone!: (v: Done) => void
  const done = new Promise<Done>((r) => (resolveDone = r))
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
      connection?.destroy()
      if (detaching) {
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
      if (!started) rejectStarted(new Error(reason ?? 'session_start_failed'))
      resolveDone({
        ...(confirmed ? (reason ? { reason } : {}) : { reason: 'process_cleanup_unconfirmed' }),
        exit_code: exit.code,
        signal: exit.signal,
      })
    })())
  const stop = async (why = 'stopped') => {
    reason ??= why
    // The worker ends its own turn and process groups first; the host ends whatever is left.
    try {
      write({ kind: 'stop' })
    } catch {}
    await Promise.race([done, delay(2000)])
    abort.abort()
    try {
      hostSend({ kind: 'stop' })
    } catch {}
    await Promise.race([done, delay(500)])
    await finalize()
    if ((await done).reason === 'process_cleanup_unconfirmed')
      throw new Error('process_cleanup_unconfirmed')
  }
  // Whole lines, from the position the node journaled last; acknowledged only once handled.
  let consumed = adopt?.offset ?? 0
  let partial = Buffer.alloc(0)
  const output = (offset: number, data: Buffer) => {
    const expected = consumed + partial.length
    if (offset > expected) throw new Error('stream_gap')
    if (offset + data.length <= expected) return
    partial = Buffer.concat([partial, data.subarray(expected - offset)])
    let nl: number
    while ((nl = partial.indexOf(10)) >= 0) {
      const line = partial.subarray(0, nl).toString('utf8')
      partial = partial.subarray(nl + 1)
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        message = undefined // stray output is not a message
      }
      if (message !== undefined) handle(message)
      consumed += nl + 1
    }
    if (partial.length > 2 * 1024 * 1024) throw new Error('stream_line_too_long')
    sink.checkpoint?.(consumed)
    try {
      hostSend({ kind: 'ack', offset: consumed })
    } catch {}
  }
  const onHost = (m: any) => {
    if (m?.kind === 'attached' && m.version === HOST_PROTOCOL && Array.isArray(m.inventory)) {
      persist(m.inventory)
      if (m.child && Number.isSafeInteger(m.child.pid)) childPid = m.child.pid
      attached = true
      for (const line of backlog.splice(0)) hostSend({ kind: 'write', line })
      if (record) {
        // A worker that outlived its node asks again whatever waited on it.
        hostSend({ kind: 'write', line: JSON.stringify({ kind: 'attached' }) })
        for (const input of adopt!.dispatching)
          hostSend({ kind: 'write', line: JSON.stringify(inputMessage(input)) })
        started = true
        resolveStarted()
      }
    } else if (m?.kind === 'inventory' && Array.isArray(m.evidence)) persist(m.evidence)
    else if (
      m?.kind === 'stdout' &&
      Number.isSafeInteger(m.offset) &&
      typeof m.base64 === 'string' &&
      m.base64.length <= 128 * 1024
    )
      output(m.offset, Buffer.from(m.base64, 'base64'))
    else if (m?.kind === 'exit') {
      exit = { code: m.code ?? null, signal: m.signal ?? null }
      if (m.code !== 0) reason ??= 'process_exited'
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
          reason ??= error instanceof Error ? error.message.slice(0, 128) : 'sink_failure'
          void stop().catch(() => {})
          return
        }
      }
      if (pending.length > 1024 * 1024) socket.destroy()
    })
  }
  if (record) attach(consumed)
  else {
    const host = spawn(process.execPath, [SESSION_HOST], {
      detached: true,
      stdio: ['pipe', 'pipe', 'ignore'],
      env: { ...process.env, npm_config_ignore_scripts: 'true' },
    })
    hostPid = host.pid
    host.stdin.on('error', () => {})
    host.stdin.end(
      JSON.stringify({
        executable: process.execPath,
        cwd: context.cwd,
        args: [fileURLToPath(new URL('./live-worker.js', import.meta.url)), configPath],
        socket: hostSocket,
        token: hostToken,
        ipc: dir,
        detachedMs: launch.detachedMs,
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
            if (!abort.signal.aborted) attach(0)
          } else if (m?.kind === 'failed') {
            reason ??= 'spawn_failed'
            void finalize()
          }
        } catch (error) {
          reason ??= error instanceof Error ? error.message.slice(0, 128) : 'sink_failure'
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
  try {
    await startedPromise
  } catch (error) {
    await done
    throw error
  }
  return {
    done,
    send(input: LiveInput) {
      write(inputMessage(input))
    },
    async interrupt() {
      for (const question of questions.values()) question.abort()
      write({ kind: 'interrupt' })
    },
    control: (subtype, params = {}) =>
      new Promise((res, rej) => {
        if (abort.signal.aborted) return rej(new Error('session_closed'))
        const id = randomUUID()
        const timer = setTimeout(() => {
          controls.delete(id)
          rej(new Error('control_timeout'))
        }, launch.controlTimeoutMs ?? 30000)
        controls.set(id, {
          resolve: (v) => {
            clearTimeout(timer)
            res(v)
          },
          reject: (e) => {
            clearTimeout(timer)
            rej(e)
          },
        })
        write({ kind: 'control', id, subtype, params })
      }),
    stop,
    async detach() {
      detaching = true
      await finalize()
    },
  }
}
function inputMessage(input: LiveInput) {
  const text =
    typeof input.content === 'string'
      ? input.content
      : input.content
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text as string)
          .join('\n')
  return { kind: 'input', input_id: input.input_id, text }
}
interface AdoptionRecord {
  ipc: string
  host_token: string
  child_pid?: number
}
/** Only a record this provider wrote, for a directory it manages. */
function adoptionRecord(r: Record<string, unknown>): AdoptionRecord {
  if (
    r.version !== HOST_PROTOCOL ||
    r.provider !== 'pi' ||
    typeof r.ipc !== 'string' ||
    !isRunIpc(r.ipc) ||
    typeof r.host_token !== 'string' ||
    !/^[0-9a-f]{64}$/.test(r.host_token) ||
    (r.child_pid !== undefined && !Number.isSafeInteger(r.child_pid))
  )
    throw new Error('invalid_adoption_record')
  try {
    lstatSync(join(r.ipc, 'h.sock'))
  } catch {
    throw new Error('session_lost')
  }
  return r as unknown as AdoptionRecord
}
