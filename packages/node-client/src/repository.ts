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
  type RepositoryMethod,
  type RepositoryParams,
} from '@abele/node-protocol'

/** Versioned read surface. No shell, provider admission, worktree lifecycle, or Git writes. */
export class RepositoryClient {
  constructor(private request: (method: string, params: unknown) => Promise<unknown>) {}
  private call<M extends RepositoryMethod>(method: M, params: RepositoryParams<M>) {
    return this.request(method, RepositoryMethodSchemas[method].parse(params))
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
