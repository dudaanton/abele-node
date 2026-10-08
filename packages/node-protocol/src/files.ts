import { z } from 'zod'
const id = z.string().min(1).max(128)
export const RelativePathSchema = z
  .string()
  .max(4096)
  .refine(
    (p) =>
      !p.startsWith('/') &&
      !p.includes('\0') &&
      (p === '' || p.split('/').every((s) => s !== '' && s !== '.' && s !== '..'))
  )
const path = RelativePathSchema.refine((p) => p.length > 0)
export const CommitSchema = z.string().regex(/^[a-f0-9]{40,64}$/)
export const DiffModeSchema = z.enum(['staged', 'unstaged', 'head', 'base', 'commit'])
export type DiffMode = z.infer<typeof DiffModeSchema>
export const FileEntrySchema = z
  .object({
    name: z.string(),
    path: RelativePathSchema,
    kind: z.enum(['file', 'directory', 'symlink', 'other']),
    size: z.number().int().nonnegative(),
  })
  .strict()
export const FilePageSchema = z
  .object({ entries: z.array(FileEntrySchema).max(256), next: z.string().nullable() })
  .strict()
export const FileContentSchema = z
  .object({
    workspace_id: id,
    path,
    content_id: id.nullable(),
    size: z.number().int().nonnegative(),
    binary: z.boolean(),
    large: z.boolean(),
    too_large: z.boolean(),
  })
  .strict()
export const ContentChunkSchema = z
  .object({
    offset: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    base64: z.string().max(180000),
  })
  .strict()
export const DiffSnapshotSchema = z
  .object({
    diff_id: id,
    workspace_id: id,
    mode: DiffModeSchema,
    head_commit: CommitSchema,
    base_commit: CommitSchema.nullable(),
    merge_base: CommitSchema.nullable(),
    commit: CommitSchema.nullable(),
    content_id: id,
    size: z.number().int().nonnegative(),
    created_at: z.string().datetime(),
  })
  .strict()
export type DiffSnapshot = z.infer<typeof DiffSnapshotSchema>
export const ReviewAnchorSchema = z
  .object({
    node_id: id,
    workspace_id: id,
    diff_id: id,
    path,
    side: z.enum(['old', 'new']),
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
    context_hash: z.string().regex(/^[a-f0-9]{64}$/),
    comment: z.string().min(1).max(2000),
  })
  .strict()
  .refine((a) => a.end_line >= a.start_line && a.end_line - a.start_line < 200)
export type ReviewAnchor = z.infer<typeof ReviewAnchorSchema>
export const ReviewBatchSchema = z
  .object({
    session_id: id,
    observed_seq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    anchors: z.array(ReviewAnchorSchema).min(1).max(32),
  })
  .strict()
export type ReviewBatch = z.infer<typeof ReviewBatchSchema>
export const ReviewResultSchema = z
  .object({
    input_id: id,
    accepted_seq: z.number().int().nonnegative(),
    stale: z.array(z.boolean()),
  })
  .strict()
const contentId = z.string().regex(/^[a-f0-9]{64}$/)
export const FileWriteSchema = z
  .object({
    workspace_id: id,
    path: path.refine((p) => !p.split('/').some((s) => s.toLowerCase() === '.git')),
    expected_content_id: contentId.nullable(),
    // Fits a record even when every character needs JSON escaping. No binary editor in this slice.
    text: z
      .string()
      .max(32768)
      .refine(
        (t) =>
          !t.includes('\0') &&
          !/[\uD800-\uDFFF]/u.test(t.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ''))
      ),
  })
  .strict()
export type FileWrite = z.infer<typeof FileWriteSchema>
export const FileRestoreSchema = z
  .object({
    workspace_id: id,
    path: FileWriteSchema.shape.path,
    expected_content_id: contentId.nullable(),
    recovery_path: path,
  })
  .strict()
export type FileRestore = z.infer<typeof FileRestoreSchema>
export const FileMutationResultSchema = z
  .object({
    operation_id: id,
    workspace_id: id,
    path,
    state: z.enum(['saved', 'conflict', 'outcome_unknown']),
    expected_content_id: contentId.nullable(),
    content_id: contentId,
    predecessor_content_id: contentId.nullable(),
    recovery_path: path.nullable(),
  })
  .strict()
export type FileMutationResult = z.infer<typeof FileMutationResultSchema>
export const WorkspaceInvalidationSchema = z
  .object({
    workspace_id: id,
    reason: z.literal('file_mutation'),
    operation_id: id,
    paths: z.array(path).max(1),
  })
  .strict()
const workspace = { workspace_id: id }
const chunk = {
  offset: z.number().int().nonnegative().default(0),
  length: z.number().int().min(1).max(131072).default(131072),
}
export const FileMethodSchemas = {
  'workspace.files': z
    .object({
      ...workspace,
      path: RelativePathSchema.default(''),
      after: z.string().max(4096).optional(),
      limit: z.number().int().min(1).max(256).default(256),
    })
    .strict(),
  'workspace.stat': z.object({ ...workspace, path }).strict(),
  'workspace.read': z.object({ ...workspace, path }).strict(),
  'workspace.write': FileWriteSchema,
  'workspace.restore': FileRestoreSchema,
  'workspace.recovery.read': z.object({ ...workspace, recovery_path: path, ...chunk }).strict(),
  'workspace.content': z.object({ ...workspace, content_id: id, ...chunk }).strict(),
  'workspace.diff.capture': z
    .object({ ...workspace, mode: DiffModeSchema.default('head'), commit: CommitSchema.optional() })
    .strict()
    .refine((p) => p.mode !== 'commit' || !!p.commit),
  'workspace.diff.get': z.object({ ...workspace, diff_id: id }).strict(),
  'workspace.diff.read': z.object({ ...workspace, diff_id: id, ...chunk }).strict(),
  'workspace.log': z
    .object({
      ...workspace,
      offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(100).default(50),
    })
    .strict(),
  'workspace.show': z.object({ ...workspace, commit: CommitSchema, path }).strict(),
  'review.submit': ReviewBatchSchema,
} as const

export interface DiffLine {
  path: string
  side: 'old' | 'new'
  line: number
  text: string
}
/** Git quotes control characters and octal UTF-8 bytes even with core.quotepath=false. */
export function decodePatchPath(value: string): string {
  // Git separates an unquoted space-containing header path from its (empty) timestamp by TAB.
  // A literal TAB in a filename is quoted/escaped and must survive decoding.
  if (value.endsWith('\t')) value = value.slice(0, -1)
  if (value.startsWith('"')) {
    const bytes: number[] = []
    for (let i = 1; i < value.length - 1; i++) {
      if (value[i] === '\\') {
        const octal = value.slice(i + 1).match(/^[0-7]{3}/)?.[0]
        if (octal) {
          bytes.push(parseInt(octal, 8))
          i += 3
        } else {
          const c = value[++i]!
          bytes.push(
            ({ t: 9, n: 10, r: 13, b: 8, f: 12, v: 11 } as Record<string, number>)[c] ??
              c.charCodeAt(0)
          )
        }
      } else {
        const c = value.codePointAt(i)!
        bytes.push(
          ...Array.from(unescape(encodeURIComponent(String.fromCodePoint(c))), (b) =>
            b.charCodeAt(0)
          )
        )
        if (c > 65535) i++
      }
    }
    value = decodeURIComponent(bytes.map((b) => '%' + b.toString(16).padStart(2, '0')).join(''))
  }
  return value.slice(2)
}
/** Shared immutable selection interpretation; only lines actually present in a hunk are anchorable. */
export function diffLines(patch: string): DiffLine[] {
  const result: DiffLine[] = []
  let oldPath = '',
    newPath = '',
    old = 0,
    next = 0,
    oldRemaining = 0,
    newRemaining = 0,
    inHunk = false
  for (const text of patch.split('\n')) {
    if (text.startsWith('diff --git ')) {
      inHunk = false
      oldPath = ''
      newPath = ''
    } else if (!inHunk && text.startsWith('--- ')) {
      const header = text.slice(4).replace(/\t$/, '')
      oldPath = header === '/dev/null' ? '' : decodePatchPath(header)
    } else if (!inHunk && text.startsWith('+++ ')) {
      const header = text.slice(4).replace(/\t$/, '')
      newPath = header === '/dev/null' ? '' : decodePatchPath(header)
    } else if (text.startsWith('@@ ')) {
      const m = text.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
      if (m) {
        old = Number(m[1])
        next = Number(m[3])
        oldRemaining = Number(m[2] ?? 1)
        newRemaining = Number(m[4] ?? 1)
        inHunk = oldRemaining > 0 || newRemaining > 0
      }
    } else if (inHunk && (text === '' || /^[ +\-]/.test(text))) {
      if (text[0] !== '+') {
        if (oldPath) result.push({ path: oldPath, side: 'old', line: old, text: text.slice(1) })
        old++
        oldRemaining--
      }
      if (text[0] !== '-') {
        if (newPath) result.push({ path: newPath, side: 'new', line: next, text: text.slice(1) })
        next++
        newRemaining--
      }
      inHunk = oldRemaining > 0 || newRemaining > 0
    }
  }
  return result
}
export function selectedContext(
  patch: string,
  anchor: Pick<ReviewAnchor, 'path' | 'side' | 'start_line' | 'end_line'>
): string {
  const rows = diffLines(patch).filter(
    (l) =>
      l.path === anchor.path &&
      l.side === anchor.side &&
      l.line >= anchor.start_line &&
      l.line <= anchor.end_line
  )
  if (
    rows.length !== anchor.end_line - anchor.start_line + 1 ||
    rows.some((l, i) => l.line !== anchor.start_line + i)
  )
    throw new Error('invalid_anchor')
  return rows.map((l) => l.text).join('\n')
}
