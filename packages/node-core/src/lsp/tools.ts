import { z } from 'zod'
import { ChannelError } from '@abele/channel-protocol'
import { RelativePathSchema, LspPositionSchema } from '@abele/node-protocol'
import type { DebuggerToolBridge } from '@abele/provider-contract'
import type { NodeCore } from '../index.js'

export class LspTools implements DebuggerToolBridge {
  private closed = false
  private results = new WeakMap<object, string>()
  readonly tools: DebuggerToolBridge['tools']
  constructor(
    private core: NodeCore,
    private session: string,
    private principal: string,
    private active: () => boolean,
    private inner?: DebuggerToolBridge
  ) {
    this.tools = [
      {
        name: 'lsp',
        description:
          'Language intelligence in this chat root: definition, hover, references, diagnostics. Positions are zero-based UTF-16. Requires an installed language server.',
        inputSchema: {
          type: 'object',
          properties: {
            operation: {
              type: 'string',
              enum: ['definition', 'hover', 'references', 'diagnostics'],
            },
            path: { type: 'string' },
            position: {
              type: 'object',
              properties: {
                line: { type: 'integer', minimum: 0 },
                character: { type: 'integer', minimum: 0 },
              },
              required: ['line', 'character'],
              additionalProperties: false,
            },
          },
          required: ['operation', 'path'],
          additionalProperties: false,
        },
      },
      ...(inner?.tools ?? []),
    ]
  }
  private check() {
    if (this.closed || !this.active()) throw new ChannelError('stale_run')
    this.core.checkExecution(this.principal, this.session)
    return this.core.resources.lsp.sessionRoot(this.session)
  }
  async call(name: string, args: unknown, signal?: AbortSignal) {
    if (name !== 'lsp') {
      if (!this.inner) throw new ChannelError('unsupported_method')
      return this.inner.call(name, args, signal)
    }
    const root = this.check()
    const p = z
      .object({
        operation: z.enum(['definition', 'hover', 'references', 'diagnostics']),
        path: RelativePathSchema.refine((p) => !!p),
        position: LspPositionSchema.optional(),
      })
      .strict()
      .parse(args)
    if (p.operation !== 'diagnostics' && !p.position) throw new ChannelError('invalid_params')
    const result = await this.core.resources.lsp.service.query(
      root,
      p.path,
      p.operation,
      p.position,
      signal
    )
    if (this.check() !== root) throw new ChannelError('stale_run')
    this.results.set(result, root)
    return result
  }
  publish(args: unknown, result: any) {
    const root = result && typeof result === 'object' ? this.results.get(result) : undefined
    if (root) {
      if (this.check() !== root) throw new ChannelError('stale_run')
      return result
    }
    if (!this.inner) throw new ChannelError('invalid_result')
    return this.inner.publish(args, result)
  }
  close() {
    this.closed = true
    this.inner?.close()
  }
}
