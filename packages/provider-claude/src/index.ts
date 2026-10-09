import { spawn, spawnSync } from 'node:child_process'
import { createServer, type Socket } from 'node:net'
import { chmodSync, writeFileSync, realpathSync } from 'node:fs'
import { createRunIpc, cleanupRunIpc } from './ipc.js'
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { ClaudeStreamDecoder, ClaudeEventMapper, type ClaudeEvent } from './stream.js'
import {
  ProcessSupervisor,
  systemProcessProbe,
  type ProcessIdentity,
  type ProcessProbe,
} from './supervisor.js'
export { ClaudeStreamDecoder, ClaudeEventMapper, ProcessSupervisor }
export type { ProcessIdentity, ProcessProbe, ClaudeEvent }
export { systemProcessProbe, descendants } from './supervisor.js'
export interface ClaudeOptions {
  executable?: string
  profile?: 'inherited' | 'isolated'
  model?: string
  budgetUsd?: number
  deadlineMs?: number
  permissionTtlMs?: number
  processProbe?: ProcessProbe
}
export interface PermissionAction {
  tool_use_id: string
  tool_name: string
  input: Record<string, unknown>
}
export interface TurnContext {
  session_id: string
  run_id: string
  cwd: string
  text: string
  native_session_id?: string
  use_repository_claude_permissions?: boolean
}
export interface ProviderEventSink {
  event(event: ClaudeEvent): void
  processes(evidence: ProcessIdentity[]): void
  ipc?(directory: string): void
  permission(
    action: PermissionAction,
    signal: AbortSignal
  ): Promise<{ choice: 'allow' | 'deny'; delivered(): boolean | void }>
}
export interface ProviderRun {
  done: Promise<{ result?: Record<string, any>; reason?: string }>
  interrupt(): Promise<void>
}
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
export class ClaudeProviderAdapter {
  readonly executable: string
  readonly version: string
  readonly available: boolean
  readonly diagnostic: string
  readonly configuration: Record<string, unknown>
  private options: Required<Omit<ClaudeOptions, 'executable' | 'processProbe'>>
  private probe: ProcessProbe
  constructor(options: ClaudeOptions = {}) {
    this.probe = options.processProbe ?? systemProcessProbe
    const requestedExecutable =
      options.executable ?? process.env.ABELE_CLAUDE_PATH ?? join(homedir(), '.local/bin/claude')
    if (!isAbsolute(requestedExecutable)) throw new Error('invalid_claude_configuration')
    // Do not let an auto-updating global symlink switch binaries between compatibility check and launch.
    let executable = requestedExecutable
    try {
      executable = realpathSync(requestedExecutable)
    } catch {}
    this.executable = executable
    this.options = {
      profile: options.profile ?? 'inherited',
      model: options.model ?? 'haiku',
      budgetUsd: options.budgetUsd ?? 0.35,
      deadlineMs: options.deadlineMs ?? 120000,
      permissionTtlMs: options.permissionTtlMs ?? 60000,
    }
    if (
      !isAbsolute(this.executable) ||
      !['inherited', 'isolated'].includes(this.options.profile) ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(this.options.model) ||
      this.options.model.startsWith('-') ||
      !Number.isFinite(this.options.budgetUsd) ||
      this.options.budgetUsd <= 0 ||
      this.options.budgetUsd > 10 ||
      !Number.isSafeInteger(this.options.deadlineMs) ||
      this.options.deadlineMs < 1000 ||
      this.options.deadlineMs > 1800000 ||
      !Number.isSafeInteger(this.options.permissionTtlMs) ||
      this.options.permissionTtlMs < 1 ||
      this.options.permissionTtlMs > 3600000
    )
      throw new Error('invalid_claude_configuration')
    const v = spawnSync(this.executable, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      maxBuffer: 65536,
    })
    this.version = v.stdout?.trim().split(' ')[0] ?? 'unavailable'
    const help = spawnSync(
      this.executable,
      [
        '--permission-prompts',
        'host',
        '--permission-prompt-tool',
        'mcp__abele_approval__permission',
        '--help',
      ],
      { encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024 }
    )
    const parsed = /^(\d+)\.(\d+)\.(\d+)$/.exec(this.version)
    const parts = parsed
      ? ([Number(parsed[1]), Number(parsed[2]), Number(parsed[3])] as const)
      : undefined
    const missingFlag = [
      '--include-partial-messages',
      '--forward-subagent-text',
      '--resume',
      '--setting-sources',
      '--max-budget-usd',
    ].find((f) => !new RegExp(`(?:^|[\\s,])${f}(?=[\\s,=]|$)`).test(help.stdout ?? ''))
    const detail = (result: typeof v) =>
      (
        result.error?.message ||
        result.stderr?.trim() ||
        `exit ${result.status}, signal ${result.signal}`
      )
        .replace(/\s+/g, ' ')
        .slice(0, 500)
    const failure =
      v.error && (v.error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `not found at path ${requestedExecutable}`
        : v.status !== 0
          ? `--version failed with ${detail(v)}`
          : !parts || !parts.every(Number.isSafeInteger)
            ? `unparsable version ${this.version}`
            : parts[0] < 2 ||
                (parts[0] === 2 && (parts[1] < 1 || (parts[1] === 1 && parts[2] < 285)))
              ? `version ${this.version} below minimum 2.1.285`
              : parts[0] >= 3
                ? `version ${this.version} outside supported range >=2.1.285 <3.0.0`
                : help.status !== 0
                  ? `--help failed with ${detail(help)} (permission prompt flags must be accepted)`
                  : missingFlag
                    ? `missing flag ${missingFlag}`
                    : undefined
    this.available = failure === undefined
    const repair =
      parts && parts[0] >= 3
        ? 'npm install -g @anthropic-ai/claude-code@2, then '
        : v.error && (v.error as NodeJS.ErrnoException).code === 'ENOENT'
          ? ''
          : 'claude update, then '
    this.diagnostic = this.available
      ? ['2.1.285', '2.1.291'].includes(this.version)
        ? 'Version/public flags checked; real permission/resume evidence is version-specific (2.1.285, 2.1.291); installed customizations may affect behavior'
        : `Claude ${this.version}: untested version, flags detected; real permission/resume acceptance not recorded`
      : `Claude unavailable/incompatible: ${failure}. Run ${repair}sh install.sh --claude-path /absolute/path/to/claude; restart the node and run abele-node doctor. Real acceptance: scripts/acceptance-stage3.mjs.`
    this.configuration = {
      executable: this.executable,
      requested_executable: requestedExecutable,
      version: this.version,
      profile: this.options.profile,
      settings_sources: this.options.profile === 'isolated' ? [] : ['user'],
      repository_settings_default: 'ignored; owner opt-in is recorded on the project',
      permission_mode_requested: 'manual',
      effective_configuration_source:
        'Each claude.init record (artifact-backed if large); the CLI may normalize mode names and apply managed settings',
      permission_bridge: 'abele-approval-v1',
      inherited_allow_rules_may_skip_bridge: this.options.profile === 'inherited',
      hooks_skills_mcp:
        this.options.profile === 'inherited'
          ? 'User settings apply; repository/local settings require project opt-in. Other CLI resources and managed settings may apply; init journals reported tools/configuration. Auto-allowed actions are not node approvals.'
          : 'User/project/local setting sources empty; strict MCP configuration; slash commands disabled; disableAllHooks requested. Managed settings may still apply; real tests require witnessed node prompts.',
      base_environment: {
        path: process.env.PATH ?? null,
        home: homedir(),
        other_environment: 'Inherited by CLI, not enumerated or stored',
      },
      model: this.options.model,
      max_budget_usd: this.options.budgetUsd,
      deadline_ms: this.options.deadlineMs,
      permission_ttl_ms: this.options.permissionTtlMs,
    }
  }
  configurationForTurn(turn: Pick<TurnContext, 'use_repository_claude_permissions'>) {
    const sources =
      this.options.profile === 'isolated'
        ? []
        : turn.use_repository_claude_permissions
          ? ['user', 'project', 'local']
          : ['user']
    return {
      ...this.configuration,
      settings_sources: sources,
      use_repository_claude_permissions: turn.use_repository_claude_permissions === true,
    }
  }
  capabilities() {
    return {
      provider: 'claude',
      provider_version: this.version,
      available: this.available,
      diagnostic: this.diagnostic,
      configuration: this.configuration,
      capabilities: {
        execution: {
          status: this.available ? 'supported' : 'unsupported',
          evidence: 'bounded-cli-v1',
          reason: this.diagnostic,
        },
        streaming: { status: 'supported', evidence: 'partial-final-replacement-v1' },
        permissions:
          this.available && ['2.1.285', '2.1.291'].includes(this.version)
            ? {
                status: 'supported',
                evidence: 'real-2.1.291-node-client-allow-deny-expiry; stage0-2.1.285',
              }
            : {
                status: 'unverified',
                reason: this.diagnostic,
              },
        resume:
          this.available && ['2.1.285', '2.1.291'].includes(this.version)
            ? {
                status: 'supported',
                evidence: 'real-2.1.291-queued-restart-interrupted-resume; stage0-2.1.285',
              }
            : {
                status: 'unverified',
                reason: this.diagnostic,
              },
        queued_followups: { status: 'supported', evidence: 'one-input-per-invocation' },
        foreground_child_text:
          this.available && this.version === '2.1.285'
            ? { status: 'supported', evidence: 'stage0-forward-subagent-text' }
            : {
                status: 'unverified',
                reason:
                  this.available && this.version === '2.1.291'
                    ? 'Flag accepted; real child inference not exercised on 2.1.291'
                    : this.diagnostic,
              },
        readable_thinking: { status: 'unverified', reason: 'Empty blocks are withheld_or_empty' },
        exhaustive_children: {
          status: 'unverified',
          reason: 'Nested/background history not guaranteed',
        },
        ask_user_question: {
          status: 'unsupported',
          reason: 'No question-response bridge; denied explicitly',
        },
        steering: { status: 'unsupported', reason: 'Serialized followups only' },
        compaction: { status: 'unverified', reason: 'Raw records retained; no control API' },
      },
    }
  }
  async reconcile(evidence: ProcessIdentity[], ipcDirectory?: string) {
    await ProcessSupervisor.cleanup(evidence, 500, this.probe)
    if (ipcDirectory) cleanupRunIpc(ipcDirectory)
  }
  async startTurn(turn: TurnContext, sink: ProviderEventSink): Promise<ProviderRun> {
    if (!this.available) throw new Error(this.diagnostic)
    const dir = createRunIpc()
    try {
      sink.ipc?.(dir)
    } catch (error) {
      cleanupRunIpc(dir)
      throw error
    }
    const socketPath = join(dir, 'p.sock'),
      configPath = join(dir, 'mcp.json')
    const configuration = this.configurationForTurn(turn)
    const settingsSources = configuration.settings_sources
    const token = randomBytes(32).toString('hex'),
      generation = randomUUID()
    const abort = new AbortController(),
      sockets = new Set<Socket>(),
      calls = new Map<string, PermissionAction>(),
      permissionClaims = new Set<string>()
    const server = createServer((socket) => {
      if (sockets.size >= 8 || abort.signal.aborted) {
        socket.destroy()
        return
      }
      sockets.add(socket)
      let pending = Buffer.alloc(0),
        requested = false
      let delivered: (() => boolean | void) | undefined
      let consumed = false
      socket.on('error', () => {})
      socket.on('close', () => sockets.delete(socket))
      socket.setTimeout(this.options.permissionTtlMs + 3000, () => socket.destroy())
      socket.on('data', (data) => {
        pending = Buffer.concat([pending, data])
        if (pending.length > 256 * 1024) {
          socket.destroy()
          return
        }
        const nl = pending.indexOf(10)
        if (nl < 0) return
        const line = pending.subarray(0, nl)
        pending = pending.subarray(nl + 1)
        if (requested) {
          try {
            if (consumed || JSON.parse(line.toString()).delivered !== true || !delivered) {
              socket.destroy()
              return
            }
            consumed = true
            if (delivered() === false) {
              socket.end(JSON.stringify({ confirmed: false }) + '\n')
              return
            }
            socket.end(JSON.stringify({ confirmed: true }) + '\n')
          } catch (error) {
            socket.destroy()
            reason = error instanceof Error ? error.message : 'approval_delivery_failed'
            void interrupt().catch(() => {})
          }
          return
        }
        requested = true
        void (async () => {
          let p: any
          try {
            p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))
          } catch {
            socket.destroy()
            return
          }
          if (
            p.version !== 1 ||
            typeof p.token !== 'string' ||
            p.token.length !== token.length ||
            !timingSafeEqual(Buffer.from(p.token), Buffer.from(token)) ||
            p.session_id !== turn.session_id ||
            p.run_id !== turn.run_id ||
            p.generation !== generation
          ) {
            socket.destroy()
            return
          }
          const args = p.args
          if (
            !args ||
            typeof args.tool_use_id !== 'string' ||
            typeof args.tool_name !== 'string' ||
            !args.input ||
            typeof args.input !== 'object' ||
            Array.isArray(args.input)
          ) {
            socket.destroy()
            return
          }
          // stdout and MCP are independent pipes. Allow their bounded correlation race, never invent a call.
          for (
            let i = 0;
            i < 100 && !calls.has(args.tool_use_id) && !abort.signal.aborted && !socket.destroyed;
            i++
          )
            await delay(20)
          const original = calls.get(args.tool_use_id)
          if (
            !original ||
            original.tool_name !== args.tool_name ||
            canonical(original.input) !== canonical(args.input) ||
            abort.signal.aborted ||
            socket.destroyed
          ) {
            socket.end(
              JSON.stringify({ behavior: 'deny', message: 'Invalid tool correlation' }) + '\n'
            )
            return
          }
          if (permissionClaims.has(original.tool_use_id)) {
            sink.event({
              type: 'claude.permission.duplicate',
              data: { tool_use_id: original.tool_use_id, decision: 'deny' },
            })
            socket.end(
              JSON.stringify({
                behavior: 'deny',
                message: 'Approval already reserved or consumed',
              }) + '\n'
            )
            return
          }
          // Claim before awaiting the human answer: concurrent connections cannot both grant.
          permissionClaims.add(original.tool_use_id)
          const loss = new AbortController()
          const lost = () => loss.abort()
          socket.once('close', lost)
          abort.signal.addEventListener('abort', lost, { once: true })
          try {
            const answer =
              original.tool_name === 'AskUserQuestion'
                ? { choice: 'deny' as const, delivered() {} }
                : await sink.permission(original, loss.signal)
            if (loss.signal.aborted) {
              socket.destroy()
              return
            }
            delivered = answer.delivered
            socket.write(
              JSON.stringify(
                answer.choice === 'allow'
                  ? { behavior: 'allow', updatedInput: original.input }
                  : {
                      behavior: 'deny',
                      message:
                        original.tool_name === 'AskUserQuestion'
                          ? 'AskUserQuestion is unsupported by this node'
                          : 'Node denied or expired this exact action',
                    }
              ) + '\n'
            )
          } catch {
            socket.destroy()
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
    } catch (error) {
      cleanupRunIpc(dir)
      throw error
    }
    try {
      chmodSync(socketPath, 0o600)
      writeFileSync(
        configPath,
        JSON.stringify({
          mcpServers: {
            abele_approval: {
              command: process.execPath,
              args: [fileURLToPath(new URL('./bridge.js', import.meta.url))],
              env: {
                ABELE_APPROVAL_SOCKET: socketPath,
                ABELE_APPROVAL_TOKEN: token,
                ABELE_SESSION_ID: turn.session_id,
                ABELE_RUN_ID: turn.run_id,
                ABELE_GENERATION: generation,
                ABELE_APPROVAL_TTL: String(this.options.permissionTtlMs),
              },
            },
          },
        }),
        { mode: 0o600 }
      )
    } catch (error) {
      abort.abort()
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      cleanupRunIpc(dir)
      throw error
    }
    const args = [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--forward-subagent-text',
      '--model',
      this.options.model,
      '--effort',
      'low',
      '--max-budget-usd',
      String(this.options.budgetUsd),
      '--permission-mode',
      'manual',
      '--permission-prompts',
      'host',
      '--permission-prompt-tool',
      'mcp__abele_approval__permission',
      '--mcp-config',
      configPath,
    ]
    args.push('--setting-sources', settingsSources.join(','))
    if (this.options.profile === 'isolated')
      args.push(
        '--strict-mcp-config',
        '--disable-slash-commands',
        '--settings',
        JSON.stringify({ disableAllHooks: true })
      )
    if (turn.native_session_id) args.push('--resume', turn.native_session_id)
    args.push('--')
    const worker = spawn(
      process.execPath,
      [fileURLToPath(new URL('./worker.js', import.meta.url))],
      { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
    )
    const decoder = new ClaudeStreamDecoder(),
      mapper = new ClaudeEventMapper()
    let terminal: Record<string, any> | undefined,
      reason: string | undefined,
      outputBytes = 0
    const processEvidence = new Map<number, ProcessIdentity>()
    const persistProcesses = (evidence: ProcessIdentity[]) => {
      if (
        !evidence.every(
          (p) =>
            Number.isSafeInteger(p.pid) &&
            p.pid > 1 &&
            typeof p.fingerprint === 'string' &&
            Number.isSafeInteger(p.group) &&
            p.group > 1
        )
      )
        throw new Error('invalid_worker_evidence')
      for (const p of evidence) processEvidence.set(p.pid, p)
      sink.processes(evidence)
    }
    let stopping: Promise<void> | undefined
    let resolveDone!: (value: { result?: Record<string, any>; reason?: string }) => void
    const done = new Promise<{ result?: Record<string, any>; reason?: string }>((resolve) => {
      resolveDone = resolve
    })
    let cleanupConfirmed = false
    let settled = false
    let finalizing: Promise<void> | undefined
    let serverClosed: Promise<void> | undefined
    const finalize = (code: number | null, signal: string | null) => {
      if (finalizing) return finalizing
      finalizing = (async () => {
        clearTimeout(timer)
        abort.abort()
        for (const socket of sockets) socket.destroy()
        serverClosed ??= new Promise<void>((resolve) => server.close(() => resolve()))
        await serverClosed
        try {
          if (worker.pid && !processEvidence.has(worker.pid) && this.probe.identity(worker.pid))
            throw new Error('worker_identity_unconfirmed')
          await ProcessSupervisor.cleanup([...processEvidence.values()], 500, this.probe)
          cleanupConfirmed = true
          cleanupRunIpc(dir)
        } catch {
          cleanupConfirmed = false
        }
        const outcomeReason = cleanupConfirmed
          ? (reason ?? (!terminal ? 'no_terminal_result' : undefined))
          : 'process_cleanup_unconfirmed'
        if (!settled) {
          try {
            sink.event({
              type: 'claude.worker.exit',
              data: { exit_code: code, signal, cleanup_confirmed: cleanupConfirmed },
            })
          } catch {
            cleanupConfirmed = false
          }
          settled = true
          resolveDone({
            ...(terminal ? { result: terminal } : {}),
            ...(cleanupConfirmed
              ? outcomeReason
                ? { reason: outcomeReason }
                : {}
              : { reason: 'process_cleanup_unconfirmed' }),
          })
        }
      })().finally(() => {
        finalizing = undefined
      })
      return finalizing
    }
    const interrupt = () => {
      if (cleanupConfirmed && settled) return Promise.resolve()
      if (stopping) return stopping
      stopping = (async () => {
        reason ??= 'interrupted'
        abort.abort()
        if (worker.connected) worker.send({ kind: 'stop' }, () => {})
        // A stopped/unresponsive worker cannot own escalation. The daemon always cleans
        // the durable group, even if no close event is ever received.
        await Promise.race([done, delay(500)])
        await finalize(worker.exitCode, worker.signalCode)
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
    worker.on('message', (m: any) => {
      try {
        if (m?.kind === 'ready' && m.evidence) {
          persistProcesses([m.evidence])
          if (abort.signal.aborted) worker.send({ kind: 'stop' }, () => {})
          else worker.send({ kind: 'start', executable: this.executable, cwd: turn.cwd, args })
        } else if (m?.kind === 'spawned' && m.evidence) {
          persistProcesses([m.evidence])
          if (abort.signal.aborted) worker.send({ kind: 'stop' }, () => {})
          else worker.send({ kind: 'deliver', text: turn.text })
        } else if (m?.kind === 'inventory' && Array.isArray(m.evidence))
          persistProcesses(m.evidence)
        else if (
          (m?.kind === 'stdout' || m?.kind === 'stderr') &&
          typeof m.base64 === 'string' &&
          m.base64.length <= 128 * 1024
        ) {
          const bytes = Buffer.from(m.base64, 'base64')
          outputBytes += bytes.length
          if (outputBytes > 16 * 1024 * 1024) throw new Error('claude_output_limit')
          sink.event({ type: 'claude.raw', data: { channel: m.kind, base64: m.base64 } })
          if (m.kind === 'stdout') {
            for (const r of decoder.push(bytes)) {
              if (r.type === 'result') {
                if (terminal) throw new Error('duplicate_terminal_result')
                terminal = r
                if (
                  typeof r.subtype !== 'string' ||
                  (r.is_error !== undefined && typeof r.is_error !== 'boolean')
                )
                  reason = 'invalid_terminal_result'
              }
              for (const event of mapper.map(r)) {
                if (event.type === 'claude.tool.call') {
                  const d = event.data
                  if (
                    typeof d.tool_use_id === 'string' &&
                    typeof d.name === 'string' &&
                    d.input &&
                    typeof d.input === 'object'
                  ) {
                    const call = {
                      tool_use_id: d.tool_use_id,
                      tool_name: d.name,
                      input: d.input as Record<string, unknown>,
                    }
                    const previous = calls.get(d.tool_use_id)
                    if (previous && canonical(previous) !== canonical(call))
                      throw new Error('tool_call_identity_changed')
                    calls.set(d.tool_use_id, call)
                    if (d.name === 'AskUserQuestion')
                      sink.event({
                        type: 'claude.unsupported_tool',
                        data: {
                          tool_name: d.name,
                          tool_use_id: d.tool_use_id,
                          parent_tool_use_id: d.parent_tool_use_id,
                          reason: 'Question-response bridge unsupported',
                        },
                      })
                  }
                }
                if (
                  event.type === 'claude.tool.result' &&
                  event.data.is_error === false &&
                  typeof event.data.tool_use_id === 'string' &&
                  !permissionClaims.has(event.data.tool_use_id)
                ) {
                  sink.event({
                    type: 'claude.tool.authorization',
                    data: {
                      tool_use_id: event.data.tool_use_id,
                      parent_tool_use_id: event.data.parent_tool_use_id,
                      authorization: 'claude_settings',
                      label: 'Allowed by your Claude settings',
                      settings_sources: settingsSources,
                      evidence: 'successful_tool_result_without_node_prompt',
                      matched_rule: 'not_exposed_by_cli',
                    },
                  })
                }
                sink.event(event)
              }
            }
            // The worker can finish and close IPC while the final stdout record is
            // being committed. A failed flow-control ack is not a failed run;
            // the worker close event still decides whether it exited cleanly.
            if (worker.connected) worker.send({ kind: 'output_ack' }, () => {})
          }
        } else if (m?.kind === 'exit') {
          sink.event({
            type: 'claude.process.exit',
            data: { exit_code: m.code, signal: m.signal ?? null, reason: m.reason ?? null },
          })
          if (
            m.code !== 0 &&
            terminal?.is_error !== true &&
            !(typeof terminal?.subtype === 'string' && terminal.subtype !== 'success')
          )
            reason ??= m.reason ?? 'nonzero_exit'
          try {
            decoder.end()
          } catch {
            reason ??= 'truncated_output'
          }
        }
      } catch (error) {
        reason = error instanceof Error ? error.message : 'sink_failure'
        void interrupt().catch(() => {})
      }
    })
    worker.on('error', () => {
      reason ??= 'worker_failed'
    })
    worker.once('close', (code, signal) => {
      if (code !== 0 || signal) reason ??= 'worker_lost'
      void finalize(code, signal).catch(() => {
        if (!settled) {
          settled = true
          resolveDone({ reason: 'process_cleanup_unconfirmed' })
        }
      })
    })
    return { done, interrupt }
  }
}
