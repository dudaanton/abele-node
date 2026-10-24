/** Recorded runs over the debugger: record points, the runs folder, runs and the views of their
 * values. Owner-only methods; every view is bounded by the node, never by the caller alone. */
import { z } from 'zod'

const id = z.string().min(1).max(128)
const runId = z
  .string()
  .max(16 * 1024 * 1024)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/)
const stepId = z
  .string()
  .max(16 * 1024 * 1024)
  .regex(/^t\d{4,9}$/)
const name = z.string().min(1).max(256)
const path = z.string().min(1).max(1024)

export const TRACE_VERSION = 1 as const
export const TRACE_V1_CAPABILITY = {
  bound_record_points: true,
  fixed_prefix_paging: true,
  scalar_briefs: true,
  sent_observation_merge: true,
  discovery_probe_suppression: true,
  status: 'supported' as const,
  evidence:
    'record-points-stop-and-continue; runs-on-disk; shape-slice-diff-find-follow; owner-only; bounded-views',
}

export const TracePointSchema = z
  .object({
    breakpoint_id: id,
    /** Names in scope or expressions, `expr as name`; none takes the frame's locals. */
    take: z.array(z.string().min(1).max(1024)).max(32),
    note: z.string().max(200).optional(),
  })
  .strict()
export type TracePointInput = z.infer<typeof TracePointSchema>

export const TraceShapeSchema: z.ZodType<TraceShape> = z.lazy(() =>
  z
    .object({
      key: z
        .string()
        .max(16 * 1024 * 1024)
        .optional(),
      type: z.string().max(16 * 1024 * 1024),
      count: z.number().multipleOf(1).optional(),
      optional: z.boolean().optional(),
      example: z
        .string()
        .max(16 * 1024 * 1024)
        .optional(),
      children: z.array(TraceShapeSchema).max(65536).optional(),
    })
    .strict()
)
export interface TraceShape {
  key?: string
  type: string
  count?: number
  optional?: boolean
  example?: string
  children?: TraceShape[]
}

export const TraceValueMetaSchema = z
  .object({
    name: z.string().max(16 * 1024 * 1024),
    format: z.enum(['json', 'xml', 'text', 'number']),
    bytes: z.number().multipleOf(1).nonnegative(),
    brief: z.string().max(16 * 1024 * 1024),
    /** The same content as the value of that name at the step before. */
    same: z.boolean().optional(),
    masked: z.boolean().optional(),
    failed: z
      .string()
      .max(16 * 1024 * 1024)
      .optional(),
  })
  .strict()
export type TraceValueMeta = z.infer<typeof TraceValueMetaSchema>

export const TraceStepSchema = z
  .object({
    id: z.string().max(16 * 1024 * 1024),
    kind: z.enum(['probe', 'error', 'http', 'browser-lost']),
    ts: z.string().max(16 * 1024 * 1024),
    at: z.number(),
    label: z.string().max(16 * 1024 * 1024),
    point: z
      .string()
      .max(16 * 1024 * 1024)
      .optional(),
    place: z
      .object({
        file: z.string().max(16 * 1024 * 1024),
        line: z.number().multipleOf(1),
        fn: z
          .string()
          .max(16 * 1024 * 1024)
          .optional(),
      })
      .strict()
      .optional(),
    stack: z
      .array(z.string().max(16 * 1024 * 1024))
      .max(65536)
      .optional(),
    paused_ms: z.number().optional(),
    status: z.number().multipleOf(1).optional(),
    host: z
      .string()
      .max(16 * 1024 * 1024)
      .optional(),
    direction: z.enum(['incoming', 'outgoing']).optional(),
    duration_ms: z.number().nonnegative().optional(),
    chain: z
      .string()
      .max(16 * 1024 * 1024)
      .optional(),
    /** Under its request only because it ran while the request was out. */
    by_time: z.boolean().optional(),
    /** A request sent from the project's saved requests. */
    sent: z.boolean().optional(),
    marked: z.boolean().optional(),
    values: z.array(TraceValueMetaSchema).max(65536),
  })
  .strict()
export type TraceStep = z.infer<typeof TraceStepSchema>

export const TraceRunSummarySchema = z
  .object({
    id: z.string().max(16 * 1024 * 1024),
    name: z.string().max(16 * 1024 * 1024),
    debug_session_id: z.string().max(16 * 1024 * 1024),
    started_at: z.string().max(16 * 1024 * 1024),
    length_ms: z.number().optional(),
    state: z.enum(['recording', 'done', 'cut']),
    steps: z.number().multipleOf(1),
    bytes: z.number().multipleOf(1),
  })
  .strict()
export type TraceRunSummary = z.infer<typeof TraceRunSummarySchema>

export const TracePointCopySchema = z
  .object({
    breakpoint_id: z.string().max(16 * 1024 * 1024),
    file: z.string().max(16 * 1024 * 1024),
    line: z.number().multipleOf(1),
    take: z.array(z.string().max(16 * 1024 * 1024)).max(65536),
    when: z
      .string()
      .max(16 * 1024 * 1024)
      .optional(),
    note: z
      .string()
      .max(16 * 1024 * 1024)
      .optional(),
    /** How many steps it gave in this run. */
    hits: z.number().multipleOf(1),
    /** What it took the last time, in a line. */
    last: z
      .string()
      .max(16 * 1024 * 1024)
      .optional(),
  })
  .strict()

export const TraceMarkSchema = z
  .object({
    step: z.string().max(16 * 1024 * 1024),
    name: z
      .string()
      .max(16 * 1024 * 1024)
      .optional(),
    path: z
      .string()
      .max(16 * 1024 * 1024)
      .optional(),
    comment: z.string().max(16 * 1024 * 1024),
    tags: z
      .array(z.string().max(16 * 1024 * 1024))
      .max(65536)
      .optional(),
    at: z
      .string()
      .max(16 * 1024 * 1024)
      .optional(),
  })
  .strict()

export const TraceRunResultSchema = z
  .object({
    run: TraceRunSummarySchema,
    points: z.array(TracePointCopySchema).max(65536),
    steps: z.array(TraceStepSchema).max(65536),
    /** Where the next page of steps starts, when there is one. */
    next: z.number().multipleOf(1).optional(),
    marks: z.array(TraceMarkSchema).max(65536),
    folder: z.string().max(16 * 1024 * 1024),
  })
  .strict()
export type TraceRunResult = z.infer<typeof TraceRunResultSchema>

export const TracePageSchema = z
  .object({
    lines: z.array(z.string().max(16 * 1024 * 1024)).max(65536),
    next: z.number().multipleOf(1).optional(),
    truncated: z.boolean(),
    total: z.number().multipleOf(1),
  })
  .strict()

export const TraceChangeSchema = z
  .object({
    path: z.string().max(16 * 1024 * 1024),
    kind: z.enum(['added', 'removed', 'type', 'value']),
    before: z
      .string()
      .max(16 * 1024 * 1024)
      .optional(),
    after: z
      .string()
      .max(16 * 1024 * 1024)
      .optional(),
    count: z.number().multipleOf(1),
  })
  .strict()

export const TraceValueResultSchema = z
  .object({
    value: TraceValueMetaSchema,
    shape: TraceShapeSchema.optional(),
    page: TracePageSchema.optional(),
    changes: z
      .object({
        against: z
          .object({
            step: z.string().max(16 * 1024 * 1024),
            name: z.string().max(16 * 1024 * 1024),
          })
          .strict(),
        summary: z.string().max(16 * 1024 * 1024),
        changes: z.array(TraceChangeSchema).max(65536),
      })
      .strict()
      .optional(),
  })
  .strict()
export type TraceValueResult = z.infer<typeof TraceValueResultSchema>

export const TraceHitSchema = z
  .object({
    step: z.string().max(16 * 1024 * 1024),
    name: z.string().max(16 * 1024 * 1024),
    path: z.string().max(16 * 1024 * 1024),
  })
  .strict()

export const TraceTrailSchema = z
  .object({
    value: z.string().max(16 * 1024 * 1024),
    stops: z
      .array(
        z
          .object({
            step: z.string().max(16 * 1024 * 1024),
            name: z.string().max(16 * 1024 * 1024),
            path: z.string().max(16 * 1024 * 1024),
            change: z
              .string()
              .max(16 * 1024 * 1024)
              .optional(),
          })
          .strict()
      )
      .max(65536),
    lost_after: z
      .string()
      .max(16 * 1024 * 1024)
      .optional(),
  })
  .strict()
export type TraceTrail = z.infer<typeof TraceTrailSchema>

const project = { project_id: id }
const run = { ...project, run_id: runId }
const cap = z.enum(['panel', 'agent']).default('panel')
const needle = z.union([z.string().max(4096), z.number(), z.boolean()])

export const TraceMethodSchemas = {
  'trace.v1.points.list': z.object({ debug_session_id: id }).strict(),
  'trace.v1.points.set': z
    .object({
      debug_session_id: id,
      upsert: z.array(TracePointSchema).max(256),
      remove: z.array(id).max(256),
    })
    .strict(),
  'trace.v1.status': z.object({ debug_session_id: id }).strict(),
  'trace.v1.folder.get': z.object(project).strict(),
  /** An absolute folder, or one relative to the project; empty goes back to the default. */
  'trace.v1.folder.set': z.object({ ...project, folder: z.string().max(4096) }).strict(),
  'trace.v1.runs': z.object(project).strict(),
  'trace.v1.run': z
    .object({
      ...run,
      from: z.number().multipleOf(1).min(0).optional(),
      through: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
      kind: z
        .array(z.enum(['probe', 'error', 'http', 'browser-lost']))
        .max(4)
        .optional(),
      limit: z.number().int().min(1).max(5000).optional(),
    })
    .strict(),
  'trace.v1.value': z
    .object({
      ...run,
      step: stepId,
      name,
      view: z.enum(['shape', 'page', 'slice', 'changes']),
      path: path.optional(),
      from: z.number().multipleOf(1).min(0).optional(),
      against: z.object({ step: stepId, name }).strict().optional(),
      cap,
    })
    .strict(),
  'trace.v1.find': z
    .object({
      ...run,
      value: needle.optional(),
      key: z.string().min(1).max(256).optional(),
      loose: z.boolean().optional(),
    })
    .strict(),
  'trace.v1.follow': z.object({ ...run, value: needle, loose: z.boolean().optional() }).strict(),
  'trace.v1.mark': z
    .object({
      ...run,
      step: stepId,
      name: name.optional(),
      path: path.optional(),
      comment: z.string().max(4096),
      tags: z.array(z.string().min(1).max(64)).max(16).optional(),
    })
    .strict(),
  'trace.v1.rename': z.object({ ...run, name: z.string().min(1).max(200) }).strict(),
  'trace.v1.delete': z.object(run).strict(),
} as const
export type TraceMethod = keyof typeof TraceMethodSchemas

export const TraceFolderResultSchema = z
  .object({ folder: z.string().max(16 * 1024 * 1024), chosen: z.boolean() })
  .strict()
export const TraceStatusResultSchema = TraceFolderResultSchema.extend({
  recording: z
    .object({
      run_id: z.string().max(16 * 1024 * 1024),
      steps: z.number().multipleOf(1),
      started_at: z.string().max(16 * 1024 * 1024),
    })
    .strict()
    .nullable(),
}).strict()
export const TracePointsResultSchema = z
  .object({ points: z.array(TracePointSchema).max(65536) })
  .strict()
export const TraceRunsResultSchema = TraceFolderResultSchema.extend({
  runs: z.array(TraceRunSummarySchema).max(65536),
}).strict()
export const TraceHitsResultSchema = z.object({ hits: z.array(TraceHitSchema).max(65536) }).strict()
