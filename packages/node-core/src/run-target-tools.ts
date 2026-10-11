import { z } from 'zod'
import { ChannelError, type AuthorityContext } from '@abele/channel-protocol'
import { ExecutionTargetSchema } from '@abele/node-protocol'
import type { DebuggerToolBridge } from '@abele/provider-contract'
import type { NodeCore } from './index.js'
/** Multiplex through the existing trusted run IPC; models never supply session/run/authority. */
export class RunTargetTools implements DebuggerToolBridge {
  private closed = false
  private results = new WeakMap<object, string>()
  readonly tools: DebuggerToolBridge['tools']
  private generation: string
  constructor(
    private core: NodeCore,
    private actor: AuthorityContext,
    private session: string,
    private run: string,
    private active: () => boolean,
    private debuggerTools?: DebuggerToolBridge
  ) {
    const binding = core.resources.targets.bound(session)
    if (!binding) throw new ChannelError('workspace_required')
    this.generation = binding.generation
    this.tools = [
      {
        name: 'node_worktree_switch',
        description:
          'Schedule this chat to move to an approved target in its folder after the current turn is cleaned up. Pending is not applied.',
        inputSchema: {
          type: 'object',
          properties: {
            target: {
              oneOf: [
                {
                  type: 'object',
                  properties: { kind: { const: 'workspace' }, workspace_id: { type: 'string' } },
                  required: ['kind', 'workspace_id'],
                  additionalProperties: false,
                },
                {
                  type: 'object',
                  properties: { kind: { const: 'worktree' }, worktree_id: { type: 'string' } },
                  required: ['kind', 'worktree_id'],
                  additionalProperties: false,
                },
              ],
            },
          },
          required: ['target'],
          additionalProperties: false,
        },
      },
      {
        name: 'node_worktrees',
        description: 'List targets in this chat folder. Discovery is not execution approval.',
        inputSchema: {
          type: 'object',
          properties: { cursor: { type: 'string', maxLength: 128 } },
          additionalProperties: false,
        },
      },
      ...(debuggerTools?.tools ?? []),
    ]
  }
  private check() {
    if (
      this.closed ||
      !this.active() ||
      this.core.resources.targets.bound(this.session)?.generation !== this.generation
    )
      throw new ChannelError('stale_run')
    this.core.checkExecution(this.actor.installation_id, this.session)
  }
  async call(name: string, args: unknown, signal?: AbortSignal) {
    this.check()
    if (signal?.aborted) throw new ChannelError('cancelled')
    if (name !== 'node_worktree_switch' && name !== 'node_worktrees') {
      if (!this.debuggerTools) throw new ChannelError('unsupported_method')
      return this.debuggerTools.call(name, args, signal)
    }
    let result: object
    if (name === 'node_worktree_switch') {
      const parsed = z.object({ target: ExecutionTargetSchema }).strict().safeParse(args)
      if (!parsed.success) throw new ChannelError('invalid_params')
      result = await this.core.resources.targets.schedule(
        this.actor,
        this.session,
        this.run,
        this.generation,
        parsed.data.target,
        () => !this.closed && this.active() && !signal?.aborted
      )
    } else {
      const parsed = z
        .object({ cursor: z.string().min(1).max(128).optional() })
        .strict()
        .safeParse(args)
      if (!parsed.success) throw new ChannelError('invalid_params')
      const binding = this.core.resources.targets.bound(this.session)!
      const project = this.core.resources.projects.get(binding.project_id)
      result = project.repository_path
        ? ((await this.core.resources.repository.request(this.actor, 'repository.v1.worktrees', {
            project_id: project.project_id,
            limit: 256,
            ...(parsed.data.cursor ? { cursor: parsed.data.cursor } : {}),
          })) as object)
        : {
            entries: [{ target: binding.target, path_label: 'folder' }],
            cursor: null,
            incomplete: false,
            omissions: [],
          }
    }
    this.check()
    this.results.set(result, name)
    return result
  }
  publish(args: unknown, result: any) {
    this.check()
    if (result && typeof result === 'object' && this.results.has(result)) {
      const binding = this.core.resources.targets.bound(this.session)!
      if (
        this.results.get(result) === 'node_worktrees' &&
        this.core.resources.projects.get(binding.project_id).repository_path
      )
        this.core.resources.repository.checkPublication(
          this.actor,
          { project_id: binding.project_id },
          result
        )
      if (this.results.get(result) === 'node_worktree_switch')
        this.core.resources.targets.checkScheduled(this.session, this.run)
      return result
    }
    if (!this.debuggerTools) throw new ChannelError('invalid_result')
    return this.debuggerTools.publish(args, result)
  }
  close() {
    this.closed = true
    this.debuggerTools?.close()
  }
}
