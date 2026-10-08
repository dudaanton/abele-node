// Models SDK 0.87.0 contracts, not inference: lazy JSONL creation, discovery
// independent of noContextFiles, command exception swallowing, runtime rebinding.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
export function createSdkDouble({
  shutdownError = false,
  defaultProvider = 'fixture',
  defaultModel = 'tiny',
} = {}) {
  const state = {
    reads: [],
    serviceOptions: [],
    tools: [],
    runtime: undefined,
    shutdowns: 0,
    settingsOptions: [],
    selectedModels: [],
  }
  class Manager {
    constructor(cwd, root) {
      this.header = {
        type: 'session',
        version: 3,
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        cwd,
      }
      this.file = join(root, this.header.id + '.jsonl')
      this.root = root
      this.entries = []
      this.leaf = null
      this.flushed = false
    }
    static create(cwd, root) {
      return new Manager(cwd, root)
    }
    static open(file, root, cwd) {
      const m = new Manager(cwd, root)
      m.setSessionFile(file)
      return m
    }
    setSessionFile(file) {
      const [header, ...entries] = readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
      this.file = file
      this.header = header
      this.entries = entries
      this.leaf = entries.at(-1)?.id ?? null
      this.flushed = true
    }
    isPersisted() {
      return true
    }
    getSessionFile() {
      return this.file
    }
    getSessionDir() {
      return this.root
    }
    getSessionId() {
      return this.header.id
    }
    getCwd() {
      return this.header.cwd
    }
    getHeader() {
      return this.header
    }
    getEntries() {
      return [...this.entries]
    }
    getLeafId() {
      return this.leaf
    }
    branch(id) {
      this.leaf = id
    }
    resetLeaf() {
      this.leaf = null
    }
    append(entry) {
      const e = {
        id: randomUUID(),
        parentId: this.leaf,
        timestamp: new Date().toISOString(),
        ...entry,
      }
      this.entries.push(e)
      this.leaf = e.id
      if (this.flushed) appendFileSync(this.file, JSON.stringify(e) + '\n')
      else if (this.entries.some((e) => e.type === 'message' && e.message.role === 'assistant')) {
        // Matches the SDK: creation is exclusive, then later entries append.
        writeFileSync(
          this.file,
          [this.header, ...this.entries].map(JSON.stringify).join('\n') + '\n',
          { flag: 'wx' }
        )
        this.flushed = true
      }
      return e.id
    }
    appendCustomEntry(customType, data) {
      return this.append({ type: 'custom', customType, data })
    }
    appendMessage(message) {
      return this.append({ type: 'message', message })
    }
  }
  const settings = () => ({
    trusted: false,
    getDefaultProvider: () => defaultProvider,
    getDefaultModel: () => defaultModel,
    setProjectTrusted(v) {
      this.trusted = v
    },
  })
  const discover = (options, name) => {
    const project = join(options.cwd, '.pi', name),
      global = join(options.agentDir, name)
    return options.settingsManager.trusted && existsSync(project)
      ? project
      : existsSync(global)
        ? global
        : undefined
  }
  const resolvePrompt = (input) => {
    if (!input) return undefined
    if (existsSync(input)) {
      state.reads.push(input)
      return readFileSync(input, 'utf8')
    }
    return input
  }
  const sdk = {
    SessionManager: Manager,
    ModelRuntime: {
      create: async () => ({
        getModel: (provider, id) => {
          state.selectedModels.push({ provider, id })
          return { provider, id, maxTokens: 4096 }
        },
      }),
    },
    SettingsManager: {
      inMemory: settings,
      create: (_cwd, _agentDir, options) => {
        state.settingsOptions.push(options)
        return settings()
      },
    },
    createAgentSessionServices: async (options) => {
      state.serviceOptions.push(options)
      const resources = options.resourceLoaderOptions
      // Overrides apply only AFTER source reading in the real loader. Empty
      // explicit source values must prevent discovery, not just redact output.
      const base = resolvePrompt(resources.systemPrompt ?? discover(options, 'SYSTEM.md'))
      const sources =
        resources.appendSystemPrompt ||
        (discover(options, 'APPEND_SYSTEM.md') ? [discover(options, 'APPEND_SYSTEM.md')] : [])
      const append = sources.map(resolvePrompt).filter((v) => v !== undefined)
      const systemPrompt = resources.systemPromptOverride
        ? resources.systemPromptOverride(base)
        : base
      const appendSystemPrompt = resources.appendSystemPromptOverride
        ? resources.appendSystemPromptOverride(append)
        : append
      return { ...options, diagnostics: [], resourceLoader: { systemPrompt, appendSystemPrompt } }
    },
    createAgentSessionFromServices: async ({ services, sessionManager }) => {
      const listeners = new Set()
      let bindings
      sessionManager.appendCustomEntry('sdk-initialization', { provider: 'fixture' })
      const emit = (event) => {
        for (const fn of listeners) fn(event)
      }
      const session = {
        sessionManager,
        get sessionId() {
          return sessionManager.getSessionId()
        },
        get sessionFile() {
          return sessionManager.getSessionFile()
        },
        subscribe(fn) {
          listeners.add(fn)
          return () => listeners.delete(fn)
        },
        bindExtensions: async (b) => {
          bindings = b
        },
        waitForIdle: async () => {},
        abort: async () => {},
        dispose: () => {},
        shutdown: async () => {
          state.shutdowns++
          // The real extension runner reports session_shutdown errors through
          // onError, but runtime.dispose itself still resolves successfully.
          try {
            if (shutdownError) throw Error('FAKE_SHUTDOWN_SECRET: failed state write')
          } catch (error) {
            bindings.onError({ event: 'session_shutdown', error })
          }
        },
        prompt: async (text, options) => {
          if (text === '/unauthorized') {
            options.preflightResult(false)
            throw Error('fake authorization unavailable')
          }
          if (text === '/emptycmd') {
            sessionManager.appendCustomEntry('handled-command', {})
            options.preflightResult(true)
            return
          }
          if (text === '/new') {
            await bindings.commandContextActions.newSession()
            options.preflightResult(true)
            return
          }
          if (text === '/unsupported') {
            try {
              await bindings.uiContext.custom(() => {})
            } catch (error) {
              bindings.onError({ event: 'command:/unsupported', error })
            }
            options.preflightResult(true)
            return
          }
          options.preflightResult(true)
          sessionManager.appendMessage({ role: 'user', content: text })
          const message = {
            role: 'assistant',
            content: [{ type: 'text', text: 'fake response' }],
            stopReason: 'stop',
          }
          sessionManager.appendMessage(message)
          emit({ type: 'message_end', message })
          emit({ type: 'agent_settled' })
        },
      }
      // Capture node policy/tool registrations without executing any SDK code.
      for (const extension of services.resourceLoaderOptions.extensionFactories) {
        await extension.factory({ on: () => {}, registerTool: (tool) => state.tools.push(tool) })
      }
      return { session, extensionsResult: { extensions: [], errors: [], runtime: {} } }
    },
    createAgentSessionRuntime: async (factory, options) => {
      let result = await factory(options),
        rebind,
        before
      const runtime = {
        get session() {
          return result.session
        },
        setRebindSession(fn) {
          rebind = fn
        },
        setBeforeSessionInvalidate(fn) {
          before = fn
        },
        newSession: async () => {
          before?.()
          result = await factory({
            ...options,
            sessionManager: Manager.create(options.cwd, options.sessionManager.getSessionDir()),
          })
          await rebind?.(result.session)
          return { cancelled: false }
        },
        dispose: async () => {
          await result.session.shutdown()
          before?.()
          result.session.dispose()
        },
      }
      state.runtime = runtime
      return runtime
    },
    createBashToolDefinition: (cwd, options) => ({ name: 'bash', label: 'bash', cwd, options }),
  }
  return { sdk, state }
}
