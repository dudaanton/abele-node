import { readFileSync, realpathSync, existsSync } from 'node:fs'
import { extname, relative, isAbsolute, resolve, join, dirname, sep } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { totalmem } from 'node:os'
import { execFile } from 'node:child_process'
import { LspDiagnosticSchema, LspRangeSchema, type LspDiagnostic } from '@abele/node-protocol'
import { LspConnection } from './connection.js'
import { servers, discover, projectEslint, projectCodeServers, type Language } from './servers.js'

type Document = {
  path: string
  text: string
  version: number
  languageId: string
  owners: Set<string>
}
type Slot = {
  root: string
  language: Language
  connection: LspConnection
  ready: Promise<void>
  docs: Map<string, Document>
  timer?: NodeJS.Timeout
  memory?: NodeJS.Timeout
  restart?: NodeJS.Timeout
  cancelRestart?: () => void
  crashes: number
  failed: boolean
  failure?: { code: string; message: string }
  tsserver?: string
  diagnosticProvider?: { identifier?: string }
  pulls?: Map<string, boolean>
}
export type LspOptions = {
  idleMs?: number
  memoryMB?: number
  trusted?: (root: string) => boolean
  command?: (language: Language) => { command: string; args: string[] } | null
  read?: (root: string, path: string) => string
  check: (root: string, path: string) => string
  diagnostics?: (root: string, path: string, diagnostics: LspDiagnostic[]) => void
  error?: (root: string, message: string) => void
}
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(new Error('cancelled'))
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort)
      reject(new Error('cancelled'))
    }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', abort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', abort)
        reject(error)
      }
    )
  })
}
/** One process per server/root, shared by all devices and sessions. All URI boundaries are confined. */
export class LspService {
  private slots = new Map<string, Slot>()
  private diagnostics = new Map<string, Map<Language, LspDiagnostic[]>>()
  private closed = false
  private activity = new Map<string, number>()
  private failures = new Map<string, Map<Language, { path: string; reason: string }>>()
  private pending = new Set<{
    root: string
    path: string
    owner: string
    controller: AbortController
  }>()
  constructor(
    private state: string,
    private options: LspOptions
  ) {}
  private memoryLimit() {
    const configured = this.options.memoryMB
    return configured && Number.isFinite(configured) && configured > 0
      ? Math.floor(configured)
      : Math.max(1024, Math.min(6144, Math.floor(totalmem() / 1024 / 1024 / 4)))
  }
  private heapLimit() {
    return Math.max(1, Math.floor(this.memoryLimit() / 2))
  }
  failureMessage(root: string, language: string) {
    return (
      this.slots.get(this.key(root, language as Language))?.failure?.message ??
      this.lastFailure(root, language)
    )
  }
  private slotError(slot: Slot) {
    return new Error(
      (slot.failure?.code ?? 'lsp_repeated_crash') + ': ' + (slot.failure?.message ?? slot.language)
    )
  }
  private key(root: string, language: Language) {
    return root + '\0' + language
  }
  lastFailure(root: string, language: string) {
    return (
      this.slots.get(this.key(root, language as Language))?.failure?.code ??
      this.failures.get(root)?.get(language as Language)?.reason
    )
  }
  private rememberFailure(root: string, path: string, error: unknown) {
    if (this.closed) return
    const reason = error instanceof Error ? error.message.split(':')[0]! : 'lsp_failed'
    // Slot failures are already scoped to the actual server. Do not blame the
    // other analyzers that happen to support the same document extension.
    if ([...this.slots.values()].some((s) => s.root === root && s.failure?.code === reason)) return
    if (
      /^(cancelled|untrusted_folder|stale_revision|unsafe_path|not_found|unauthorized|resource_busy|lsp_closed)$/.test(
        reason
      )
    )
      return
    const safeReason =
      reason.length <= 128 && /^(lsp_[a-z_]+|output_limit)$/.test(reason) ? reason : 'lsp_failed'
    const extension = extname(path).slice(1)
    const failures =
      this.failures.get(root) ?? new Map<Language, { path: string; reason: string }>()
    const notices: string[] = []
    for (const [language, spec] of Object.entries(servers))
      if (
        (spec.extensions as readonly string[]).includes(extension) &&
        this.allowed(root, language as Language) &&
        (language !== 'eslint' || projectEslint(root)) &&
        (this.options.command
          ? this.options.command(language as Language)
          : discover(this.state, language as Language))
      ) {
        const previous = failures.get(language as Language)
        if (previous?.path !== path || previous.reason !== safeReason)
          notices.push(language + ' analysis request failed: ' + safeReason)
        failures.set(language as Language, { path, reason: safeReason })
      }
    if (failures.size) {
      if (!this.failures.has(root) && this.failures.size >= 128)
        this.failures.delete(this.failures.keys().next().value!)
      this.failures.set(root, failures)
    }
    for (const message of notices) {
      try {
        this.options.error?.(root, message)
      } catch {
        /* Preserve the analysis error if the catalog is unavailable. */
      }
    }
  }
  private recovered(root: string, path: string, languages: string[]) {
    const failures = this.failures.get(root)
    for (const language of languages)
      if (failures?.get(language as Language)?.path === path) failures.delete(language as Language)
    if (!failures?.size) this.failures.delete(root)
  }
  private allowed(root: string, language: Language) {
    return !projectCodeServers.has(language) || this.options.trusted?.(root) === true
  }
  async enforceTrust(root: string) {
    // Preserve cleanup of an already-open canonical root even if it disappeared.
    if (![...this.slots.values()].some((slot) => slot.root === root)) {
      try {
        root = realpathSync(root)
      } catch {
        return
      }
    }
    await Promise.all(
      [...this.slots.values()]
        .filter((slot) => slot.root === root && !this.allowed(root, slot.language))
        .map((slot) => this.remove(slot))
    )
  }
  canRefresh(root: string) {
    root = realpathSync(root)
    return (
      [...this.slots.values()].some(
        (slot) => slot.root === root && this.allowed(root, slot.language)
      ) ||
      (Object.keys(servers) as Language[]).some(
        (language) =>
          this.allowed(root, language) &&
          (this.options.command ? this.options.command(language) : discover(this.state, language))
      )
    )
  }
  private touch(slot: Slot) {
    clearTimeout(slot.timer)
    slot.timer = undefined
    if (this.activity.has(slot.root) || [...slot.docs.values()].some((doc) => doc.owners.size))
      return
    slot.timer = setTimeout(
      () => {
        void this.remove(slot)
      },
      this.options.idleMs ?? 30 * 60 * 1000
    )
    slot.timer.unref()
  }
  private async remove(slot: Slot) {
    if (this.slots.get(this.key(slot.root, slot.language)) !== slot) return
    this.slots.delete(this.key(slot.root, slot.language))
    clearTimeout(slot.timer)
    clearInterval(slot.memory)
    clearTimeout(slot.restart)
    slot.cancelRestart?.()
    for (const doc of slot.docs.values()) this.setDiagnostics(slot, doc.path, [])
    await slot.connection.stop()
  }
  private uriPath(root: string, uri: unknown) {
    if (typeof uri !== 'string' || !uri.startsWith('file:')) throw new Error('unsafe_path')
    // Servers may use a different macOS spelling (/var vs /private/var, case, root alias).
    // Confine the actual target, then apply the same file boundary as document requests.
    const path = relative(realpathSync.native(root), realpathSync.native(fileURLToPath(uri)))
      .split(sep)
      .join('/')
    if (!path || path.startsWith('../') || isAbsolute(path)) throw new Error('unsafe_path')
    this.options.check(root, path)
    return path
  }
  private documentPath(root: string, path: string) {
    // Validate the supplied path before resolving case, so document symlinks stay forbidden.
    return this.uriPath(root, pathToFileURL(this.options.check(root, path)).href)
  }
  private setDiagnostics(slot: Slot, path: string, items: LspDiagnostic[]) {
    const key = slot.root + '\0' + path
    const sources = this.diagnostics.get(key) ?? new Map<Language, LspDiagnostic[]>()
    if (items.length) sources.set(slot.language, items)
    else sources.delete(slot.language)
    if (sources.size) this.diagnostics.set(key, sources)
    else this.diagnostics.delete(key)
    const merged = this.merged(slot.root, path)
    this.options.diagnostics?.(slot.root, path, merged)
  }
  private merged(root: string, path: string) {
    const result: LspDiagnostic[] = []
    let bytes = 0
    for (const item of [...(this.diagnostics.get(root + '\0' + path)?.values() ?? [])].flat()) {
      bytes += Buffer.byteLength(JSON.stringify(item))
      if (bytes > 64 * 1024 || result.length >= 256) break
      result.push(item)
    }
    return result
  }
  private diagnosticItems(language: Language, raw: unknown): LspDiagnostic[] {
    const items: LspDiagnostic[] = []
    for (const item of (Array.isArray(raw) ? raw : []).slice(0, 256)) {
      if (!item || typeof item !== 'object') continue
      const parsed = LspDiagnosticSchema.safeParse({
        range: item.range,
        message: String(item.message).slice(0, 4096),
        source: language,
        ...(item.severity ? { severity: item.severity } : {}),
        ...(item.code !== undefined ? { code: item.code } : {}),
      })
      if (parsed.success) items.push(parsed.data)
    }
    return items
  }
  private pullDiagnostics(slot: Slot, doc: Document) {
    if (
      this.closed ||
      this.slots.get(this.key(slot.root, slot.language)) !== slot ||
      !slot.diagnosticProvider ||
      !this.allowed(slot.root, slot.language)
    )
      return
    const pulls = (slot.pulls ??= new Map())
    if (pulls.has(doc.path)) {
      pulls.set(doc.path, true)
      return
    }
    pulls.set(doc.path, false)
    const connection = slot.connection
    void connection
      .request('textDocument/diagnostic', {
        textDocument: { uri: pathToFileURL(resolve(slot.root, doc.path)).href },
        ...slot.diagnosticProvider,
      })
      .then((report) => {
        if (
          this.closed ||
          this.slots.get(this.key(slot.root, slot.language)) !== slot ||
          slot.connection !== connection ||
          slot.docs.get(doc.path) !== doc ||
          !this.allowed(slot.root, slot.language)
        )
          return
        this.options.check(slot.root, doc.path)
        if (report?.kind === 'full')
          this.setDiagnostics(slot, doc.path, this.diagnosticItems(slot.language, report.items))
      })
      .catch((error) => {
        if (
          !this.closed &&
          this.slots.get(this.key(slot.root, slot.language)) === slot &&
          slot.connection === connection &&
          this.allowed(slot.root, slot.language)
        ) {
          console.warn('[Abele LSP] diagnostic request failed', {
            root: slot.root,
            language: slot.language,
            detail: String(error instanceof Error ? error.message : error).slice(0, 512),
          })
          try {
            this.options.error?.(slot.root, slot.language + ' diagnostic request failed')
          } catch {
            /* The catalog may be unavailable during shutdown. */
          }
        }
      })
      .finally(() => {
        const again = pulls.get(doc.path)
        pulls.delete(doc.path)
        const current = slot.docs.get(doc.path)
        if (
          again &&
          current &&
          !this.closed &&
          this.slots.get(this.key(slot.root, slot.language)) === slot
        )
          this.pullDiagnostics(slot, current)
      })
  }
  private start(slot: Slot, command: { command: string; args: string[] }) {
    if (!this.allowed(slot.root, slot.language)) throw new Error('untrusted_folder')
    const c = (slot.connection = new LspConnection(
      command.command,
      command.args,
      slot.root,
      this.heapLimit()
    ))
    c.onNotification = (method, params) => {
      if (!this.allowed(slot.root, slot.language)) {
        void this.remove(slot)
        return
      }
      // typescript-language-server forwards its worker's stderr and exit as LSP
      // logs, then stays alive. Treat that worker exit as a server crash too.
      if (
        slot.language === 'typescript' &&
        method === 'window/logMessage' &&
        params?.type === 1 &&
        typeof params.message === 'string'
      ) {
        const fatal = /FATAL ERROR:[^\r\n]*/.exec(params.message)?.[0]
        if (fatal) c.exitInfo.stderr = (c.exitInfo.stderr + '\n' + fatal.slice(0, 512)).slice(-2048)
        const exited =
          /\[tsserver\] Exited\. Code: (null|-?\d+)\. Signal: (null|SIG[A-Z0-9]+)\s*$/.exec(
            params.message
          )
        if (exited) {
          c.exitInfo.stderr = (
            c.exitInfo.stderr +
            `\nError: TypeScript worker exited (exit ${exited[1]}, signal ${exited[2]})`
          ).slice(-2048)
          c.kill('SIGKILL')
        }
        return
      }
      if (method !== 'textDocument/publishDiagnostics') return
      try {
        const path = this.uriPath(slot.root, params.uri)
        const doc = slot.docs.get(path)
        if (!doc || (params.version !== undefined && params.version !== doc.version)) return
        this.setDiagnostics(slot, path, this.diagnosticItems(slot.language, params.diagnostics))
      } catch {
        /* Ignore out-of-root or malformed server data. */
      }
    }
    c.onRequest = (method, params) => {
      if (method === 'workspace/diagnostic/refresh') {
        for (const doc of slot.docs.values()) this.pullDiagnostics(slot, doc)
        return null
      }
      if (method === 'workspace/configuration')
        return (params.items ?? []).slice(0, 32).map(() =>
          slot.language === 'eslint'
            ? {
                validate: 'on',
                run: 'onType',
                experimental: { useFlatConfig: false },
                options: {},
                workspaceFolder: { uri: pathToFileURL(slot.root).href, name: 'workspace' },
                workingDirectory: { directory: slot.root, '!cwd': false },
                nodePath: join(slot.root, 'node_modules'),
                useESLintClass: true,
                codeActionOnSave: { enable: false, mode: 'all' },
                format: false,
                quiet: false,
                rulesCustomizations: [],
                problems: { shortenToSingleLine: false },
              }
            : {}
        )
      if (method === 'workspace/workspaceFolders')
        return [{ uri: pathToFileURL(slot.root).href, name: 'workspace' }]
      // Servers may request edits; this read-only service never applies them.
      if (method === 'workspace/applyEdit') return { applied: false }
      return null
    }
    c.onExit = () => {
      clearInterval(slot.memory)
      for (const doc of slot.docs.values()) this.setDiagnostics(slot, doc.path, [])
      if (this.closed || this.slots.get(this.key(slot.root, slot.language)) !== slot) return
      if (!this.allowed(slot.root, slot.language)) {
        void this.remove(slot)
        return
      }
      if (slot.failure?.code === 'lsp_memory_limit') {
        slot.failed = true
        return
      }
      if (slot.crashes++ === 0) {
        this.options.error?.(
          slot.root,
          slot.language + ' crashed; restarting once after 1000 ms' + this.exitDetail(c)
        )
        slot.ready = new Promise<void>((resolve, reject) => {
          slot.cancelRestart = () => reject(new Error('lsp_closed'))
          slot.restart = setTimeout(() => {
            slot.restart = undefined
            slot.cancelRestart = undefined
            if (
              this.closed ||
              this.slots.get(this.key(slot.root, slot.language)) !== slot ||
              !this.allowed(slot.root, slot.language)
            ) {
              reject(new Error('lsp_closed'))
              return
            }
            try {
              this.start(slot, command).then(resolve, reject)
            } catch (error) {
              slot.failed = true
              this.options.error?.(slot.root, slot.language + ' could not restart')
              reject(error)
            }
          }, 1000)
          slot.restart.unref()
        })
        slot.ready.catch(() => {})
      } else {
        slot.failed = true
        slot.failure = {
          code: 'lsp_repeated_crash',
          message:
            'The language server stopped' + this.exitDetail(c) + '. Restart analysis to try again.',
        }
        this.options.error?.(
          slot.root,
          slot.language + ' stopped after repeated crash' + this.exitDetail(c)
        )
      }
    }
    // V8's heap limit covers JS servers. Check RSS too, including native servers.
    slot.memory = setInterval(() => {
      if (!c.child.pid) return
      try {
        execFile('ps', ['-axo', 'pid=,ppid=,rss='], { timeout: 1000 }, (error, stdout) => {
          if (error) return
          const rows = stdout
            .trim()
            .split('\n')
            .map((line) => line.trim().split(/\s+/).map(Number))
          const pids = new Set([c.child.pid])
          for (let i = 0; i < 8; i++)
            for (const [pid, parent] of rows) if (pids.has(parent)) pids.add(pid)
          const rss = rows
            .filter(([pid]) => pids.has(pid))
            .reduce((sum, row) => sum + (row[2] ?? 0), 0)
          if (
            this.closed ||
            slot.connection !== c ||
            slot.failed ||
            this.slots.get(this.key(slot.root, slot.language)) !== slot
          )
            return
          const limit = this.memoryLimit()
          if (rss > limit * 1024) {
            slot.failure = {
              code: 'lsp_memory_limit',
              message: `The language server exceeded its ${limit} MB process-tree memory limit (${Math.ceil(rss / 1024)} MB used). Raise ABELE_LSP_MEMORY_MB on the node and restart analysis.`,
            }
            slot.failed = true
            this.options.error?.(slot.root, slot.failure.message)
            c.kill('SIGKILL')
          }
        })
      } catch {
        // Process inventory is optional and can be denied by a host sandbox.
        // A synchronous spawn failure must not escape this timer and kill the node.
      }
    }, 5000)
    slot.memory.unref()
    return c
      .request('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(slot.root).href,
        workspaceFolders: [{ uri: pathToFileURL(slot.root).href, name: 'workspace' }],
        capabilities: {
          workspace: {
            configuration: true,
            workspaceFolders: true,
            diagnostics: { refreshSupport: true },
          },
          textDocument: {
            publishDiagnostics: { versionSupport: true },
            diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
            hover: { contentFormat: ['plaintext'] },
          },
        },
        initializationOptions:
          slot.language === 'typescript'
            ? {
                maxTsServerMemory: this.heapLimit(),
                tsserver: {
                  useSyntaxServer: 'never',
                  ...(slot.tsserver ? { path: slot.tsserver } : {}),
                },
                disableAutomaticTypingAcquisition: true,
              }
            : {},
      })
      .then((result) => {
        if (!this.allowed(slot.root, slot.language)) throw new Error('untrusted_folder')
        slot.failure = undefined
        const provider = result?.capabilities?.diagnosticProvider
        slot.diagnosticProvider = provider
          ? {
              ...(typeof provider.identifier === 'string'
                ? { identifier: provider.identifier }
                : {}),
            }
          : undefined
        c.notify('initialized', {})
        for (const doc of slot.docs.values()) this.sendOpen(slot, doc)
      })
      .catch((error) => {
        c.kill('SIGKILL')
        throw error
      })
  }
  private exitDetail(connection: LspConnection) {
    const { code, signal, stderr } = connection.exitInfo
    // Only bounded server error lines are exposed; omit source excerpts and stack frames.
    console.warn('[Abele LSP] server exited', { code, signal, stderr })
    const lines = stderr
      .split(/\r?\n/)
      .filter(
        (line) =>
          /error|fatal|exception|ENOMEM|heap out of memory/i.test(line) &&
          !/^\s*(at |[0-9]+[ :|])/.test(line)
      )
      .slice(-3)
      .map((line) =>
        line
          .replace(/[\x00-\x1f\x7f]/g, ' ')
          .replace(
            /(token|password|secret|api[_-]?key|authorization)\s*[:=]\s*\S+/gi,
            '$1=[redacted]'
          )
          .slice(0, 200)
      )
      .join('; ')
    return ` (exit ${code ?? 'unknown'}, signal ${signal ?? 'none'})${lines ? ': ' + lines : ''}`
  }
  private sendOpen(slot: Slot, doc: Document) {
    slot.connection.notify('textDocument/didOpen', {
      textDocument: {
        uri: pathToFileURL(resolve(slot.root, doc.path)).href,
        languageId: doc.languageId,
        version: doc.version,
        text: doc.text,
      },
    })
    this.pullDiagnostics(slot, doc)
  }
  private async active<T>(root: string, work: () => Promise<T>) {
    this.activity.set(root, (this.activity.get(root) ?? 0) + 1)
    for (const slot of this.slots.values()) if (slot.root === root) this.touch(slot)
    try {
      return await work()
    } finally {
      const count = (this.activity.get(root) ?? 1) - 1
      if (count) this.activity.set(root, count)
      else this.activity.delete(root)
      for (const slot of this.slots.values()) if (slot.root === root) this.touch(slot)
    }
  }
  private async owned<T>(
    root: string,
    path: string,
    owner: string | null,
    signal: AbortSignal | undefined,
    work: (signal?: AbortSignal) => Promise<T>
  ) {
    if (owner === null) return work(signal)
    const controller = new AbortController()
    const pending = { root, path, owner, controller }
    this.pending.add(pending)
    try {
      return await work(signal ? AbortSignal.any([signal, controller.signal]) : controller.signal)
    } finally {
      this.pending.delete(pending)
    }
  }
  async open(
    root: string,
    path: string,
    text?: string,
    version?: number,
    signal?: AbortSignal,
    owner: string | null = 'local'
  ) {
    // Opens/updates are idempotent per owner. null is background analysis, not a visible view.
    // Check document confinement before resolving filesystem spelling.
    root = realpathSync(root)
    path = this.documentPath(root, path)
    return this.active(root, () =>
      this.owned(root, path, owner, signal, (signal) =>
        this.openDocument(root, path, text, version, signal, owner)
      )
    )
      .then((result) => {
        this.recovered(root, path, result.servers)
        return result
      })
      .catch((error) => {
        this.rememberFailure(root, path, error)
        throw error
      })
  }
  private async openDocument(
    root: string,
    path: string,
    text?: string,
    version?: number,
    signal?: AbortSignal,
    owner: string | null = null
  ) {
    if (this.closed) throw new Error('lsp_closed')
    if (signal?.aborted) throw new Error('cancelled')
    await this.enforceTrust(root)
    const target = this.options.check(root, path)
    text ??= this.options.read ? this.options.read(root, path) : readFileSync(target, 'utf8')
    if (Buffer.byteLength(text) > 512 * 1024) throw new Error('lsp_document_limit')
    const extension = extname(path).slice(1)
    const languages = (Object.keys(servers) as Language[]).filter(
      (l) =>
        this.allowed(root, l) &&
        (servers[l].extensions as readonly string[]).includes(extension) &&
        (l !== 'eslint' || projectEslint(root))
    )
    const opened: string[] = []
    for (const language of languages) {
      if (!this.allowed(root, language)) continue
      const key = this.key(root, language)
      let slot = this.slots.get(key)
      if (!slot) {
        const found = this.options.command
          ? this.options.command(language)
          : (() => {
              const command = discover(this.state, language)
              return command
                ? {
                    command,
                    args:
                      language === 'bash'
                        ? ['start']
                        : language === 'rust' || language === 'go'
                          ? []
                          : ['--stdio'],
                  }
                : null
            })()
        if (!found) continue
        if (this.slots.size >= 16) throw new Error('lsp_process_limit')
        slot = { root, language, docs: new Map(), crashes: 0, failed: false } as Slot
        if (language === 'typescript' && !this.options.command) {
          slot.tsserver = [
            join(root, 'node_modules/typescript/lib/tsserver.js'),
            join(this.state, 'lsp/typescript/node_modules/typescript/lib/tsserver.js'),
            join(dirname(dirname(dirname(found.command))), 'typescript/lib/tsserver.js'),
          ].find((path) => existsSync(path))
          if (!slot.tsserver)
            throw new Error(
              'lsp_typescript_missing: Install project dependencies or reinstall the TypeScript language server on this node'
            )
        }
        this.slots.set(key, slot)
        try {
          slot.ready = this.start(slot, found)
        } catch (error) {
          this.slots.delete(key)
          throw error
        }
        slot.ready.catch(() => {})
      }
      if (slot.failed) {
        slot.failed = false
        slot.crashes = 0
        const restarting = slot
        const previous = slot.connection
        slot.ready = (async () => {
          await previous.stop()
          if (this.closed || this.slots.get(key) !== restarting) throw new Error('lsp_closed')
          restarting.failure = undefined
          await this.start(restarting, {
            command: previous.child.spawnfile,
            args: previous.child.spawnargs.slice(1),
          })
        })().catch((error) => {
          restarting.failed = true
          throw error
        })
        slot.ready.catch(() => {})
      }
      this.touch(slot)
      await waitFor(slot.ready, signal)
      if (signal?.aborted) throw new Error('cancelled')
      if (!this.allowed(root, language)) throw new Error('untrusted_folder')
      if (slot.docs.size >= 64 && !slot.docs.has(path)) throw new Error('lsp_document_limit')
      const previous = slot.docs.get(path)
      const next = version ?? (previous?.version ?? 0) + 1
      if (previous && next <= previous.version) throw new Error('stale_revision')
      const languageId =
        extension === 'tsx'
          ? 'typescriptreact'
          : extension === 'jsx'
            ? 'javascriptreact'
            : ['js', 'mjs', 'cjs'].includes(extension)
              ? 'javascript'
              : language === 'eslint'
                ? 'typescript'
                : language === 'bash'
                  ? 'shellscript'
                  : language
      const owners = previous?.owners ?? new Set<string>()
      if (owner !== null) owners.add(owner)
      const doc = { path, text, version: next, languageId, owners }
      slot.docs.set(path, doc)
      if (previous) {
        slot.connection.notify('textDocument/didChange', {
          textDocument: { uri: pathToFileURL(target).href, version: next },
          contentChanges: [{ text }],
        })
        this.pullDiagnostics(slot, doc)
      } else this.sendOpen(slot, doc)
      opened.push(language)
    }
    return { servers: opened }
  }
  closeDocument(root: string, path: string, owner = 'local') {
    root = realpathSync(root)
    path = this.documentPath(root, path)
    this.options.check(root, path)
    // Cancel older acquisitions even when initialization has not created a document yet.
    for (const pending of this.pending)
      if (pending.root === root && pending.path === path && pending.owner === owner)
        pending.controller.abort()
    for (const slot of this.slots.values())
      if (slot.root === root) this.closeOwnedDocument(slot, path, owner)
    return { closed: true }
  }
  releaseOwner(owner: string) {
    // Disconnect cleanup must work even if the root or file has disappeared.
    for (const pending of this.pending) if (pending.owner === owner) pending.controller.abort()
    for (const slot of this.slots.values())
      for (const path of slot.docs.keys()) this.closeOwnedDocument(slot, path, owner)
  }
  private closeOwnedDocument(slot: Slot, path: string, owner: string) {
    const doc = slot.docs.get(path)
    if (!doc || !doc.owners.delete(owner) || doc.owners.size) return
    slot.docs.delete(path)
    try {
      slot.connection.notify('textDocument/didClose', {
        textDocument: { uri: pathToFileURL(resolve(slot.root, path)).href },
      })
    } catch {
      /* crashed */
    }
    this.setDiagnostics(slot, path, [])
    this.touch(slot)
  }
  async query(
    root: string,
    path: string,
    method: string,
    position?: unknown,
    signal?: AbortSignal,
    owner = 'local'
  ) {
    root = realpathSync(root)
    path = this.documentPath(root, path)
    return this.active(root, () =>
      this.owned(root, path, owner, signal, (signal) =>
        this.queryDocument(root, path, method, position, signal, owner)
      )
    ).catch((error) => {
      this.rememberFailure(root, path, error)
      throw error
    })
  }
  private async queryDocument(
    root: string,
    path: string,
    method: string,
    position?: unknown,
    signal?: AbortSignal,
    owner = 'local'
  ) {
    const target = this.options.check(root, path)
    await this.enforceTrust(root)
    if (signal?.aborted) throw new Error('cancelled')
    // A querying connection owns an existing buffer just as it owns an implicitly opened one.
    for (const slot of this.slots.values())
      if (slot.root === root) slot.docs.get(path)?.owners.add(owner)
    if (![...this.slots.values()].some((s) => s.root === root && s.docs.has(path)))
      await this.open(root, path, undefined, undefined, signal, owner)
    if (method === 'diagnostics') {
      for (const s of this.slots.values())
        if (s.root === root && s.docs.has(path)) {
          if (s.failed) throw this.slotError(s)
          this.touch(s)
        }
      return { diagnostics: this.merged(root, path) }
    }
    const slot = [...this.slots.values()].find(
      (s) => s.root === root && s.language !== 'eslint' && s.docs.has(path)
    )
    if (slot?.failed) throw this.slotError(slot)
    if (!slot) {
      const extension = extname(path).slice(1)
      if (
        [...projectCodeServers].some(
          (l) =>
            !this.allowed(root, l) &&
            (servers[l].extensions as readonly string[]).includes(extension)
        )
      )
        throw new Error('untrusted_folder')
      throw new Error('lsp_unavailable')
    }
    this.touch(slot)
    await waitFor(slot.ready, signal)
    if (!this.allowed(root, slot.language)) throw new Error('untrusted_folder')
    const result = await slot.connection.request(
      'textDocument/' + (method === 'symbols' ? 'documentSymbol' : method),
      {
        textDocument: { uri: pathToFileURL(target).href },
        ...(position ? { position } : {}),
        ...(method === 'references' ? { context: { includeDeclaration: true } } : {}),
      },
      signal
    )
    if (!this.allowed(root, slot.language)) throw new Error('untrusted_folder')
    if (method === 'definition' || method === 'references') {
      const locations = []
      for (const item of (Array.isArray(result) ? result : result ? [result] : []).slice(0, 128)) {
        try {
          locations.push({
            path: this.uriPath(root, item.targetUri ?? item.uri),
            range: LspRangeSchema.parse(item.targetSelectionRange ?? item.range),
          })
        } catch {
          /* outside root */
        }
      }
      return { locations }
    }
    if (method === 'hover') {
      const contents = result?.contents
      const text = (Array.isArray(contents) ? contents : [contents])
        .map((c) => (typeof c === 'string' ? c : (c?.value ?? '')))
        .join('\n')
        .slice(0, 16384)
      return {
        text,
        ...(result?.range && LspRangeSchema.safeParse(result.range).success
          ? { range: result.range }
          : {}),
      }
    }
    // Return only file-local symbol fields; never forward arbitrary server JSON/URIs.
    const symbols: { name: string; kind: number; range: unknown }[] = []
    const visit = (items: any[], depth: number) => {
      if (depth > 8) return
      for (const item of items.slice(0, 128)) {
        if (symbols.length >= 128) return
        const range = LspRangeSchema.safeParse(item.range ?? item.location?.range)
        if (range.success && typeof item.name === 'string')
          symbols.push({ name: item.name.slice(0, 256), kind: item.kind, range: range.data })
        if (Array.isArray(item.children)) visit(item.children, depth + 1)
      }
    }
    visit(Array.isArray(result) ? result : [], 0)
    return { symbols }
  }
  async refresh(root: string, skip = new Set<string>()) {
    root = realpathSync(root)
    await this.enforceTrust(root)
    const paths = new Set(
      [...this.slots.values()].filter((s) => s.root === root).flatMap((s) => [...s.docs.keys()])
    )
    for (const path of paths)
      if (!skip.has(path)) await this.open(root, path, undefined, undefined, undefined, null)
  }
  async stop() {
    this.closed = true
    this.failures.clear()
    for (const pending of this.pending) pending.controller.abort()
    await Promise.all([...this.slots.values()].map((s) => this.remove(s)))
    this.diagnostics.clear()
  }
  async releaseRoot(root: string) {
    // Slots hold canonical roots; the folder may already be gone, so fall back to the name given.
    let canonical = root
    try {
      canonical = realpathSync(root)
    } catch {}
    this.failures.delete(root)
    this.failures.delete(canonical)
    this.activity.delete(root)
    this.activity.delete(canonical)
    await Promise.all(
      [...this.slots.values()]
        .filter((s) => s.root === root || s.root === canonical)
        .map((s) => this.remove(s))
    )
  }
}
