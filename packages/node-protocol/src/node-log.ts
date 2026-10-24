import { WireTimestampSchema, WireOffsetTimestampSchema } from '@abele/channel-protocol'
import { z } from 'zod'

export const NodeLogMethodSchemas = {
  'node.log.v1.tail': z
    .object({
      limit: z.number().int().min(1).max(1000).default(200),
      since: WireOffsetTimestampSchema.optional(),
      level: z.enum(['all', 'warnings_and_errors']).default('all'),
    })
    .strict(),
} as const
export const NodeLogTailSchema = z
  .object({
    lines: z
      .array(
        z
          .object({
            time: WireTimestampSchema.nullable(),
            level: z.enum(['debug', 'info', 'warn', 'error', 'unknown']),
            text: z.string().max(16 * 1024 * 1024),
            source: z.enum(['stdout', 'stderr']),
          })
          .strict()
      )
      .max(1000),
    truncated: z.boolean(),
    reason: z.enum(['logs_missing', 'logs_unavailable', 'empty', 'no_matching_lines']).optional(),
    files: z
      .array(
        z
          .object({
            source: z.enum(['stdout', 'stderr']),
            reason: z.enum(['missing', 'unavailable', 'rotated', 'empty']).optional(),
            truncated: z.boolean(),
          })
          .strict()
      )
      .max(2),
  })
  .strict()
export type NodeLogTail = z.infer<typeof NodeLogTailSchema>
