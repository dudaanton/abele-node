import { ChannelError } from '@abele/channel-protocol'
import {
  RepositoryMethodSchemas,
  RepositoryRevisionSchema,
  RepositoryRefsPageSchema,
  RepositoryTreePageSchema,
  RepositoryBlobSchema,
  RepositoryContentChunkSchema,
  RepositoryStatusPageSchema,
  RepositoryObservationSchema,
  RepositoryHistoryPageSchema,
  RepositoryCommitSchema,
  RepositoryComparisonSchema,
  RepositoryBlameSchema,
  RepositorySearchPageSchema,
  RepositoryWatchSchema,
  RepositoryUnwatchSchema,
  WorktreePageSchema,
  RepositoryEditingSchema,
  RepositoryMutationResultSchema,
  type RepositoryMethod,
  type RepositoryParams,
} from '@abele/node-protocol'

/** Versioned repository surface. Durable file saves, but no shell, provider admission or Git writes. */
export class RepositoryClient {
  constructor(
    private request: (method: string, params: unknown) => Promise<unknown>,
    private durable?: {
      mutation: (method: RepositoryMethod, params: unknown) => Promise<unknown>
      save: (
        method: RepositoryMethod,
        params: unknown,
        operation?: string
      ) => Promise<{ operation_id: string }>
      result: (operation: string) => Promise<{ result?: unknown; error?: string } | undefined>
    }
  ) {}
  private call<M extends RepositoryMethod>(method: M, params: RepositoryParams<M>) {
    return this.request(method, RepositoryMethodSchemas[method].parse(params))
  }
  /** Owner-only identity approval. Never expose this or saves directly as model tools. */
  async editing(params: RepositoryParams<'repository.v1.editing'>) {
    if (!this.durable) throw new Error('durable_client_required')
    return RepositoryEditingSchema.parse(
      await this.durable.mutation(
        'repository.v1.editing',
        RepositoryMethodSchemas['repository.v1.editing'].parse(params)
      )
    )
  }
  async editingStatus(params: RepositoryParams<'repository.v1.editing.get'>) {
    return RepositoryEditingSchema.parse(await this.call('repository.v1.editing.get', params))
  }
  write(params: RepositoryParams<'repository.v1.write'>, retainedOperationId?: string) {
    if (!this.durable) throw new Error('durable_client_required')
    return this.durable.save(
      'repository.v1.write',
      RepositoryMethodSchemas['repository.v1.write'].parse(params),
      retainedOperationId
    )
  }
  restore(params: RepositoryParams<'repository.v1.restore'>, retainedOperationId?: string) {
    if (!this.durable) throw new Error('durable_client_required')
    return this.durable.save(
      'repository.v1.restore',
      RepositoryMethodSchemas['repository.v1.restore'].parse(params),
      retainedOperationId
    )
  }
  async mutationResult(operation_id: string) {
    if (!this.durable) throw new Error('durable_client_required')
    const receipt = await this.durable.result(operation_id)
    if (receipt?.error) throw new ChannelError(receipt.error)
    return receipt ? RepositoryMutationResultSchema.parse(receipt.result) : undefined
  }
  async readRecovery(params: RepositoryParams<'repository.v1.recovery.read'>) {
    return RepositoryContentChunkSchema.parse(
      await this.call('repository.v1.recovery.read', params)
    )
  }
  async worktrees(params: RepositoryParams<'repository.v1.worktrees'>) {
    return WorktreePageSchema.parse(await this.call('repository.v1.worktrees', params))
  }
  async refs(params: RepositoryParams<'repository.v1.refs'>) {
    return RepositoryRefsPageSchema.parse(await this.call('repository.v1.refs', params))
  }
  async resolve(params: RepositoryParams<'repository.v1.resolve'>) {
    return RepositoryRevisionSchema.parse(await this.call('repository.v1.resolve', params))
  }
  async observe(params: RepositoryParams<'repository.v1.observe'>) {
    return RepositoryObservationSchema.parse(await this.call('repository.v1.observe', params))
  }
  async status(params: RepositoryParams<'repository.v1.status'>) {
    return RepositoryStatusPageSchema.parse(await this.call('repository.v1.status', params))
  }
  async tree(params: RepositoryParams<'repository.v1.tree'>) {
    return RepositoryTreePageSchema.parse(await this.call('repository.v1.tree', params))
  }
  async blob(params: RepositoryParams<'repository.v1.blob'>) {
    return RepositoryBlobSchema.parse(await this.call('repository.v1.blob', params))
  }
  async content(params: RepositoryParams<'repository.v1.content'>) {
    return RepositoryContentChunkSchema.parse(await this.call('repository.v1.content', params))
  }
  async history(params: RepositoryParams<'repository.v1.history'>) {
    return RepositoryHistoryPageSchema.parse(await this.call('repository.v1.history', params))
  }
  async commit(params: RepositoryParams<'repository.v1.commit'>) {
    return RepositoryCommitSchema.parse(await this.call('repository.v1.commit', params))
  }
  async compare(params: RepositoryParams<'repository.v1.compare'>) {
    return RepositoryComparisonSchema.parse(await this.call('repository.v1.compare', params))
  }
  async patch(params: RepositoryParams<'repository.v1.patch'>) {
    return RepositoryBlobSchema.parse(await this.call('repository.v1.patch', params))
  }
  async blame(params: RepositoryParams<'repository.v1.blame'>) {
    return RepositoryBlameSchema.parse(await this.call('repository.v1.blame', params))
  }
  async search(params: RepositoryParams<'repository.v1.search'>) {
    return RepositorySearchPageSchema.parse(await this.call('repository.v1.search', params))
  }
  async watch(params: RepositoryParams<'repository.v1.watch'>) {
    return RepositoryWatchSchema.parse(await this.call('repository.v1.watch', params))
  }
  async unwatch(params: RepositoryParams<'repository.v1.unwatch'>) {
    return RepositoryUnwatchSchema.parse(await this.call('repository.v1.unwatch', params))
  }
}
export type {
  RepositoryRevision,
  WorktreeEntry,
  RepositoryMethod,
  RepositoryParams,
} from '@abele/node-protocol'
