import {
  RepositoryGitMethodSchemas,
  RepositoryGitResultSchemas,
  type RepositoryGitMethod,
  type RepositoryGitParams,
  type RepositoryGitResult,
} from '@abele/node-protocol'

/**
 * Owner git writes on a repository target (`repository_git_write_v1`). Each write is a durable
 * mutation: keep the operation id until a receipt is known and retry with the same id; expected
 * git failures resolve as `{ state: 'failed', code, message, output }`. Never expose as model tools.
 */
export class RepositoryGitClient {
  constructor(
    private request: (method: string, params: unknown) => Promise<unknown>,
    private mutation?: (method: string, params: unknown, operation?: string) => Promise<unknown>
  ) {}
  private async write<M extends Exclude<RepositoryGitMethod, 'repository.v1.git.info'>>(
    method: M,
    params: RepositoryGitParams<M>,
    operation?: string
  ): Promise<RepositoryGitResult<M>> {
    if (!this.mutation) throw new Error('durable_client_required')
    const result = await this.mutation(
      method,
      RepositoryGitMethodSchemas[method].parse(params),
      operation
    )
    return RepositoryGitResultSchemas[method].parse(result) as RepositoryGitResult<M>
  }
  stage(params: RepositoryGitParams<'repository.v1.git.stage'>, operation?: string) {
    return this.write('repository.v1.git.stage', params, operation)
  }
  unstage(params: RepositoryGitParams<'repository.v1.git.unstage'>, operation?: string) {
    return this.write('repository.v1.git.unstage', params, operation)
  }
  /** Destructive: set `confirmed: true` only after the user confirmed exactly these paths. */
  discard(params: RepositoryGitParams<'repository.v1.git.discard'>, operation?: string) {
    return this.write('repository.v1.git.discard', params, operation)
  }
  commit(params: RepositoryGitParams<'repository.v1.git.commit'>, operation?: string) {
    return this.write('repository.v1.git.commit', params, operation)
  }
  /** Fetch the base branch and rebase onto it; conflicts come back as data. */
  update(params: RepositoryGitParams<'repository.v1.git.update'>, operation?: string) {
    return this.write('repository.v1.git.update', params, operation)
  }
  continue(params: RepositoryGitParams<'repository.v1.git.continue'>, operation?: string) {
    return this.write('repository.v1.git.continue', params, operation)
  }
  abort(params: RepositoryGitParams<'repository.v1.git.abort'>, operation?: string) {
    return this.write('repository.v1.git.abort', params, operation)
  }
  /** `force_with_lease`: the remote commit the user last saw (`info().upstream.commit`). */
  push(params: RepositoryGitParams<'repository.v1.git.push'>, operation?: string) {
    return this.write('repository.v1.git.push', params, operation)
  }
  /** Fetch one remote; prunes only with `prune: true`. Ahead/behind come back updated. */
  fetch(params: RepositoryGitParams<'repository.v1.git.fetch'>, operation?: string) {
    return this.write('repository.v1.git.fetch', params, operation)
  }
  /** New branch at a commit; `switch: true` (with `expected_head`) needs a clean worktree. */
  createBranch(params: RepositoryGitParams<'repository.v1.git.create_branch'>, operation?: string) {
    return this.write('repository.v1.git.create_branch', params, operation)
  }
  async info(params: RepositoryGitParams<'repository.v1.git.info'>) {
    return RepositoryGitResultSchemas['repository.v1.git.info'].parse(
      await this.request(
        'repository.v1.git.info',
        RepositoryGitMethodSchemas['repository.v1.git.info'].parse(params)
      )
    )
  }
}
