// Manual, quota-consuming probe using a user-installed SDK; never run by CI.
// Never prints auth, model endpoints, headers, or provider request payloads.
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const root =
  process.env.PI_SDK_DIR ??
  join(
    execFileSync('npm', ['root', '-g'], { encoding: 'utf8' }).trim(),
    '@earendil-works/pi-coding-agent'
  )
const provider = process.env.PI_PROBE_PROVIDER
const modelId = process.env.PI_PROBE_MODEL
if (!provider || !modelId) throw new Error('PI_PROBE_PROVIDER and PI_PROBE_MODEL are required')
const cwd = await mkdtemp('/tmp/abele-node-stage0-pi-')
let session
const deadline = setTimeout(() => {
  console.error('SDK probe hard deadline (90s)')
  void session?.abort()
  setTimeout(() => process.exit(124), 1000).unref()
}, 90_000)
try {
  const sdk = await import(pathToFileURL(join(root, 'dist/index.js')).href)
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
  const modelRuntime = await sdk.ModelRuntime.create({
    allowModelNetwork: false,
    signal: AbortSignal.timeout(10_000),
  })
  const model = modelRuntime.getModel(provider, modelId)
  if (!model) throw new Error('Configured probe model not found')
  const events = [],
    deltas = [],
    gates = [],
    errors = []
  const settingsManager = sdk.SettingsManager.inMemory({
    retry: { enabled: false },
    compaction: { enabled: false },
  })
  const loader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir: cwd,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [],
    systemPromptOverride: () =>
      'You are a tiny capability probe. Follow the prompt exactly and be concise.',
    extensionFactories: [
      (pi) => {
        pi.on('tool_call', (event) => {
          gates.push({ toolName: event.toolName, toolCallId: event.toolCallId })
          return {
            block: true,
            reason: 'Stage 0 denies execution (no remote answer)',
            terminate: true,
          }
        })
        pi.on('agent_settled', () => events.push('extension:agent_settled'))
      },
    ],
  })
  await loader.reload()
  const manager = sdk.SessionManager.create(cwd, join(cwd, 'sessions'))
  ;({ session } = await sdk.createAgentSession({
    cwd,
    model: { ...model, maxTokens: 512 },
    modelRuntime,
    thinkingLevel: 'off',
    tools: ['bash'],
    sessionManager: manager,
    resourceLoader: loader,
    settingsManager,
  }))
  await session.bindExtensions({
    mode: 'print',
    onError: (error) => errors.push({ event: error.event, error: error.error }),
  })
  session.subscribe((event) => {
    events.push(event.type)
    if (event.type === 'message_update') deltas.push(event.assistantMessageEvent.type)
  })
  await session.prompt(
    'Use bash exactly once to run printf pi-probe. If denied, reply PI_OK. Do not use other tools.'
  )
  await session.waitForIdle()
  const file = session.sessionFile
  const restored = sdk.SessionManager.open(file)
  console.log(
    JSON.stringify(
      {
        sdk_version: version,
        provider: model.provider,
        model: model.id,
        cwd,
        events: [...new Set(events)],
        deltas: [...new Set(deltas)],
        gates,
        errors,
        messages: session.messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({
            role: m.role,
            content: m.content,
            stopReason: m.stopReason,
            errorMessage: m.errorMessage,
          })),
        persisted: manager.isPersisted(),
        reopened_same_id: restored.getSessionId() === session.sessionId,
        reopened_entries: restored.getEntries().length,
        recent_same_id:
          sdk.SessionManager.continueRecent(cwd, join(cwd, 'sessions')).getSessionId() ===
          session.sessionId,
      },
      null,
      2
    )
  )
} finally {
  clearTimeout(deadline)
  session?.dispose()
}
