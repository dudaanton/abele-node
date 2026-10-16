import { z } from 'zod'
import { RelativePathSchema } from './files.js'
export const LSP_VERSION = 1 as const
export const LspPositionSchema = z
  .object({
    line: z.number().int().min(0).max(1000000),
    character: z.number().int().min(0).max(1000000),
  })
  .strict()
export const LspRangeSchema = z
  .object({ start: LspPositionSchema, end: LspPositionSchema })
  .strict()
export const LspDiagnosticSchema = z
  .object({
    range: LspRangeSchema,
    message: z.string().max(4096),
    source: z.string().max(128),
    severity: z.number().int().min(1).max(4).optional(),
    code: z.union([z.string().max(256), z.number()]).optional(),
  })
  .strict()
export type LspDiagnostic = z.infer<typeof LspDiagnosticSchema>
const root = {
  workspace_id: z.string().min(1).max(128).optional(),
  worktree_id: z.string().min(1).max(128).optional(),
  request_id: z.string().min(1).max(128).optional(),
}
const document = { ...root, path: RelativePathSchema.refine((p) => !!p) }
export const LspMethodSchemas = {
  'lsp.v1.cancel': z.object({ request_id: z.string().min(1).max(128) }).strict(),
  'lsp.v1.status': z.object(root).strict(),
  'lsp.v1.install': z
    .object({
      languages: z.array(z.string().min(1).max(32)).min(1).max(16),
      request_id: z.string().min(1).max(128).optional(),
    })
    .strict(),
  'lsp.v1.open': z
    .object({
      ...document,
      text: z
        .string()
        .max(512 * 1024)
        .optional(),
      version: z.number().int().min(0).optional(),
    })
    .strict(),
  'lsp.v1.close': z.object(document).strict(),
  'lsp.v1.diagnostics': z.object(document).strict(),
  'lsp.v1.hover': z.object({ ...document, position: LspPositionSchema }).strict(),
  'lsp.v1.definition': z.object({ ...document, position: LspPositionSchema }).strict(),
  'lsp.v1.references': z.object({ ...document, position: LspPositionSchema }).strict(),
  'lsp.v1.symbols': z.object(document).strict(),
}
export const LspDiagnosticsSchema = z
  .object({
    workspace_id: z.string().optional(),
    worktree_id: z.string().optional(),
    path: RelativePathSchema,
    diagnostics: z.array(LspDiagnosticSchema).max(256),
  })
  .strict()
export const LspLocationSchema = z
  .object({ path: RelativePathSchema, range: LspRangeSchema })
  .strict()
export type LspLocation = z.infer<typeof LspLocationSchema>
export const LspLocationsResultSchema = z
  .object({ locations: z.array(LspLocationSchema).max(128) })
  .strict()
export const LspDiagnosticsResultSchema = z
  .object({ diagnostics: z.array(LspDiagnosticSchema).max(256) })
  .strict()
export const LspHoverResultSchema = z
  .object({ text: z.string().max(16384), range: LspRangeSchema.optional() })
  .strict()
export const LspSymbolsResultSchema = z
  .object({
    symbols: z
      .array(
        z
          .object({ name: z.string().max(256), kind: z.number().int(), range: LspRangeSchema })
          .strict()
      )
      .max(128),
  })
  .strict()
export const LspStatusSchema = z
  .array(
    z
      .object({
        language: z.string(),
        server: z.string().nullable(),
        version: z.string().nullable(),
        found: z.boolean(),
        reason: z.literal('untrusted_folder').optional(),
        project_eslint: z.string().optional(),
      })
      .strict()
  )
  .max(16)
export const LspInstallResultSchema = z
  .array(z.object({ language: z.string(), message: z.string() }).strict())
  .max(16)
export const LspOpenResultSchema = z.object({ servers: z.array(z.string()).max(16) }).strict()
