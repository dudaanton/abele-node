import type {
  ProviderEventSink,
  ProviderRun,
  TurnContext,
  ProcessIdentity,
} from '@abele/provider-contract'
import { ProcessSupervisor, systemProcessProbe } from '@abele/provider-claude'
import { discoverCodex, requireManagedFile, type CodexExecutable } from './discovery.js'
import { realpathSync, mkdtempSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, isAbsolute, resolve } from 'node:path'
import { generateAndVerifySchemas, doctorCodex, type CodexDoctorReport } from './doctor.js'
import { startCodexTurn } from './worker.js'
import {
  ensureCodexState,
  prepareCodexHome,
  resolveCodexHome,
  assertCodexLayout,
  type CodexHome,
} from './home.js'
import { codexExecutionGates, codexExecutionError } from './gates.js'
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
  get available() {
    return this.ready
  }
  readonly configuration: Record<string, any>
  protected executable?: CodexExecutable
  private readonly homeSelection: CodexHome
  constructor(protected options: CodexOptions) {
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
    let diagnostic = 'Not configured; select an executable and model, then run doctor preflight.'
    if (options.enabled || options.executable) {
      try {
        this.executable = discoverCodex({ executable: options.executable })
        diagnostic =
          codexExecutionError() ??
          'Pinned executable found; authentication and model checks required.'
      } catch {
        diagnostic = 'Pinned executable unavailable or incompatible'
      }
    }
    this.configuration = {
      home: this.homeSelection.home,
      home_mode: this.homeSelection.mode,
      model: options.model ?? null,
      version: this.executable?.version ?? null,
      deadline_ms: deadline,
      permission_ttl_ms: ttl,
      diagnostic,
      approval_policy:
        'Workspace-contained operations run without prompts; only single-action answers are supported. Permission expansion and session grants are denied.',
    }
  }
  protected async inspect(): Promise<CodexDoctorReport> {
    if (!this.executable)
      return { provider: 'codex', available: false, diagnostic: 'codex_executable_unavailable' }
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
    try {
      const report = await this.inspect()
      this.ready = report.available
      this.configuration.diagnostic = report.diagnostic
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      this.configuration.diagnostic = /^codex_[a-z_]+$/.test(code) ? code : 'codex_preflight_failed'
    }
    return this.available
  }
  configurationForTurn(_turn: unknown) {
    return this.configuration
  }
  capabilities() {
    return {
      provider: 'codex',
      provider_version: this.executable?.version ?? 'unavailable',
      available: this.available,
      diagnostic: this.configuration.diagnostic,
      home: this.configuration.home,
      home_mode: this.configuration.home_mode,
      configuration: this.configuration,
      gates: codexExecutionGates(),
      capabilities: {
        execution: {
          status: this.available ? 'supported' : 'unverified',
          evidence: this.available
            ? '0.160.1-native-replay-sampled-descendants-marker-sweep'
            : undefined,
          reason: this.available
            ? undefined
            : (codexExecutionError() ?? this.configuration.diagnostic),
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
  async startTurn(turn: TurnContext, sink: ProviderEventSink): Promise<ProviderRun> {
    await this.prepare()
    requireManagedFile()
    const gateError = codexExecutionError()
    if (gateError) throw new Error(gateError)
    if (!this.available || !this.executable) throw new Error(this.configuration.diagnostic)
    const state = realpathSync(this.options.stateDir),
      workspace = realpathSync(turn.cwd)
    if (state !== this.options.stateDir || workspace !== turn.cwd)
      throw new Error('codex_state_workspace_overlap')
    assertCodexLayout(state, workspace)
    ensureCodexState(state)
    const home = prepareCodexHome(this.homeSelection)
    assertCodexLayout(home, workspace, false)
    if (!this.options.model) throw new Error('codex_selected_model_required')
    const schemas = mkdtempSync(join(state, 'schema-check-'))
    try {
      generateAndVerifySchemas(this.executable, schemas)
    } finally {
      rmSync(schemas, { recursive: true, force: true })
    }
    const common = spawnSync('/usr/bin/git', ['rev-parse', '--git-common-dir'], {
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
    })
    if (common.status !== 0) throw new Error('codex_git_binding_unavailable')
    const paths = {
      home,
      isolated: this.homeSelection.mode === 'isolated',
      state,
      workspace,
      sibling: dirname(workspace),
      repository: realpathSync(resolve(workspace, common.stdout.trim())),
    }
    return startCodexTurn(
      {
        executable: this.executable,
        paths,
        model: this.options.model,
        deadlineMs: this.configuration.deadline_ms,
        turn,
      },
      sink
    )
  }
}
