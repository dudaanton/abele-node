import { z } from 'zod'
import { IdentitySchema } from './wire.js'
export const ShellMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ready'), evidence: IdentitySchema }).strict(),
  z.object({ kind: z.literal('output'), base64: z.string().max(128 * 1024) }).strict(),
  z.object({ kind: z.literal('result'), exit_code: z.number().multipleOf(1).nullable() }).strict(),
  z.object({ kind: z.literal('error') }).strict(),
])
export const ShellStartSchema = z
  .object({
    kind: z.literal('execute'),
    cwd: z.string().min(1).max(4096),
    shell: z.string().min(1).max(4096),
    command: z.string().max(128 * 1024),
    env: z
      .record(
        z.string().max(16 * 1024 * 1024),
        z
          .string()
          .max(16 * 1024 * 1024)
          .optional()
      )
      .optional(),
  })
  .strict()
