import type {
  ProviderEventSink,
  ProviderRun,
  TurnContext,
  ProcessIdentity,
  LiveSession,
  LiveSessionContext,
  LiveSessionSettings,
  LiveSessionSink,
} from '@abele/provider-contract'
import { ProcessSupervisor, systemProcessProbe } from '@abele/provider-claude'
import { discoverCodex, requireManagedFile, type CodexExecutable } from './discovery.js'
import { realpathSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, isAbsolute, resolve } from 'node:path'
import { generateAndVerifySchemas, doctorCodex, type CodexDoctorReport } from './doctor.js'
import { startCodexTurn } from './worker.js'
import { startCodexLiveSession } from './live.js'
import type { NativeBinding } from './thread.js'
import {
  ensureCodexState,
  prepareCodexHome,
  resolveCodexHome,
  assertCodexLayout,
  type CodexHome,
} from './home.js'
import { CodexDiscoveryError } from './discovery.js'
import { codexExecutionGates, codexExecutionError, codexExecutionEvidence } from './gates.js'
import { CodexProcessInventory } from './processes.js'
import { readProcessScope } from './scope.js'
export interface CodexOptions {
  stateDir: string
  home?: string
  executable?: string
  enabled?: boolean
  model?: string
  deadlineMs?: number
  permissionTtlMs?: number
}
export class CodexProviderAdapter {
  private ready = false
  private preflightReport?: CodexDoctorReport
  get available() {
    return this.ready
  }
  /** Owner sessions keep one app-server and its thread between messages. */
  get liveAvailable() {
    return this.ready
  }
  readonly configuration: Record<string, any>
  protected executable?: CodexExecutable
  private readonly homeSelection: CodexHome
  constructor(protected options: CodexOptions) {
    this.options = { ...options, model: options.model || undefined }
    this.homeSelection = resolveCodexHome(options.home)
    const deadline = options.deadlineMs ?? 120000,
      ttl = options.permissionTtlMs ?? 60000
    if (
      !isAbsolute(options.stateDir) ||
      !Number.isSafeInteger(deadline) ||
      deadline < 1000 ||
      deadline > 1800000 ||
      !Number.isSafeInteger(ttl) ||
      ttl < 1 ||
      ttl > 3600000 ||
      (options.model && !/^[A-Za-z0-9_.:-]{1,128}$/.test(options.model))
    )
      throw new Error('invalid_codex_configuration')
    let rejectedVersion: string | undefined
    let diagnostic = 'codex_disabled'
    if (options.enabled !== false) {
      try {
        this.executable = discoverCodex({ executable: options.executable })
        diagnostic = codexExecutionError(this.executable?.version) ?? 'codex_preflight_required'
      } catch (error) {
        if (error instanceof CodexDiscoveryError) rejectedVersion = error.version
        const code = error instanceof Error ? error.message : ''
        diagnostic = /^codex_[a-z_]+$/.test(code) ? code : 'codex_executable_unavailable'
      }
    }
    this.configuration = {
      home: this.homeSelection.home,
      home_mode: this.homeSelection.mode,
      model: this.options.model || null,
      version: this.executable?.version ?? rejectedVersion ?? null,
      deadline_ms: deadline,
      permission_ttl_ms: ttl,
      diagnostic,
      accounts: ['default'],
      efforts: ['low', 'medium', 'high', 'xhigh'],
      permission_modes: ['manual'],
      approval_policy:
        'Workspace-contained operations run without prompts; only single-action answers are supported. Permission expansion and session grants are denied.',
    }
  }
  protected async inspect(): Promise<CodexDoctorReport> {
    // Each preflight pins the current launcher target, not a previous version directory.
    this.executable = discoverCodex({ executable: this.options.executable })
    this.configuration.version = this.executable.version
    this.executable.recheck()
    return doctorCodex(
      {
        stateDir: this.options.stateDir,
        executable: this.executable.executable,
        model: this.options.model,
      },
      this.homeSelection
    )
  }
  async prepare() {
    this.ready = false
    this.preflightReport = undefined
    if (this.options.enabled === false) return false
    try {
      const report = await this.inspect()
      this.preflightReport = report
      this.ready = report.available
      this.configuration.diagnostic = report.diagnostic
    } catch (error) {
      if (error instanceof CodexDiscoveryError) {
        this.executable = undefined
        this.configuration.version = error.version ?? null
      }
      const code = error instanceof Error ? error.message : ''
      this.configuration.diagnostic = /^codex_[a-z_]+$/.test(code)
        ? code
        : (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'codex_executable_unavailable'
          : 'codex_preflight_failed'
    }
    return this.available
  }
  sessionDefaults(): LiveSessionSettings {
    // The model is Codex's own selection unless the node overrides it; a thread keeps it.
    return {
      model: this.options.model ?? 'default',
      effort: 'low',
      account: 'default',
      permission_mode: 'manual',
    }
  }
  validateSettings(settings: Partial<LiveSessionSettings>) {
    const defaults = this.sessionDefaults()
    if (
      (settings.model !== undefined && settings.model !== defaults.model) ||
      (settings.effort !== undefined &&
        !['low', 'medium', 'high', 'xhigh'].includes(settings.effort)) ||
      (settings.account !== undefined && settings.account !== 'default') ||
      (settings.permission_mode !== undefined && settings.permission_mode !== 'manual')
    )
      throw new Error('codex_setting_unsupported')
  }
  configurationForTurn(_turn: unknown) {
    return this.configuration
  }
  capabilities() {
    return {
      provider: 'codex',
      provider_version: this.configuration.version ?? 'unavailable',
      available: this.available,
      diagnostic: this.configuration.diagnostic,
      home: this.configuration.home,
      home_mode: this.configuration.home_mode,
      model: this.preflightReport?.model ?? this.options.model ?? 'Codex default',
      ...(this.preflightReport?.checks ? { checks: this.preflightReport.checks } : {}),
      ...(this.preflightReport?.login_command
        ? { login_command: this.preflightReport.login_command }
        : {}),
      ...(this.preflightReport?.api_key_login_command
        ? { api_key_login_command: this.preflightReport.api_key_login_command }
        : {}),
      configuration: this.configuration,
      gates: codexExecutionGates(process.platform, this.configuration.version ?? 'unknown'),
      capabilities: {
        long_lived_sessions: this.available
          ? { status: 'supported', evidence: 'app-server-thread; turn-steer; thread-compact' }
          : { status: 'unsupported', reason: this.configuration.diagnostic },
        ...(this.available
          ? {
              steering: { status: 'supported', evidence: 'turn/steer' },
              compaction: { status: 'supported', evidence: 'thread/compact/start; token usage' },
            }
          : {}),
        execution: {
          status: this.available ? 'supported' : 'unverified',
          evidence: this.available
            ? codexExecutionEvidence(this.executable?.version ?? '')
            : undefined,
          reason: this.available
            ? undefined
            : (codexExecutionError(this.executable?.version) ?? this.configuration.diagnostic),
        },
      },
    }
  }
  async reconcile(evidence: ProcessIdentity[], directory?: string) {
    if (!directory) {
      await ProcessSupervisor.cleanup(evidence, 100, systemProcessProbe)
      return
    }
    const marker = readProcessScope(this.options.stateDir, directory)
    const inventory = new CodexProcessInventory(marker, () => {})
    inventory.add(evidence)
    await inventory.cleanup()
  }
  /** Every launch: fresh preflight, gates, layout and schema checks, then the policy paths. */
  private async launchPaths(cwd: string) {
    await this.prepare()
    requireManagedFile()
    const gateError = codexExecutionError(this.executable?.version)
    if (gateError) throw new Error(gateError)
    if (!this.available || !this.executable) throw new Error(this.configuration.diagnostic)
    const state = realpathSync(this.options.stateDir),
      workspace = realpathSync(cwd)
    if (state !== this.options.stateDir || workspace !== cwd)
      throw new Error('codex_state_workspace_overlap')
    assertCodexLayout(state, workspace)
    ensureCodexState(state)
    const home = prepareCodexHome(this.homeSelection)
    assertCodexLayout(home, workspace, false)
    const schemas = mkdtempSync(join(state, 'schema-check-'))
    try {
      generateAndVerifySchemas(this.executable, schemas)
    } finally {
      rmSync(schemas, { recursive: true, force: true })
    }
    const common = spawnSync(
      '/usr/bin/git',
      ['rev-parse', '--git-common-dir', '--absolute-git-dir'],
      {
        cwd: workspace,
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 4096,
        env: {
          PATH: '/usr/bin:/bin',
          HOME: home,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_OPTIONAL_LOCKS: '0',
        },
      }
    )
    const [commonDir, gitDir] = common.stdout.trim().split('\n')
    if (common.status !== 0 || !commonDir || !gitDir)
      throw new Error('codex_git_binding_unavailable')
    const paths = {
      home,
      isolated: this.homeSelection.mode === 'isolated',
      state,
      workspace,
      sibling: dirname(workspace),
      repository: realpathSync(resolve(workspace, commonDir)),
      gitdir: realpathSync(gitDir),
    }
    return paths
  }
  async startTurn(turn: TurnContext, sink: ProviderEventSink): Promise<ProviderRun> {
    const paths = await this.launchPaths(turn.cwd)
    return startCodexTurn(
      {
        executable: this.executable!,
        paths,
        model: this.options.model,
        deadlineMs: this.configuration.deadline_ms,
        turn,
      },
      sink
    )
  }
  async startSession(
    context: LiveSessionContext & { native_binding?: NativeBinding },
    sink: LiveSessionSink
  ): Promise<LiveSession> {
    this.validateSettings(context.settings)
    const paths = await this.launchPaths(context.cwd)
    return startCodexLiveSession(
      { executable: this.executable!, paths, model: this.options.model, context },
      sink
    )
  }
}
