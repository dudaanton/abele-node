import {
  LspMethodSchemas,
  LspLocationsResultSchema,
  LspDiagnosticsResultSchema,
  LspHoverResultSchema,
  LspSymbolsResultSchema,
  LspStatusSchema,
  LspInstallResultSchema,
  LspOpenResultSchema,
} from '@abele/node-protocol'
type Methods = typeof LspMethodSchemas
export type LspRoot =
  { workspace_id: string; worktree_id?: never } | { worktree_id: string; workspace_id?: never }
type Position = { line: number; character: number }
/** Online-only calls; cancellation IDs are scoped by the node to the authenticated installation. */
export class LspClient {
  constructor(private rpc: (method: string, params: unknown) => Promise<unknown>) {}
  private async call<M extends keyof Methods>(
    method: M,
    params: Methods[M]['_input'],
    signal?: AbortSignal
  ) {
    if (signal?.aborted) throw new Error('cancelled')
    const request_id = globalThis.crypto.randomUUID()
    const abort = () => {
      void this.rpc('lsp.v1.cancel', { request_id }).catch(() => {})
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      return await this.rpc(method, LspMethodSchemas[method].parse({ ...params, request_id }))
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }
  async status(root?: LspRoot) {
    return LspStatusSchema.parse(await this.call('lsp.v1.status', root ?? {}))
  }
  async install(languages: string[], signal?: AbortSignal) {
    return LspInstallResultSchema.parse(await this.call('lsp.v1.install', { languages }, signal))
  }
  async open(root: LspRoot, path: string, text?: string, version?: number, signal?: AbortSignal) {
    return LspOpenResultSchema.parse(
      await this.call('lsp.v1.open', { ...root, path, text, version }, signal)
    )
  }
  close(root: LspRoot, path: string) {
    return this.call('lsp.v1.close', { ...root, path })
  }
  async definition(root: LspRoot, path: string, position: Position, signal?: AbortSignal) {
    return LspLocationsResultSchema.parse(
      await this.call('lsp.v1.definition', { ...root, path, position }, signal)
    ).locations
  }
  async references(root: LspRoot, path: string, position: Position, signal?: AbortSignal) {
    return LspLocationsResultSchema.parse(
      await this.call('lsp.v1.references', { ...root, path, position }, signal)
    ).locations
  }
  async diagnostics(root: LspRoot, path: string, signal?: AbortSignal) {
    return LspDiagnosticsResultSchema.parse(
      await this.call('lsp.v1.diagnostics', { ...root, path }, signal)
    ).diagnostics
  }
  async hover(root: LspRoot, path: string, position: Position, signal?: AbortSignal) {
    return LspHoverResultSchema.parse(
      await this.call('lsp.v1.hover', { ...root, path, position }, signal)
    )
  }
  async symbols(root: LspRoot, path: string, signal?: AbortSignal) {
    return LspSymbolsResultSchema.parse(
      await this.call('lsp.v1.symbols', { ...root, path }, signal)
    )
  }
}
