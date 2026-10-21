import { ActiveDeadline } from '@abele/provider-contract'
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
import { startPiLiveSession } from './live.js'
import { nodeToolFailure } from './tool-error.js'
import type {
  LiveSession,
  LiveSessionContext,
  LiveSessionSettings,
  LiveSessionSink,
} from '@abele/provider-contract'
export { PiApprovalPolicy, PiExtensionUiBridge, PiSdkWorker, PiEventMapper } from './host.js'
export { registerDebuggerTools, registerDebuggerContext } from './debugger.js'
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
  /** Long-lived owner sessions, one SDK worker each. On by default. */
  live?: boolean
  /** Defaults for a new owner session; each session may change them. */
  sessionEffort?: string
  sessionPermissionMode?: string
  /** How long an owner session's permission question waits. */
  sessionPermissionTtlMs?: number
  /** Operator opt-in: owner sessions may run without permission questions. Off by default. */
  allowBypass?: boolean
  /** How long an owner session keeps running while no node reads it (a restart, an update). */
  detachedMs?: number
  /** Output limit per model response in owner sessions. */
  sessionMaxTokens?: number
}
export const PI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const validModel = (m: unknown): m is string =>
  typeof m === 'string' && /^[A-Za-z0-9_./:[\]-]{1,256}$/.test(m) && !m.startsWith('-')
export interface PiSink extends ProviderEventSink {
  question?(action: PiAction, signal: AbortSignal): Promise<Answer>
  reaped?(leader: ProcessIdentity): void
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))
export class PiProviderAdapter {
  readonly available: boolean
  readonly liveAvailable: boolean
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
      maxTokens: options.maxTokens ?? 32768,
      deadlineMs: options.deadlineMs ?? 1800000,
      permissionTtlMs: options.permissionTtlMs ?? 60000,
      live: options.live ?? true,
      sessionEffort: options.sessionEffort ?? 'medium',
      sessionPermissionMode: options.sessionPermissionMode ?? 'manual',
      sessionPermissionTtlMs: options.sessionPermissionTtlMs ?? 30 * 60000,
      allowBypass: options.allowBypass ?? false,
      detachedMs: options.detachedMs ?? 10 * 60000,
      sessionMaxTokens: options.sessionMaxTokens ?? 32768,
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
      o.permissionTtlMs > 3600000 ||
      !(PI_EFFORTS as readonly string[]).includes(o.sessionEffort) ||
      !this.permissionModes().includes(o.sessionPermissionMode) ||
      !Number.isSafeInteger(o.sessionPermissionTtlMs) ||
      o.sessionPermissionTtlMs < 1 ||
      o.sessionPermissionTtlMs > 24 * 3600000 ||
      !Number.isSafeInteger(o.detachedMs) ||
      o.detachedMs < 0 ||
      !Number.isSafeInteger(o.sessionMaxTokens) ||
      o.sessionMaxTokens < 64 ||
      o.sessionMaxTokens > 32768
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
    this.liveAvailable = this.available && o.live
    this.configuration = {
      per_action_approval: true,
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
      steering: this.liveAvailable
        ? 'owner sessions: taken at the next tool boundary'
        : 'unsupported; ordinary followups stay in node queue',
      live_sessions: this.liveAvailable,
      accounts: ['default'],
      session_defaults: this.sessionDefaults(),
      session_permission_ttl_ms: o.sessionPermissionTtlMs,
      session_max_tokens: o.sessionMaxTokens,
      efforts: [...PI_EFFORTS],
      permission_modes: this.permissionModes(),
    }
  }
  private permissionModes() {
    return ['manual', ...(this.options.allowBypass ? ['bypassPermissions'] : [])]
  }
  sessionDefaults(): LiveSessionSettings {
    return {
      model: 'default',
      effort: this.options.sessionEffort,
      account: 'default',
      permission_mode: this.options.sessionPermissionMode,
    }
  }
  /** Rejects a choice this node cannot launch. 'default' is the node's configured model. */
  validateSettings(settings: Partial<LiveSessionSettings>) {
    if (
      (settings.model !== undefined && !validModel(settings.model)) ||
      (settings.effort !== undefined &&
        !(PI_EFFORTS as readonly string[]).includes(settings.effort)) ||
      (settings.account !== undefined && settings.account !== 'default') ||
      (settings.permission_mode !== undefined &&
        !this.permissionModes().includes(settings.permission_mode))
    )
      throw new Error('invalid_session_settings')
  }
  /** The session's private native directory, made on first use. */
  private sessionRoot(session_id: string) {
    const parent = join(this.options.stateDir, 'pi-sessions')
    mkdirSync(parent, { recursive: true, mode: 0o700 })
    chmodSync(parent, 0o700)
    const sessionDir = join(parent, session_id)
    mkdirSync(sessionDir, { mode: 0o700, recursive: true })
    if (lstatSync(sessionDir).isSymbolicLink()) throw new Error('invalid_pi_session_directory')
    chmodSync(sessionDir, 0o700)
    return realpathSync(sessionDir)
  }
  /** One SDK worker that outlives turns and, held by a session host, the node itself. */
  async startSession(context: LiveSessionContext, sink: LiveSessionSink): Promise<LiveSession> {
    if (!this.liveAvailable) throw new Error('pi_sdk_unavailable')
    if (!isAbsolute(context.cwd) || !/^[a-f0-9-]{36}$/.test(context.session_id))
      throw new Error('invalid_pi_turn')
    this.validateSettings(context.settings)
    const root = this.sessionRoot(context.session_id)
    const file = context.native_session_file
    if (file && resolve(dirname(file)) !== root) throw new Error('invalid_pi_session_mapping')
    const o = this.options
    const model = context.settings.model === 'default' ? o.model : context.settings.model
    return startPiLiveSession(
      {
        probe: this.probe,
        hostModule: o.hostModule,
        root,
        detachedMs: o.detachedMs,
        config: {
          cwd: context.cwd,
          sessionDir: root,
          agentDir: o.agentDir,
          provider: o.provider,
          model,
          profile: o.profile,
          maxTokens: o.sessionMaxTokens,
          ...(sink.debugger?.tools.length ? { debugger_tools: sink.debugger.tools } : {}),
          ...(context.native_session_id && file
            ? { native_session_id: context.native_session_id, native_session_file: file }
            : {}),
          live: {
            effort: context.settings.effort,
            permission_mode: context.settings.permission_mode,
          },
        },
      },
      context,
      sink
    )
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
        model_catalog: supported(
          'pi.model.catalog; worker-local SDK available snapshot and provider account label'
        ),
        conversation_checkpoints: this.liveAvailable
          ? unverified(
              'chat.checkpoints; chat.preview; chat.restore; filesystem/database tests passed; live host acceptance pending'
            )
          : unsupported('Requires long-lived pi sessions'),
        extension_prompts: unverified(
          'Durable select/confirm/input/trust bridge passed fake SDK tests; real inherited extension compatibility is not yet accepted'
        ),
        compaction: this.liveAvailable
          ? unverified(
              'Owner sessions run /compact through session.compact and report compaction events; real compaction not exercised'
            )
          : unverified(
              'Retry/compaction/settled boundaries and retained journal passed fake SDK tests; real compaction not exercised'
            ),
        steering: this.liveAvailable
          ? supported('owner-sessions-sdk-steer-at-tool-boundary')
          : unsupported('No unverified steer API'),
        long_lived_sessions: this.liveAvailable
          ? supported('session-host-sdk-worker; steer; interrupt; compact; context; commands')
          : unsupported(this.available ? 'Turned off by the node' : 'SDK missing'),
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
    this.validateSettings({ permission_mode: turn.permission_mode ?? 'manual' })
    if (!this.available) throw new Error('pi_sdk_unavailable')
    if (!isAbsolute(turn.cwd) || !/^[a-f0-9-]{36}$/.test(turn.session_id))
      throw new Error('invalid_pi_turn')
    const root = this.sessionRoot(turn.session_id)
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
      claims = new Set<string>(),
      debuggerClaims = new Set<string>(),
      debuggerCalls = new Map<string, AbortController>()
    let debuggerClosed = false
    const closeDebugger = () => {
      if (debuggerClosed) return
      debuggerClosed = true
      sink.debugger?.close()
    }
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
        timer.close()
        abort.abort()
        try {
          closeDebugger()
        } catch {
          reason ??= 'debugger_settlement_failed'
        }
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
        try {
          closeDebugger()
        } catch {
          reason ??= 'debugger_settlement_failed'
        }
        send({ kind: 'stop' })
        await Promise.race([done, delay(200)])
        await finalize()
        if (!cleanupConfirmed) throw new Error('process_cleanup_unconfirmed')
      })().finally(() => {
        stopping = undefined
      })
      return stopping
    }
    const timer = new ActiveDeadline(this.options.deadlineMs, () => {
      reason = 'deadline'
      void interrupt().catch(() => {})
    })
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
              permission_mode: turn.permission_mode ?? 'manual',
              ...(sink.debugger?.tools.length ? { debugger_tools: sink.debugger.tools } : {}),
              ...(turn.native_session_id ? { native_session_id: turn.native_session_id } : {}),
              ...(turn.native_session_file
                ? { native_session_file: turn.native_session_file }
                : {}),
            },
          })
        } else if (m.kind === 'debugger_call') {
          if (
            !sink.debugger ||
            abort.signal.aborted ||
            debuggerClaims.has(m.id) ||
            debuggerClaims.size >= 256 ||
            debuggerCalls.size >= 64
          )
            throw new Error('invalid_debugger_call')
          debuggerClaims.add(m.id)
          const call = new AbortController()
          debuggerCalls.set(m.id, call)
          const signal = AbortSignal.any([abort.signal, call.signal])
          const resumeDeadline = m.name.startsWith('obsidian_') ? timer.pause() : () => {}
          try {
            const result = await (m.name.startsWith('obsidian_')
              ? sink.debugger.call(m.name, m.args, signal, 'pi:' + m.id)
              : sink.debugger.call(m.name, m.args, signal))
            if (!signal.aborted)
              send({
                kind: 'debugger_result',
                id: m.id,
                result: sink.debugger.publish(m.args, result),
              })
          } catch (error) {
            if (!signal.aborted)
              send({ kind: 'debugger_result', id: m.id, result: nodeToolFailure(m.name, error) })
          } finally {
            resumeDeadline()
            debuggerCalls.delete(m.id)
          }
        } else if (m.kind === 'debugger_cancel') {
          debuggerCalls.get(m.id)?.abort()
          debuggerCalls.delete(m.id)
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
          const resumeDeadline = timer.pause()
          let answer: Answer | undefined
          try {
            answer =
              m.action.kind && m.action.kind !== 'permission'
                ? await sink.question?.(m.action, signal)
                : await sink.permission(m.action, signal)
          } finally {
            resumeDeadline()
          }
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
