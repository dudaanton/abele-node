import { z } from 'zod'

const id = z.string().min(1).max(128)
// UTF-16 bound also bounds UTF-8 to at most 256 KiB.
const json = z.record(z.unknown()).refine((v) => JSON.stringify(v).length <= 65536)
export const ObsidianToolSchema = z
  .object({
    name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
    description: z.string().max(16384),
    inputSchema: json,
    mode: z.enum(['off', 'ask', 'auto']),
  })
  .strict()
const snapshot = z
  .object({
    vault_id: id,
    agent_id: id,
    revision: id,
    max_delegate_depth: z.number().int().min(0).max(3).optional(),
    conversation: json.optional(),
    tools: z.array(ObsidianToolSchema).max(256),
  })
  .strict()
export const ObsidianToolsSnapshotSchema = snapshot.refine(
  (v) => new Set(v.tools.map((t) => t.name)).size === v.tools.length
)
export type ObsidianToolsSnapshot = z.infer<typeof ObsidianToolsSnapshotSchema>
export const ObsidianConfigurationSchema = snapshot
  .extend({ session_id: id, expected_revision: id.optional() })
  .refine((v) => new Set(v.tools.map((t) => t.name)).size === v.tools.length)
const invocation = z.object({ invocation_id: id }).strict()
const executor = invocation.extend({ client_id: id, revision: id })
export const ObsidianDelegateArgumentsSchema = z
  .object({
    agent: z.string().min(1).max(128),
    task: z.string().min(1).max(32768),
    items: z.array(z.string().max(32768)).max(20).optional(),
    batch_size: z.number().finite().optional(),
  })
  .strict()
export const ObsidianToolsMethodSchemas = {
  'obsidian.tools.v1.delegate.begin': executor
    .extend({
      call_id: id,
      parent_branch_id: id.optional(),
      agent_name: z.string().min(1).max(128),
      target: ObsidianToolsSnapshotSchema,
      arguments: ObsidianDelegateArgumentsSchema.optional(),
    })
    .strict(),
  'obsidian.tools.v1.delegate.get': invocation.extend({ run_id: id.optional() }).strict(),
  'obsidian.tools.v1.delegate.branch': invocation.extend({ branch_id: id }).strict(),
  'obsidian.tools.v1.delegate.claim': executor.extend({ branch_id: id }).strict(),
  'obsidian.tools.v1.delegate.record': executor
    .extend({
      branch_id: id,
      record_id: id,
      messages: z
        .array(json)
        .max(32)
        .default([])
        .refine((v) => JSON.stringify(v).length <= 65536),
      state: z.enum(['running', 'done', 'error', 'aborted', 'outcome_unknown']).default('running'),
      result: z.string().max(32768).optional(),
      error: z.string().max(4096).optional(),
    })
    .strict(),
  'obsidian.tools.v1.delegate.history': invocation
    .extend({
      branch_id: id,
      after_seq: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(128).default(64),
    })
    .strict(),
  'obsidian.tools.v1.questions.open': executor.strict(),
  'obsidian.tools.v1.questions.pending': z
    .object({ vault_id: id, after_id: id.optional() })
    .strict(),
  'obsidian.tools.v1.configuration': z.object({ session_id: id }).strict(),
  'obsidian.tools.v1.configure': ObsidianConfigurationSchema,
  'obsidian.tools.v1.advertise': z
    .object({
      client_id: id,
      vault_id: id,
      platform: z.enum(['desktop', 'mobile']),
      label: z.string().max(128).optional(),
      revisions: z.record(id).refine((v) => Object.keys(v).length <= 256),
    })
    .strict(),
  'obsidian.tools.v1.poll': z.object({ client_id: id }).strict(),
  'obsidian.tools.v1.get': invocation,
  'obsidian.tools.v1.cancel': invocation,
  'obsidian.tools.v1.prepare': executor
    .extend({ preview: json, needs_approval: z.boolean().default(false) })
    .strict(),
  'obsidian.tools.v1.claim': executor.strict(),
  'obsidian.tools.v1.complete': executor
    .extend({
      state: z.enum(['succeeded', 'failed', 'outcome_unknown']),
      result: json,
    })
    .strict(),
}
export type ObsidianConfiguration = z.infer<typeof ObsidianConfigurationSchema>
