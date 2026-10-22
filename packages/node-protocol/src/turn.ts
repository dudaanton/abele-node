import { z } from 'zod'
import { Id, Sequence } from '@abele/channel-protocol'

export const ExecutionTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('workspace'), workspace_id: Id }).strict(),
  z.object({ kind: z.literal('worktree'), worktree_id: Id }).strict(),
])
export type ExecutionTarget = z.infer<typeof ExecutionTargetSchema>
/** Opaque incarnation of the displayed session binding, not a path or Git revision. */
export const ExpectedExecutionTargetSchema = z
  .object({ target: ExecutionTargetSchema, incarnation: Id })
  .strict()
export type ExpectedExecutionTarget = z.infer<typeof ExpectedExecutionTargetSchema>
/** A durable operation receipt. No input or turn is created on refusal. */
export const TargetChangedRefusalSchema = z
  .object({
    code: z.literal('target_changed'),
    current_target: ExpectedExecutionTargetSchema.nullable(),
  })
  .strict()
export type TargetChangedRefusal = z.infer<typeof TargetChangedRefusalSchema>
export const TurnAcceptedSchema = z.object({ input_id: Id, accepted_seq: Sequence }).strict()
export const OwnerRestartRequiredSchema = z
  .object({
    code: z.literal('owner_restart_required'),
    session_id: Id,
    reason: z.literal('stopped_by_owner'),
    stop_generation: Sequence,
  })
  .strict()
export const TurnAdmissionResultSchema = z.union([
  TurnAcceptedSchema,
  TargetChangedRefusalSchema,
  OwnerRestartRequiredSchema,
])
export type TurnAdmissionResult = z.infer<typeof TurnAdmissionResultSchema>
