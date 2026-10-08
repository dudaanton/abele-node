// SDK assembly has an injected facade so automation never imports the real SDK.
import type * as PiSdk from '@earendil-works/pi-coding-agent'
import { lstatSync, chmodSync, existsSync, realpathSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { materializeNativeState } from './native-state.js'
import { randomUUID } from 'node:crypto'
import type { HostProcessHooks } from './processes.js'
import {
  PiSdkWorker,
  PiApprovalPolicy,
  PiExtensionUiBridge,
  type Ask,
  type PiEvent,
} from './host.js'
export interface HostConfiguration {
  cwd: string
  sessionDir: string
  native_session_id?: string
  native_session_file?: string
  agentDir: string
  provider: string
  model: string
  profile: 'inherited' | 'isolated'
  maxTokens: number
}
export async function createSdkHost(
  sdk: typeof PiSdk,
  config: HostConfiguration,
  ask: Ask,
  signal: AbortSignal,
  emit: (event: PiEvent) => void,
  hooks?: HostProcessHooks
) {
  const {
    ModelRuntime,
    SettingsManager,
    SessionManager,
    createAgentSessionRuntime,
    createAgentSessionServices,
    createAgentSessionFromServices,
  } = sdk
  const cwd = realpathSync(config.cwd)
  const root = realpathSync(config.sessionDir)
  const checkFile = (file: string) => {
    if (resolve(dirname(file)) !== root || (existsSync(file) && lstatSync(file).isSymbolicLink()))
      throw new Error('invalid_pi_session_file')
  }
  let manager: PiSdk.SessionManager
  if (config.native_session_file) {
    checkFile(config.native_session_file)
    if (!existsSync(config.native_session_file)) throw new Error('pi_native_context_missing')
    manager = SessionManager.open(config.native_session_file, root, cwd)
    if (manager.getSessionId() !== config.native_session_id || manager.getCwd() !== cwd)
      throw new Error('pi_native_context_mismatch')
  } else manager = SessionManager.create(cwd, root)
  const modelRuntime = await ModelRuntime.create({
    authPath: join(config.agentDir, 'auth.json'),
    modelsPath: join(config.agentDir, 'models.json'),
    modelsStorePath: join(config.agentDir, 'models-store.json'),
    allowModelNetwork: false,
    signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
  })
  const policy = new PiApprovalPolicy(ask, signal)
  const ui = new PiExtensionUiBridge(ask, signal, emit)
  const factory: PiSdk.CreateAgentSessionRuntimeFactory = async ({
    cwd: effectiveCwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    if (realpathSync(effectiveCwd) !== cwd) throw new Error('pi_workspace_replacement_refused')
    const settingsManager =
      config.profile === 'isolated'
        ? SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } })
        : SettingsManager.create(cwd, config.agentDir)
    settingsManager.setProjectTrusted(true)
    const operations: PiSdk.BashOperations = hooks
      ? hooks.bashOperations(settingsManager.getShellPath?.())
      : {
          exec: async () => {
            throw new Error('pi_process_supervisor_required')
          },
        }
    const services = await createAgentSessionServices({
      cwd,
      agentDir: config.agentDir,
      modelRuntime,
      settingsManager,
      resourceLoaderReloadOptions: { resolveProjectTrust: async () => true },
      resourceLoaderOptions: {
        ...(config.profile === 'isolated'
          ? {
              noExtensions: true,
              noSkills: true,
              noPromptTemplates: true,
              noThemes: true,
              noContextFiles: true,
              // These sources are discovered independently of noContextFiles.
              // Explicit empty sources prevent reads (including symlinks);
              // post-load overrides alone would be too late.
              systemPrompt: '',
              appendSystemPrompt: [],
              systemPromptOverride: () => undefined,
            }
          : {}),
        extensionFactories: [
          {
            name: 'abele-node-policy',
            factory: (pi) => {
              // Last-loaded node policy replaces the SDK's detached-shell backend
              // with an anchored, durably registered process group. SDK rendering,
              // truncation, environment and configured prefix stay SDK-owned.
              pi.registerTool(
                sdk.createBashToolDefinition(cwd, {
                  operations,
                  commandPrefix: settingsManager.getShellCommandPrefix?.(),
                })
              )
              pi.on('user_bash', async (event, ctx) => {
                const blocked = await policy.intercept(
                  {
                    tool_use_id: randomUUID(),
                    tool_name: 'bash',
                    input: { command: event.command },
                    native_session_id: ctx.sessionManager.getSessionId(),
                  },
                  ctx.signal
                )
                return blocked
                  ? {
                      result: {
                        output: blocked.reason,
                        exitCode: 1,
                        cancelled: false,
                        truncated: false,
                      },
                    }
                  : { operations }
              })
              pi.on('tool_call', (event, ctx) =>
                policy.intercept(
                  {
                    tool_use_id: event.toolCallId,
                    tool_name: event.toolName,
                    input: event.input,
                    native_session_id: ctx.sessionManager.getSessionId(),
                  },
                  ctx.signal
                )
              )
              pi.on('project_trust', async (event) => ({
                trusted: realpathSync(event.cwd) === cwd ? 'yes' : 'no',
                remember: false,
              }))
            },
          },
        ],
      },
    })
    // Model selection may inherit the user's SDK configuration, but never a
    // repository setting. Resource isolation and model/auth selection are separate.
    const defaults =
      config.provider && config.model
        ? undefined
        : SettingsManager.create(cwd, config.agentDir, { projectTrusted: false })
    const provider = config.provider || defaults?.getDefaultProvider()
    const modelId = config.model || defaults?.getDefaultModel()
    if (!provider || !modelId) throw new Error('pi_model_configuration_required')
    const model = modelRuntime.getModel(provider, modelId)
    if (!model) throw new Error('pi_model_unavailable')
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        model: { ...model, maxTokens: Math.min(model.maxTokens, config.maxTokens) },
        thinkingLevel: 'off',
      })),
      services,
      diagnostics: services.diagnostics,
    }
  }
  const runtime = await createAgentSessionRuntime(factory, {
    cwd,
    agentDir: config.agentDir,
    sessionManager: manager,
  })
  const worker = new PiSdkWorker(
    runtime,
    (event) => {
      if (event.type === 'pi.session.bound') {
        checkFile(String(event.data.native_session_file))
        materializeNativeState(runtime.session.sessionManager)
      }
      emit(event)
    },
    () => ({
      mode: 'rpc',
      uiContext: ui.context as PiSdk.ExtensionUIContext,
      abortHandler: () => {
        void runtime.session.abort()
      },
      onError: () =>
        emit({
          type: 'pi.extension.error',
          data: { reason: 'extension_failed (details local only)' },
        }),
      commandContextActions: {
        waitForIdle: () => runtime.session.waitForIdle(),
        newSession: (options: any) => runtime.newSession(options),
        fork: (entry: string, options: any) => runtime.fork(entry, options),
        switchSession: (file: string, options: any) => {
          checkFile(file)
          return runtime.switchSession(file, { ...options, cwdOverride: cwd })
        },
        navigateTree: (entry: string, options: any) => runtime.session.navigateTree(entry, options),
        reload: () => runtime.session.reload(),
      },
    })
  )
  await worker.bind()
  emit({
    type: 'pi.project.trust',
    data: { source: 'node_project_registration', trusted: true, extensions_sandboxed: false },
  })
  return {
    prompt: (text: string) => worker.prompt(text),
    completionResult: (result: Awaited<ReturnType<PiSdkWorker['prompt']>>) =>
      worker.completionResult(result),
    abort: () => worker.abort(),
    dispose: async () => {
      worker.dispose()
      await runtime.dispose()
      const file = runtime.session.sessionFile
      if (file && existsSync(file)) chmodSync(file, 0o600)
    },
  }
}
