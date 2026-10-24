import { z } from 'zod'
import { RelativePathSchema } from './files.js'
const id = z.string().min(1).max(128)
export const ChatFileChangeSchema = z
  .object({
    path: RelativePathSchema,
    current: z
      .string()
      .max(16 * 1024 * 1024)
      .regex(/^[a-f0-9]{64}$/),
    checkpoint: z
      .string()
      .max(16 * 1024 * 1024)
      .regex(/^[a-f0-9]{64}$/),
  })
  .strict()
const checkpoint = { session_id: id, checkpoint_id: id }
export const ChatMethodSchemas = {
  'chat.checkpoints': z.object({ session_id: id }).strict(),
  'chat.preview': z.object(checkpoint).strict(),
  'chat.restore': z
    .object({
      ...checkpoint,
      action: z.enum(['rewind', 'branch', 'edit', 'retry']),
      text: z.string().min(1).max(32768).optional(),
      restore_files: z
        .object({
          preview_id: z
            .string()
            .max(16 * 1024 * 1024)
            .regex(/^[a-f0-9]{64}$/),
          changes: z.array(ChatFileChangeSchema).max(4096),
        })
        .strict()
        .optional(),
    })
    .strict(),
} as const
export type ChatRestoreRequest = z.infer<(typeof ChatMethodSchemas)['chat.restore']>
export const ChatCheckpointSchema = z.object({
  checkpoint_id: id,
  input_id: id,
  before_seq: z.number().multipleOf(1).min(0),
  exclude_input_ids: z.array(id).max(65536),
})
export const ChatPreviewSchema = z.object({
  preview_id: z.string().length(64),
  changes: z.array(ChatFileChangeSchema).max(65536),
  files: z
    .array(
      z.object({
        path: RelativePathSchema,
        before_base64: z
          .string()
          .max(16 * 1024 * 1024)
          .nullable(),
        after_base64: z
          .string()
          .max(16 * 1024 * 1024)
          .nullable(),
        before_mode: z.number().nullable(),
        after_mode: z.number().nullable(),
        truncated: z.boolean(),
      })
    )
    .max(65536),
})
export const ChatRestoreResultSchema = z.object({
  session_id: id,
  input: z.object({ input_id: id, accepted_seq: z.number().multipleOf(1).min(0) }).optional(),
})
