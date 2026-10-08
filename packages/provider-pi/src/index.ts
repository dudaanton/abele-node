import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFileSync, mkdirSync, chmodSync, realpathSync, lstatSync } from 'node:fs'
import { isAbsolute, join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import {
  ProcessSupervisor,
  systemProcessProbe,
  type ProcessProbe,
  type ProcessIdentity,
  type ProviderEventSink,
  type ProviderRun,
  type TurnContext,
} from '@abele/provider-claude'
import { WorkerMessageSchema } from './wire.js'
import type { PiAction, Answer } from './host.js'
export { PiApprovalPolicy, PiExtensionUiBridge, PiSdkWorker, PiEventMapper } from './host.js'
export type { PiAction, Answer, PiEvent, HostRuntime, HostSession } from './host.js'
export interface PiOptions {
  stateDir: string
  agentDir?: string
  provider?: string
  model?: string
  profile?: 'inherited' | 'isolated'
  maxTokens?: number
  deadlineMs?: number
  permissionTtlMs?: number
  /** Node-local test/embedding seam; never a protocol field. */
  hostModule?: string
  processProbe?: ProcessProbe
}
export interface PiSink extends ProviderEventSink {
  question?(action: PiAction, signal: AbortSignal): Promise<Answer>
  reaped?(leader: ProcessIdentity): void
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
export class PiProviderAdapter {
  readonly available: boolean
  readonly configuration: Record<string, any>
  private options: Required<Omit<PiOptions, 'processProbe'>>
  private probe: ProcessProbe
  constructor(options: PiOptions) {
    this.options = {
      stateDir: options.stateDir,
      agentDir: options.agentDir ?? join(homedir(), '.pi/agent'),
      provider: options.provider ?? '',
      model: options.model ?? '',
      profile: options.profile ?? 'inherited',
      maxTokens: options.maxTokens ?? 4096,
      deadlineMs: options.deadlineMs ?? 120000,
      permissionTtlMs: options.permissionTtlMs ?? 60000,
      hostModule:
        options.hostModule ??
        process.env.ABELE_PI_HOST ??
        fileURLToPath(new URL('./sdk-host.js', import.meta.url)),
    }
    this.probe = options.processProbe ?? systemProcessProbe
    const o = this.options
    if (
      ![o.stateDir, o.agentDir, o.hostModule].every(isAbsolute) ||
      !['inherited', 'isolated'].includes(o.profile) ||
      (o.provider !== '' && !/^[A-Za-z0-9_.-]{1,128}$/.test(o.provider)) ||
      (o.model !== '' && !/^[A-Za-z0-9_./:-]{1,256}$/.test(o.model)) ||
      !Number.isSafeInteger(o.maxTokens) ||
      o.maxTokens < 64 ||
      o.maxTokens > 32768 ||
      !Number.isSafeInteger(o.deadlineMs) ||
      o.deadlineMs < 1000 ||
      o.deadlineMs > 1800000 ||
      !Number.isSafeInteger(o.permissionTtlMs) ||
      o.permissionTtlMs < 1 ||
      o.permissionTtlMs > 3600000
    )
      throw new Error('invalid_pi_configuration')
    let version = 'unavailable'
    try {
      const pkg = new URL('../package.json', import.meta.resolve('@earendil-works/pi-coding-agent'))
      version = JSON.parse(readFileSync(pkg, 'utf8')).version
    } catch {}
    let patch = 'unavailable'
    try {
      const sdkRequire = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'))
      const minimatchRequire = createRequire(sdkRequire.resolve('minimatch'))
      const brace = minimatchRequire.resolve('brace-expansion')
      patch = JSON.parse(readFileSync(join(dirname(brace), '../../package.json'), 'utf8')).version
    } catch {}
    this.available = version === '0.87.0' && patch === '5.0.12'
    this.configuration = {
      sdk_version: version,
      brace_expansion_version: patch,
      model_provider: o.provider || 'sdk-user-settings',
      model: o.model || 'sdk-user-settings',
      profile: o.profile,
      max_tokens: o.maxTokens,
      deadline_ms: o.deadlineMs,
      permission_ttl_ms: o.permissionTtlMs,
      approval_policy:
        'Every SDK tool needs one exact durable node answer; unavailable means deny. Trusted local extensions are not sandboxed.',
      resources:
        o.profile === 'inherited'
          ? 'DefaultResourceLoader; node project trust first; local supported skills/context/extensions'
          : 'Isolated resources, same local ModelRuntime auth/configuration',
      credentials: 'Worker-local ModelRuntime; no endpoints, headers, environment or auth exported',
      steering: 'unsupported; ordinary followups stay in node queue',
    }
  }
  configurationForTurn(_turn: unknown) {
    return this.configuration
  }
  capabilities() {
    const supported = (evidence: string) => ({ status: 'supported', evidence })
    const unsupported = (reason: string) => ({ status: 'unsupported', reason })
    const unverified = (reason: string) => ({ status: 'unverified', reason })
    return {
      provider: 'pi',
      provider_version: '0.87.0',
      available: this.available,
      diagnostic: this.available
        ? 'Pinned SDK installed; model selection/authentication are resolved locally inside the worker. Inspect per-feature capability gates.'
        : 'Install and build pinned SDK 0.87.0 with audited brace-expansion 5.0.12',
      configuration: this.configuration,
      capabilities: {
        execution: this.available
          ? supported('supervised-sdk-worker-v1')
          : unsupported('SDK missing'),
        streaming: supported('pi-message-replacement-v1'),
        permissions: this.available
          ? supported('sdk-0.87.0-node-client-allow-deny-expiry-v1')
          : unsupported('Pinned and prepared SDK required'),
        resume: this.available
          ? supported('sdk-0.87.0-native-file-interrupt-resume-v1')
          : unsupported('Pinned and prepared SDK required'),
        queued_followups: supported('node-queue-session-idle-v1'),
        extension_prompts: unverified(
          'Durable select/confirm/input/trust bridge passed fake SDK tests; real inherited extension compatibility is not yet accepted'
        ),
        compaction: unverified(
          'Retry/compaction/settled boundaries and retained journal passed fake SDK tests; real compaction not exercised'
        ),
        steering: unsupported('No unverified steer API'),
        custom_ui: unsupported('No TUI emulation; capability error'),
        exhaustive_children: {
          status: 'unverified',
          reason: 'Native extension child evidence retained; not node sessions',
        },
      },
    }
  }
  async reconcile(evidence: ProcessIdentity[], _ipcDirectory?: string) {
    await ProcessSupervisor.cleanup(evidence, 100, this.probe)
  }
  async startTurn(
    turn: TurnContext & { native_session_file?: string },
    sink: PiSink
  ): Promise<ProviderRun> {
    if (!this.available) throw new Error('pi_sdk_unavailable')
    if (!isAbsolute(turn.cwd) || !/^[a-f0-9-]{36}$/.test(turn.session_id))
      throw new Error('invalid_pi_turn')
    const parent = join(this.options.stateDir, 'pi-sessions')
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    chmodSync(parent, 0o700)
    const sessionDir = join(parent, turn.session_id)
    mkdirSync(sessionDir, { mode: 0o700, recursive: true })
    if (lstatSync(sessionDir).isSymbolicLink()) throw new Error('invalid_pi_session_directory')
    chmodSync(sessionDir, 0o700)
    const root = realpathSync(sessionDir)
    if (turn.native_session_file && resolve(dirname(turn.native_session_file)) !== root)
      throw new Error('invalid_pi_session_mapping')
    const worker = spawn(
      process.execPath,
      [fileURLToPath(new URL('./worker.js', import.meta.url))],
      {
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: { ...process.env, npm_config_ignore_scripts: 'true' },
      }
    )
    const abort = new AbortController(),
      evidence = new Map<number, ProcessIdentity>(),
      answers = new Map<string, Answer>(),
      questions = new Map<string, AbortController>(),
      claims = new Set<string>()
    let result: Record<string, any> | undefined,
      reason: string | undefined,
      bytes = 0,
      cleanupConfirmed = false,
      settled = false
    let finish!: (r: { result?: Record<string, any>; reason?: string }) => void
    const done = new Promise<{ result?: Record<string, any>; reason?: string }>((r) => (finish = r))
    let finalizing: Promise<void> | undefined, stopping: Promise<void> | undefined
    const send = (m: any) => {
      if (worker.connected) worker.send(m, () => {})
    }
    const finalize = () => {
      if (finalizing) return finalizing
      finalizing = (async () => {
        clearTimeout(timer)
        abort.abort()
        try {
          if (worker.pid && !evidence.has(worker.pid) && this.probe.identity(worker.pid))
            throw new Error('worker_identity_unconfirmed')
          await this.reconcile([...evidence.values()])
          cleanupConfirmed = true
        } catch {
          cleanupConfirmed = false
        }
        if (!settled) {
          try {
            sink.event({
              type: 'pi.worker.exit',
              data: {
                cleanup_confirmed: cleanupConfirmed,
                exit_code: worker.exitCode,
                signal: worker.signalCode,
              },
            })
          } catch {
            cleanupConfirmed = false
          }
          settled = true
          finish({
            ...(result ? { result } : {}),
            ...(!cleanupConfirmed
              ? { reason: 'process_cleanup_unconfirmed' }
              : reason
                ? { reason }
                : !result
                  ? { reason: 'pi_no_terminal_result' }
                  : {}),
          })
        }
      })().finally(() => {
        finalizing = undefined
      })
      return finalizing
    }
    const interrupt = () => {
      if (settled && cleanupConfirmed) return Promise.resolve()
      if (stopping) return stopping
      stopping = (async () => {
        reason ??= 'interrupted'
        abort.abort()
        send({ kind: 'stop' })
        await Promise.race([done, delay(200)])
        await finalize()
        if (!cleanupConfirmed) throw new Error('process_cleanup_unconfirmed')
      })().finally(() => {
        stopping = undefined
      })
      return stopping
    }
    const timer = setTimeout(() => {
      reason = 'deadline'
      void interrupt().catch(() => {})
    }, this.options.deadlineMs)
    worker.on('message', (raw) => {
      void (async () => {
        const size = Buffer.byteLength(JSON.stringify(raw))
        bytes += size
        if (size > 1024 * 1024 || bytes > 16 * 1024 * 1024) throw new Error('pi_output_limit')
        const m = WorkerMessageSchema.parse(raw)
        if (m.kind === 'ready') {
          if (m.evidence.pid !== worker.pid || m.evidence.group !== worker.pid || evidence.size)
            throw new Error('invalid_worker_evidence')
          evidence.set(m.evidence.pid, m.evidence)
          sink.processes([m.evidence])
          if (abort.signal.aborted) return send({ kind: 'stop' })
          send({
            kind: 'start',
            text: turn.text,
            hostModule: this.options.hostModule,
            config: {
              cwd: turn.cwd,
              sessionDir: root,
              agentDir: this.options.agentDir,
              provider: this.options.provider,
              model: this.options.model,
              profile: this.options.profile,
              maxTokens: this.options.maxTokens,
              ...(turn.native_session_id ? { native_session_id: turn.native_session_id } : {}),
              ...(turn.native_session_file
                ? { native_session_file: turn.native_session_file }
                : {}),
            },
          })
        } else if (m.kind === 'process_claim') {
          const p = m.evidence
          if (
            abort.signal.aborted ||
            p.pid !== p.group ||
            p.pid === worker.pid ||
            p.pid === process.pid ||
            !evidence.has(worker.pid!)
          )
            throw new Error('invalid_process_claim')
          const actual = this.probe.identity(p.pid)
          if (!actual || actual.group !== p.group || actual.fingerprint !== p.fingerprint)
            throw new Error('invalid_process_claim')
          evidence.set(p.pid, p)
          sink.processes([p]) // transaction commits before the child may launch a shell
          send({ kind: 'registered', id: m.id, confirmed: true })
        } else if (m.kind === 'group_reaped') {
          const p = m.evidence,
            known = evidence.get(p.pid)
          if (
            !known ||
            known.fingerprint !== p.fingerprint ||
            known.group !== p.group ||
            p.pid !== p.group ||
            p.pid === worker.pid
          )
            throw new Error('invalid_group_release')
          // Independently verify the worker's claimed cleanup before discarding
          // recovery obligations, then commit that removal before acknowledging.
          if (this.probe.groupMembers(p).length) throw new Error('process_cleanup_unconfirmed')
          sink.reaped?.(p)
          for (const [pid, member] of evidence) if (member.group === p.group) evidence.delete(pid)
          send({ kind: 'registered', id: m.id, confirmed: true })
        } else if (m.kind === 'inventory') {
          for (const p of m.evidence) evidence.set(p.pid, p)
          sink.processes(m.evidence)
        } else if (m.kind === 'event') {
          if (m.event.type === 'pi.session.bound') {
            const file = m.event.data.native_session_file
            if (typeof file !== 'string' || resolve(dirname(file)) !== root)
              throw new Error('invalid_pi_session_mapping')
          }
          sink.event(m.event)
          send({ kind: 'ack', bytes: size })
        } else if (m.kind === 'question') {
          if (claims.has(m.id) || claims.size >= 256 || abort.signal.aborted)
            throw new Error('invalid_pi_approval')
          claims.add(m.id)
          const question = new AbortController()
          questions.set(m.id, question)
          const signal = AbortSignal.any([abort.signal, question.signal])
          const answer =
            m.action.kind && m.action.kind !== 'permission'
              ? await sink.question?.(m.action, signal)
              : await sink.permission(m.action, signal)
          if (signal.aborted) return
          if (!answer) return send({ kind: 'answer', id: m.id, choice: 'deny' })
          answers.set(m.id, answer)
          send({
            kind: 'answer',
            id: m.id,
            choice: answer.choice,
            ...('value' in answer && answer.value !== undefined ? { value: answer.value } : {}),
          })
        } else if (m.kind === 'question_cancel') {
          questions.get(m.id)?.abort()
          questions.delete(m.id)
          answers.delete(m.id)
        } else if (m.kind === 'consume') {
          const answer = answers.get(m.id),
            question = questions.get(m.id)
          answers.delete(m.id)
          questions.delete(m.id)
          const confirmed =
            !abort.signal.aborted &&
            !!question &&
            !question.signal.aborted &&
            !!answer &&
            answer.delivered() === true
          send({ kind: 'confirmed', id: m.id, confirmed })
        } else if (m.kind === 'done') {
          if (result) throw new Error('duplicate_pi_terminal_result')
          result = m.result
          reason ??= m.reason
        }
      })().catch(() => {
        reason ??= 'pi_worker_protocol_or_sink_failed'
        void interrupt().catch(() => {})
      })
    })
    worker.once('error', () => {
      reason ??= 'pi_worker_failed'
    })
    worker.once('close', (code, signal) => {
      if (code !== 0 || signal) reason ??= 'pi_worker_lost'
      void finalize()
    })
    return { done, interrupt }
  }
}
