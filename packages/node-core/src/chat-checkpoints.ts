import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
const exec = promisify(execFile)
import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  fchmodSync,
  readFileSync,
  writeFileSync,
  lstatSync,
  realpathSync,
  mkdirSync,
  unlinkSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { ChannelError, LIMITS, type AuthorityContext } from '@abele/channel-protocol'
import {
  RelativePathSchema,
  ChatMethodSchemas,
  type ChatRestoreRequest,
  type ChatCheckpointsRequest,
} from '@abele/node-protocol'
import { canonical, type NodeCore } from './index.js'
import {
  captureNative,
  nativeHeader as readNativeHeader,
  writeNative,
  type NativeCheckpoint,
} from './native-checkpoints.js'

type FileState = { bytes: string; mode: number }
export type FileSnapshot = Record<string, FileState>
const stateOf = (files: FileSnapshot, path: string) =>
  Object.hasOwn(files, path) ? files[path] : undefined
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const MAX = 32 * 1024 * 1024
function target(root: string, path: string) {
  if (!path || !RelativePathSchema.safeParse(path).success || path.split('/').includes('.git'))
    throw new ChannelError('unsafe_path')
  let current = root
  for (const part of path.split('/')) {
    current = join(current, part)
    try {
      if (lstatSync(current).isSymbolicLink()) throw new ChannelError('unsafe_path')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return current
}
function readFile(root: string, path: string): FileState | undefined {
  const file = target(root, path)
  let fd: number
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  try {
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX) throw new ChannelError('output_limit')
    return { bytes: readFileSync(fd).toString('base64'), mode: stat.mode & 0o777 }
  } finally {
    closeSync(fd)
  }
}
/** Tracked and non-ignored untracked files; dependencies and Git metadata are never copied. */
export async function snapshotFiles(root: string, include: string[] = []): Promise<FileSnapshot> {
  if (realpathSync(root) !== root) throw new ChannelError('unsafe_path')
  const { stdout } = await exec(
    'git',
    [
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.hooksPath=/dev/null',
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
    ],
    {
      cwd: root,
      timeout: 5000,
      maxBuffer: MAX,
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_'))
        ),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
    }
  )
  const paths = stdout.split('\0').filter(Boolean)
  const files: FileSnapshot = Object.create(null)
  let bytes = 0
  for (const path of [...new Set([...paths, ...include])].sort()) {
    const value = readFile(root, path)
    if (!value) continue
    bytes += value.bytes.length
    if (bytes > MAX || Object.keys(files).length >= 4096) throw new ChannelError('output_limit')
    files[path] = value
  }
  return files
}
export function previewFiles(before: FileSnapshot, current: FileSnapshot) {
  return [...new Set([...Object.keys(before), ...Object.keys(current)])]
    .sort()
    .filter(
      (path) => digest(stateOf(before, path) ?? null) !== digest(stateOf(current, path) ?? null)
    )
    .map((path) => ({
      path,
      current: digest(stateOf(current, path) ?? null),
      checkpoint: digest(stateOf(before, path) ?? null),
    }))
}
export async function restoreFiles(
  root: string,
  before: FileSnapshot,
  changes: ReturnType<typeof previewFiles>,
  beforeWrite?: () => void
) {
  const actual = previewFiles(before, await snapshotFiles(root, Object.keys(before)))
  beforeWrite?.()
  if (JSON.stringify(changes) !== JSON.stringify(actual)) throw new ChannelError('stale_revision')
  // Validate every target before the first write. Never traverse or replace a symlink.
  for (const change of actual) target(root, change.path)
  for (const { path } of actual) {
    const file = target(root, path),
      value = stateOf(before, path)
    if (!value) unlinkSync(file)
    else {
      mkdirSync(dirname(file), { recursive: true })
      target(root, path)
      const fd = openSync(
        file,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        value.mode
      )
      try {
        writeFileSync(fd, Buffer.from(value.bytes, 'base64'))
        fchmodSync(fd, value.mode)
      } finally {
        closeSync(fd)
      }
    }
  }
}
type Checkpoint = {
  checkpoint_id: string
  input_id: string
  root: string
  binding: unknown
  native: NativeCheckpoint
  files: FileSnapshot
  seq: number
  exclude_input_ids: string[]
}

/** Pi conversation copies are immutable; restoring creates a new native session file. */
export class ChatCheckpoints {
  readonly busy = new Set<string>()
  constructor(private core: NodeCore) {}
  async capture(session_id: string, input_id: string) {
    const session = this.core.session(session_id)
    if (session.provider !== 'pi' || !session.native_session_file) return
    try {
      const root = this.core.resources.lsp.sessionRoot(session_id)
      const native = captureNative(this.core.stateDir, session_id, session.native_session_file)
      const checkpoint: Checkpoint = {
        checkpoint_id: randomUUID(),
        input_id,
        root,
        native,
        binding: this.core.resources.targets.currentTarget(session_id),
        files: await snapshotFiles(root),
        seq: this.core.head(session_id),
        exclude_input_ids: (
          this.core.db
            .prepare(
              "SELECT input_id FROM inputs WHERE session_id=? AND state IN ('accepted','queued','dispatching') ORDER BY ordinal"
            )
            .all(session_id) as { input_id: string }[]
        ).map((i) => i.input_id),
      }
      if (
        this.core.resources.lsp.sessionRoot(session_id) !== root ||
        digest(checkpoint.binding) !== digest(this.core.resources.targets.currentTarget(session_id))
      )
        throw new ChannelError('stale_revision')
      this.core.transaction(() => {
        this.core.db
          .prepare('INSERT INTO chat_checkpoints VALUES(?,?,?)')
          .run(checkpoint.checkpoint_id, session_id, JSON.stringify(checkpoint))
        this.core.db.prepare('INSERT INTO chat_checkpoint_summaries VALUES(?,?,?,?)').run(
          checkpoint.checkpoint_id,
          session_id,
          checkpoint.seq,
          JSON.stringify({
            checkpoint_id: checkpoint.checkpoint_id,
            input_id,
            before_seq: checkpoint.seq,
            exclude_input_ids: checkpoint.exclude_input_ids,
          })
        )
      })
      this.core.append(
        session_id,
        'chat.checkpoint',
        { kind: 'node' },
        {
          checkpoint_id: checkpoint.checkpoint_id,
          input_id,
          before_seq: checkpoint.seq,
          exclude_input_ids: checkpoint.exclude_input_ids,
        }
      )
    } catch (error) {
      this.core.append(
        session_id,
        'chat.checkpoint.unavailable',
        { kind: 'node' },
        {
          input_id,
          reason: error instanceof Error ? error.message.slice(0, 256) : 'checkpoint_failed',
        }
      )
    }
  }
  private checkpoint(session: string, checkpoint: string) {
    const row = this.core.db
      .prepare('SELECT body FROM chat_checkpoints WHERE session_id=? AND checkpoint_id=?')
      .get(session, checkpoint) as { body: string } | undefined
    if (!row) throw new ChannelError('not_found')
    return JSON.parse(row.body) as Checkpoint
  }
  private assertIdle(actor: AuthorityContext, session_id: string) {
    if (this.busy.has(session_id)) throw new ChannelError('resource_busy')
    this.core.checkExecution(actor.installation_id, session_id)
    const state = this.core.claude.live.state(session_id)
    if (
      !['idle', 'none'].includes(state.process) ||
      this.core.db
        .prepare(
          "SELECT 1 FROM inputs WHERE session_id=? AND state IN ('accepted','queued','dispatching','delivered')"
        )
        .get(session_id)
    )
      throw new ChannelError('resource_busy')
  }
  async request(actor: AuthorityContext, method: string, raw: unknown, operation?: string) {
    const schema = ChatMethodSchemas[method as keyof typeof ChatMethodSchemas]
    if (!schema) throw new ChannelError('unsupported_method')
    const parsed = schema.safeParse(raw)
    if (!parsed.success) throw new ChannelError('invalid_params')
    const p = parsed.data as Partial<ChatRestoreRequest> & { session_id: string },
      session = this.core.session(p.session_id)
    this.core.authority.check(actor, 'read', p.session_id)
    if (method === 'chat.restore') {
      const previous = this.core.operationReceipt(actor, method, parsed.data, operation)
      if (previous) return previous.result
      if (
        this.core.db
          .prepare('SELECT 1 FROM chat_restore_attempts WHERE principal_id=? AND operation_id=?')
          .get(actor.installation_id, operation!)
      )
        throw new ChannelError('outcome_unknown')
    }
    if (session.provider !== 'pi') throw new ChannelError('unsupported_method')
    if (method === 'chat.checkpoints') {
      const page = parsed.data as ChatCheckpointsRequest
      const forward = page.after_seq !== undefined
      const cursor = page.after_seq ?? page.before_seq
      const rows: { body: string }[] = []
      let bytes = 2
      const result = this.core.db
        .prepare(
          `SELECT body FROM chat_checkpoint_summaries WHERE session_id=?${cursor === undefined ? '' : ` AND seq${forward ? '>' : '<'}?`} ORDER BY seq ${forward ? 'ASC' : 'DESC'} LIMIT ?`
        )
        .iterate(p.session_id, ...(cursor === undefined ? [] : [cursor]), page.limit ?? 100)
      for (const row of result) {
        const body = String(row.body)
        bytes += Buffer.byteLength(body) + 1
        if (bytes > LIMITS.record_bytes - 1024) {
          if (!rows.length) throw new ChannelError('output_limit')
          break
        }
        rows.push({ body })
      }
      if (!forward) rows.reverse()
      return rows.map((r) => JSON.parse(r.body))
    }
    if (!p.checkpoint_id) throw new ChannelError('invalid_params')
    const checkpoint = this.checkpoint(p.session_id, p.checkpoint_id)
    const root = this.core.resources.lsp.sessionRoot(p.session_id)
    if (
      root !== checkpoint.root ||
      digest(checkpoint.binding) !== digest(this.core.resources.targets.currentTarget(p.session_id))
    )
      throw new ChannelError('stale_revision')
    const changes = previewFiles(
      checkpoint.files,
      await snapshotFiles(root, Object.keys(checkpoint.files))
    )
    const checkBinding = () => {
      if (
        this.core.resources.lsp.sessionRoot(p.session_id) !== root ||
        digest(checkpoint.binding) !==
          digest(this.core.resources.targets.currentTarget(p.session_id))
      )
        throw new ChannelError('stale_revision')
      // LSP roots are readable. Restoring repository files separately requires edit approval.
      if (method === 'chat.restore' && p.restore_files) {
        const target = this.core.resources.targets.bound(p.session_id)?.target
        if (
          target?.kind === 'worktree' &&
          this.core.resources.repository.fileRoot(target.worktree_id) !== root
        )
          throw new ChannelError('stale_revision')
      }
    }
    checkBinding()
    const preview_id = digest({ checkpoint_id: checkpoint.checkpoint_id, root, changes })
    if (method === 'chat.preview') {
      if (Buffer.byteLength(JSON.stringify(changes)) > 24000) throw new ChannelError('output_limit')
      let remaining = 24000
      const files = changes.map(({ path }) => {
        const before = readFile(root, path),
          after = stateOf(checkpoint.files, path)
        const limit = Math.min(4096, Math.floor(remaining / 2 / 4) * 4)
        const before_base64 = before?.bytes.slice(0, limit) ?? null,
          after_base64 = after?.bytes.slice(0, limit) ?? null
        remaining -= (before_base64?.length ?? 0) + (after_base64?.length ?? 0)
        return {
          path,
          before_base64,
          after_base64,
          before_mode: before?.mode ?? null,
          after_mode: after?.mode ?? null,
          truncated: (before?.bytes.length ?? 0) > limit || (after?.bytes.length ?? 0) > limit,
        }
      })
      return { preview_id, changes, files }
    }
    if (
      method !== 'chat.restore' ||
      !p.action ||
      (p.action === 'edit' && !p.text) ||
      (p.action === 'branch' && p.restore_files)
    )
      throw new ChannelError('invalid_params')
    this.assertIdle(actor, p.session_id)
    if (
      p.restore_files &&
      (p.restore_files.preview_id !== preview_id ||
        JSON.stringify(p.restore_files.changes) !== JSON.stringify(changes))
    )
      throw new ChannelError('stale_revision')
    // Validate conversation data before any filesystem effect.
    const { value: nativeHeader } = readNativeHeader(this.core.stateDir, checkpoint.native)
    if (nativeHeader.type !== 'session') throw new ChannelError('invalid_pi_native_state')
    const originalFiles = p.restore_files
      ? await snapshotFiles(root, Object.keys(checkpoint.files))
      : undefined
    this.assertIdle(actor, p.session_id)
    checkBinding()
    const previous = this.core.reserveOperation(actor, method, parsed.data, operation!, () =>
      this.core.db.prepare('INSERT INTO chat_restore_attempts VALUES(?,?,?,?)').run(
        actor.installation_id,
        operation!,
        createHash('sha256')
          .update(canonical({ method, params: parsed.data }))
          .digest('hex'),
        JSON.stringify({
          session_id: p.session_id,
          checkpoint_id: p.checkpoint_id,
          root,
          action: p.action,
          restore_files: p.restore_files,
          original_files: originalFiles,
        })
      )
    )
    if (previous) return previous.result
    this.busy.add(p.session_id)
    try {
      await this.core.claude.live.stop(p.session_id, 'chat_restore')
      this.core.checkExecution(actor.installation_id, p.session_id)
      checkBinding()
      // Recheck after stopping: no preview grants permission to discard a later edit.
      if (p.restore_files)
        await restoreFiles(root, checkpoint.files, p.restore_files.changes, () => {
          this.core.checkExecution(actor.installation_id, p.session_id)
          checkBinding()
        })
      let destination = session
      if (p.action === 'branch') {
        const target = this.core.resources.targets.currentTarget(p.session_id)?.target
        if (!target) throw new ChannelError('workspace_required')
        destination = (await this.core.request(
          actor,
          'session.create',
          { title: session.title, provider: 'pi', target, settings: session.settings },
          randomUUID()
        )) as typeof session
      }
      const dir = join(this.core.stateDir, 'pi-sessions', destination.session_id)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      if (realpathSync(dir) !== dir) throw new ChannelError('unsafe_path')
      const native_id = randomUUID(),
        file = join(dir, native_id + '.jsonl')
      writeNative(this.core.stateDir, checkpoint.native, file, native_id, root)
      const updated = { ...destination, native_session_id: native_id, native_session_file: file }
      return this.core.commitOperation(actor, method, parsed.data, operation, () => {
        this.core.db
          .prepare('UPDATE sessions SET body=? WHERE session_id=?')
          .run(JSON.stringify(updated), destination.session_id)
        this.core.db
          .prepare(
            "INSERT INTO provider_native_sessions VALUES(?,'pi',?,?) ON CONFLICT(session_id) DO UPDATE SET native_session_id=excluded.native_session_id, session_file=excluded.session_file"
          )
          .run(destination.session_id, native_id, file)
        this.core.append(destination.session_id, 'session.updated', { kind: 'node' }, updated)
        this.core.append(
          destination.session_id,
          'chat.restored',
          { kind: 'node' },
          {
            checkpoint_id: checkpoint.checkpoint_id,
            source_session_id: session.session_id,
            action: p.action,
            before_seq: checkpoint.seq,
            exclude_input_ids: checkpoint.exclude_input_ids,
            restored_files: p.restore_files?.changes ?? [],
          }
        )
        let input: unknown
        if (p.action === 'retry' || p.action === 'edit') {
          const row = this.core.db
            .prepare('SELECT body FROM inputs WHERE input_id=?')
            .get(checkpoint.input_id) as { body: string }
          this.busy.delete(p.session_id)
          input = this.core.acceptOwnerInput(actor, {
            session_id: destination.session_id,
            text: p.action === 'edit' ? p.text : JSON.parse(row.body).text,
            observed_seq: this.core.head(destination.session_id),
            script: [{ kind: 'echo' }],
          })
        }
        return { session_id: destination.session_id, ...(input ? { input } : {}) }
      })
    } catch (error) {
      try {
        this.core.transaction(() =>
          this.core.append(
            p.session_id,
            'chat.restore.failed',
            { kind: 'node' },
            {
              operation_id: operation,
              checkpoint_id: p.checkpoint_id,
              reason: error instanceof Error ? error.message.slice(0, 256) : 'restore_failed',
            }
          )
        )
      } catch {
        /* The durable attempt survives even when audit storage is unavailable. */
      }
      throw error
    } finally {
      this.busy.delete(p.session_id)
    }
  }
}
