import { readFileSync } from 'node:fs'
import { extname, relative, isAbsolute, resolve, join } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { LspDiagnosticSchema, LspRangeSchema, type LspDiagnostic } from '@abele/node-protocol'
import { LspConnection } from './connection.js'
import { servers, discover, projectEslint, type Language } from './servers.js'

type Document = { path: string; text: string; version: number; languageId: string }
type Slot = {
  root: string
  language: Language
  connection: LspConnection
  ready: Promise<void>
  docs: Map<string, Document>
  timer?: NodeJS.Timeout
  memory?: NodeJS.Timeout
  crashes: number
  failed: boolean
}
export type LspOptions = {
  idleMs?: number
  memoryMB?: number
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
  constructor(
    private state: string,
    private options: LspOptions
  ) {}
  private key(root: string, language: Language) {
    return root + '\0' + language
  }
  canRefresh(root: string) {
    return (
      [...this.slots.values()].some((slot) => slot.root === root) ||
      (Object.keys(servers) as Language[]).some((language) =>
        this.options.command ? this.options.command(language) : discover(this.state, language)
      )
    )
  }
  private touch(slot: Slot) {
    clearTimeout(slot.timer)
    slot.timer = setTimeout(() => {
      if (this.activity.has(slot.root)) this.touch(slot)
      else void this.remove(slot)
    }, this.options.idleMs ?? 180000)
    slot.timer.unref()
  }
  private async remove(slot: Slot) {
    if (this.slots.get(this.key(slot.root, slot.language)) !== slot) return
    this.slots.delete(this.key(slot.root, slot.language))
    clearTimeout(slot.timer)
    clearInterval(slot.memory)
    for (const doc of slot.docs.values()) this.setDiagnostics(slot, doc.path, [])
    await slot.connection.stop()
  }
  private uriPath(root: string, uri: unknown) {
    if (typeof uri !== 'string' || !uri.startsWith('file:')) throw new Error('unsafe_path')
    const path = relative(root, fileURLToPath(uri)).split('\\').join('/')
    if (!path || path.startsWith('../') || isAbsolute(path)) throw new Error('unsafe_path')
    this.options.check(root, path)
    return path
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
  private start(slot: Slot, command: { command: string; args: string[] }) {
    const c = (slot.connection = new LspConnection(
      command.command,
      command.args,
      slot.root,
      this.options.memoryMB ?? 384
    ))
    c.onNotification = (method, params) => {
      if (method !== 'textDocument/publishDiagnostics') return
      try {
        const path = this.uriPath(slot.root, params.uri)
        const doc = slot.docs.get(path)
        if (!doc || (params.version !== undefined && params.version !== doc.version)) return
        const items: LspDiagnostic[] = []
        for (const raw of (Array.isArray(params.diagnostics) ? params.diagnostics : []).slice(
          0,
          256
        )) {
          const parsed = LspDiagnosticSchema.safeParse({
            range: raw.range,
            message: String(raw.message).slice(0, 4096),
            source: slot.language,
            ...(raw.severity ? { severity: raw.severity } : {}),
            ...(raw.code !== undefined ? { code: raw.code } : {}),
          })
          if (parsed.success) items.push(parsed.data)
        }
        this.setDiagnostics(slot, path, items)
      } catch {
        /* Ignore out-of-root or malformed server data. */
      }
    }
    c.onRequest = (method, params) => {
      if (method === 'workspace/configuration')
        return (params.items ?? []).slice(0, 32).map(() =>
          slot.language === 'eslint'
            ? {
                validate: 'on',
                run: 'onType',
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
      if (slot.crashes++ === 0) {
        this.options.error?.(slot.root, slot.language + ' crashed; restarting once')
        slot.ready = this.start(slot, command)
        slot.ready.catch(() => {})
      } else {
        slot.failed = true
        this.options.error?.(slot.root, slot.language + ' stopped after repeated crash')
      }
    }
    // V8's heap limit covers JS servers. Check RSS too, including native servers.
    slot.memory = setInterval(() => {
      if (!c.child.pid) return
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
        if (rss > (this.options.memoryMB ?? 384) * 1024) c.kill('SIGKILL')
      })
    }, 5000)
    slot.memory.unref()
    return c
      .request('initialize', {
        processId: process.pid,
        rootUri: pathToFileURL(slot.root).href,
        workspaceFolders: [{ uri: pathToFileURL(slot.root).href, name: 'workspace' }],
        capabilities: {
          workspace: { configuration: true, workspaceFolders: true },
          textDocument: {
            publishDiagnostics: { versionSupport: true },
            hover: { contentFormat: ['plaintext'] },
          },
        },
        initializationOptions:
          slot.language === 'typescript' ? { maxTsServerMemory: this.options.memoryMB ?? 384 } : {},
      })
      .then(() => {
        c.notify('initialized', {})
        for (const doc of slot.docs.values()) this.sendOpen(slot, doc)
      })
      .catch((error) => {
        c.kill('SIGKILL')
        throw error
      })
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
  }
  private async active<T>(root: string, work: () => Promise<T>) {
    this.activity.set(root, (this.activity.get(root) ?? 0) + 1)
    try {
      return await work()
    } finally {
      const count = (this.activity.get(root) ?? 1) - 1
      if (count) this.activity.set(root, count)
      else this.activity.delete(root)
      for (const slot of this.slots.values()) if (slot.root === root) this.touch(slot)
    }
  }
  async open(root: string, path: string, text?: string, version?: number, signal?: AbortSignal) {
    return this.active(root, () => this.openDocument(root, path, text, version, signal))
  }
  private async openDocument(
    root: string,
    path: string,
    text?: string,
    version?: number,
    signal?: AbortSignal
  ) {
    if (this.closed) throw new Error('lsp_closed')
    const target = this.options.check(root, path)
    text ??= this.options.read ? this.options.read(root, path) : readFileSync(target, 'utf8')
    if (Buffer.byteLength(text) > 512 * 1024) throw new Error('lsp_document_limit')
    const extension = extname(path).slice(1)
    const languages = (Object.keys(servers) as Language[]).filter(
      (l) =>
        (servers[l].extensions as readonly string[]).includes(extension) &&
        (l !== 'eslint' || projectEslint(root))
    )
    const opened: string[] = []
    for (const language of languages) {
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
        this.slots.set(key, slot)
        slot.ready = this.start(slot, found)
        slot.ready.catch(() => {})
      }
      if (slot.failed) throw new Error('lsp_repeated_crash: ' + language)
      this.touch(slot)
      await waitFor(slot.ready, signal)
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
      const doc = { path, text, version: next, languageId }
      slot.docs.set(path, doc)
      if (previous)
        slot.connection.notify('textDocument/didChange', {
          textDocument: { uri: pathToFileURL(target).href, version: next },
          contentChanges: [{ text }],
        })
      else this.sendOpen(slot, doc)
      opened.push(language)
    }
    return { servers: opened }
  }
  closeDocument(root: string, path: string) {
    this.options.check(root, path)
    for (const slot of this.slots.values())
      if (slot.root === root && slot.docs.delete(path)) {
        try {
          slot.connection.notify('textDocument/didClose', {
            textDocument: { uri: pathToFileURL(resolve(root, path)).href },
          })
        } catch {
          /* crashed */
        }
        this.setDiagnostics(slot, path, [])
        this.touch(slot)
      }
    return { closed: true }
  }
  async query(
    root: string,
    path: string,
    method: string,
    position?: unknown,
    signal?: AbortSignal
  ) {
    return this.active(root, () => this.queryDocument(root, path, method, position, signal))
  }
  private async queryDocument(
    root: string,
    path: string,
    method: string,
    position?: unknown,
    signal?: AbortSignal
  ) {
    const target = this.options.check(root, path)
    if (![...this.slots.values()].some((s) => s.root === root && s.docs.has(path)))
      await this.open(root, path, undefined, undefined, signal)
    if (method === 'diagnostics') {
      for (const s of this.slots.values()) if (s.root === root && s.docs.has(path)) this.touch(s)
      return { diagnostics: this.merged(root, path) }
    }
    const slot = [...this.slots.values()].find(
      (s) => s.root === root && s.language !== 'eslint' && s.docs.has(path)
    )
    if (!slot || slot.failed) throw new Error('lsp_unavailable')
    this.touch(slot)
    await waitFor(slot.ready, signal)
    const result = await slot.connection.request(
      'textDocument/' + (method === 'symbols' ? 'documentSymbol' : method),
      {
        textDocument: { uri: pathToFileURL(target).href },
        ...(position ? { position } : {}),
        ...(method === 'references' ? { context: { includeDeclaration: true } } : {}),
      },
      signal
    )
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
    const paths = new Set(
      [...this.slots.values()].filter((s) => s.root === root).flatMap((s) => [...s.docs.keys()])
    )
    for (const path of paths) if (!skip.has(path)) await this.open(root, path)
  }
  async stop() {
    this.closed = true
    await Promise.all([...this.slots.values()].map((s) => this.remove(s)))
    this.diagnostics.clear()
  }
}
