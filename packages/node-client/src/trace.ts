import {
  TraceFolderResultSchema,
  TraceHitsResultSchema,
  TraceMethodSchemas,
  TracePointsResultSchema,
  TraceRunResultSchema,
  TraceRunsResultSchema,
  TraceStatusResultSchema,
  TraceTrailSchema,
  TraceValueResultSchema,
} from '@abele/node-protocol'

type Methods = typeof TraceMethodSchemas
type Input<M extends keyof Methods> = Methods[M]['_input']

/** The owner's view of recorded runs. Online-only reads and owner edits; nothing is queued. */
export class TraceClient {
  constructor(private readonly rpc: (method: string, params: unknown) => Promise<unknown>) {}
  private call<M extends keyof Methods>(method: M, params: Input<M>) {
    return this.rpc(method, TraceMethodSchemas[method].parse(params))
  }
  async points(debug_session_id: string) {
    return TracePointsResultSchema.parse(
      await this.call('trace.v1.points.list', { debug_session_id })
    ).points
  }
  async setPoints(params: Input<'trace.v1.points.set'>) {
    return TracePointsResultSchema.parse(await this.call('trace.v1.points.set', params)).points
  }
  async status(debug_session_id: string) {
    return TraceStatusResultSchema.parse(await this.call('trace.v1.status', { debug_session_id }))
  }
  async folder(project_id: string) {
    return TraceFolderResultSchema.parse(await this.call('trace.v1.folder.get', { project_id }))
  }
  async setFolder(project_id: string, folder: string) {
    return TraceFolderResultSchema.parse(
      await this.call('trace.v1.folder.set', { project_id, folder })
    )
  }
  async runs(project_id: string) {
    return TraceRunsResultSchema.parse(await this.call('trace.v1.runs', { project_id }))
  }
  async run(params: Input<'trace.v1.run'>) {
    return TraceRunResultSchema.parse(await this.call('trace.v1.run', params))
  }
  async value(params: Input<'trace.v1.value'>) {
    return TraceValueResultSchema.parse(await this.call('trace.v1.value', params))
  }
  async find(params: Input<'trace.v1.find'>) {
    return TraceHitsResultSchema.parse(await this.call('trace.v1.find', params)).hits
  }
  async follow(params: Input<'trace.v1.follow'>) {
    return TraceTrailSchema.parse(await this.call('trace.v1.follow', params))
  }
  mark(params: Input<'trace.v1.mark'>) {
    return this.call('trace.v1.mark', params)
  }
  rename(params: Input<'trace.v1.rename'>) {
    return this.call('trace.v1.rename', params)
  }
  delete(params: Input<'trace.v1.delete'>) {
    return this.call('trace.v1.delete', params)
  }
}
