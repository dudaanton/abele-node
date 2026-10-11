import {
  NodePathMethodSchemas,
  MethodSchemas,
  SessionSchema,
  SessionTargetSchema,
  SessionTargetSetSchema,
  ExecutionGrantSchema,
  DirectoryPageSchema,
  FileOperationResultSchema,
  DirectoryCreatedSchema,
  DivergenceSchema,
  WorktreeDeletionSchema,
  WorkspaceJobResultSchema,
  WorktreeSelectionSchema,
  ProjectSchema,
  ResourceMethodSchemas,
  RepositoryWatchSchema,
  RepositorySearchPageSchema,
  RepositoryUnwatchSchema,
  type NodePathMethod,
  type NodePathParams,
} from '@abele/node-protocol'
import type { z } from 'zod'

/** Typed node-path owner surface. Mutations await receipts; retain the ID on uncertain outcomes. */
export class NodePathClient {
  constructor(
    private request: (method: string, params: unknown) => Promise<unknown>,
    private mutation: (method: string, params: unknown, operation?: string) => Promise<unknown>
  ) {}
  private call<M extends NodePathMethod>(method: M, params: NodePathParams<M>) {
    return this.request(method, NodePathMethodSchemas[method].parse(params))
  }
  private mutate<M extends NodePathMethod>(
    method: M,
    params: NodePathParams<M>,
    operation?: string
  ) {
    return this.mutation(method, NodePathMethodSchemas[method].parse(params), operation)
  }
  async trust(params: NodePathParams<'project.trust'>, operation?: string) {
    return ProjectSchema.parse(await this.mutate('project.trust', params, operation))
  }
  async execution(params: NodePathParams<'project.execution'>, operation?: string) {
    return ExecutionGrantSchema.parse(await this.mutate('project.execution', params, operation))
  }
  async createSession(
    params: z.input<(typeof MethodSchemas)['session.create']>,
    operation?: string
  ) {
    return SessionSchema.parse(
      await this.mutation(
        'session.create',
        MethodSchemas['session.create'].parse(params),
        operation
      )
    )
  }
  async sessionWorktreeGet(params: NodePathParams<'session.worktree.get'>) {
    return SessionTargetSchema.parse(await this.call('session.worktree.get', params))
  }
  async sessionWorktreeSet(params: NodePathParams<'session.worktree.set'>, operation?: string) {
    return SessionTargetSetSchema.parse(
      await this.mutate('session.worktree.set', params, operation)
    )
  }
  async directories(params: NodePathParams<'filesystem.v1.directories'> = {}) {
    return DirectoryPageSchema.parse(await this.call('filesystem.v1.directories', params))
  }
  async mkdir(params: NodePathParams<'filesystem.v1.mkdir'>, operation?: string) {
    return DirectoryCreatedSchema.parse(await this.mutate('filesystem.v1.mkdir', params, operation))
  }
  async register(
    params: z.input<(typeof ResourceMethodSchemas)['project.register']>,
    operation?: string
  ) {
    return ProjectSchema.parse(
      await this.mutation(
        'project.register',
        ResourceMethodSchemas['project.register'].parse(params),
        operation
      )
    )
  }
  async gitInit(params: NodePathParams<'project.git_init'>, operation?: string) {
    return ProjectSchema.parse(await this.mutate('project.git_init', params, operation))
  }
  async worktreeSelection(
    params: NodePathParams<'project.worktree_selection'>,
    operation?: string
  ) {
    return WorktreeSelectionSchema.parse(
      await this.mutate('project.worktree_selection', params, operation)
    )
  }
  async divergence(params: NodePathParams<'repository.v1.divergence'>) {
    return DivergenceSchema.parse(await this.call('repository.v1.divergence', params))
  }
  async fileMove(
    params: NodePathParams<'workspace.file.move'> | NodePathParams<'repository.v1.file.move'>,
    operation?: string
  ) {
    return FileOperationResultSchema.parse(
      await this.mutate(
        'worktree_id' in params ? 'repository.v1.file.move' : 'workspace.file.move',
        params,
        operation
      )
    )
  }
  async fileCopy(
    params: NodePathParams<'workspace.file.copy'> | NodePathParams<'repository.v1.file.copy'>,
    operation?: string
  ) {
    return FileOperationResultSchema.parse(
      await this.mutate(
        'worktree_id' in params ? 'repository.v1.file.copy' : 'workspace.file.copy',
        params,
        operation
      )
    )
  }
  async fileRemove(
    params: NodePathParams<'workspace.file.remove'> | NodePathParams<'repository.v1.file.remove'>,
    operation?: string
  ) {
    return FileOperationResultSchema.parse(
      await this.mutate(
        'worktree_id' in params ? 'repository.v1.file.remove' : 'workspace.file.remove',
        params,
        operation
      )
    )
  }
  async fileMkdir(
    params: NodePathParams<'workspace.file.mkdir'> | NodePathParams<'repository.v1.file.mkdir'>,
    operation?: string
  ) {
    return FileOperationResultSchema.parse(
      await this.mutate(
        'worktree_id' in params ? 'repository.v1.file.mkdir' : 'workspace.file.mkdir',
        params,
        operation
      )
    )
  }
  async createWorkspace(
    params: z.input<(typeof ResourceMethodSchemas)['workspace.create']>,
    operation?: string
  ) {
    return WorkspaceJobResultSchema.parse(
      await this.mutation(
        'workspace.create',
        ResourceMethodSchemas['workspace.create'].parse(params),
        operation
      )
    )
  }
  async deleteWorktree(
    params: NodePathParams<'repository.v1.worktree.delete'>,
    operation?: string
  ) {
    return WorktreeDeletionSchema.parse(
      await this.mutate('repository.v1.worktree.delete', params, operation)
    )
  }
  async search(params: NodePathParams<'workspace.search'>) {
    return RepositorySearchPageSchema.parse(await this.call('workspace.search', params))
  }
  async watch(params: NodePathParams<'workspace.watch'>) {
    return RepositoryWatchSchema.parse(await this.call('workspace.watch', params))
  }
  async unwatch(params: NodePathParams<'workspace.unwatch'>) {
    return RepositoryUnwatchSchema.parse(await this.call('workspace.unwatch', params))
  }
}
export type { NodePathMethod, NodePathParams } from '@abele/node-protocol'
