import { randomUUID, createHash } from 'node:crypto'
import {
  constants,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  ftruncateSync,
  fstatSync,
  lstatSync,
  realpathSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  mkdirSync,
  chmodSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { ChannelError, type AuthorityContext } from '@abele/channel-protocol'
import {
  FileWriteSchema,
  FileRestoreSchema,
  FileMutationResultSchema,
  RelativePathSchema,
  type FileWrite,
  type FileRestore,
  type FileMutationResult,
  RepositoryWriteSchema,
  RepositoryRestoreSchema,
  RepositoryMutationResultSchema,
  type RepositoryWrite,
  type RepositoryRestore,
} from '@abele/node-protocol'
import { canonical } from './index.js'
import type { ResourceServices } from './resources.js'

export const FILE_RECOVERY_LIMITS = { count: 32, bytes: 16 * 1024 * 1024 } as const
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
type Params = FileWrite | FileRestore | RepositoryWrite | RepositoryRestore
type Method =
  'workspace.write' | 'workspace.restore' | 'repository.v1.write' | 'repository.v1.restore'
const resourceId = (p: Params) => ('worktree_id' in p ? p.worktree_id : p.workspace_id)
const copyTable = (repository: boolean) =>
  repository ? 'repository_recovery_copies' : 'file_recovery_copies'
type Intent = {
  kind: 'in_place'
  method: Method
  params: Params
  recovery_path: string | null
  predecessor: string | null
  content_id: string
}
type IntentRow = { principal_id: string; operation_id: string; request_hash: string; body: string }
type Copy = {
  ordinal: number
  workspace_id: string
  path: string
  file_path: string
  content_id: string
  size: number
}
const requestHash = (method: Method, params: Params) => hash(canonical({ method, params }))
const sameInode = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) =>
  a.dev === b.dev && a.ino === b.ino

/** API writes serialize, but ordinary external editors can interleave. No filesystem CAS is claimed. */
export class FileMutationCoordinator {
  fault?: (point: 'before_check' | 'after_intent' | 'after_truncate' | 'after_write') => void
  private serial: Promise<unknown> = Promise.resolve()
  constructor(private r: ResourceServices) {}
  write(actor: AuthorityContext, params: FileWrite, operation?: string) {
    return this.schedule(() => this.apply(actor, 'workspace.write', params, operation))
  }
  restore(actor: AuthorityContext, params: FileRestore, operation?: string) {
    return this.schedule(() => this.apply(actor, 'workspace.restore', params, operation))
  }
  writeRepository(actor: AuthorityContext, params: RepositoryWrite, operation?: string) {
    return this.schedule(async () => {
      await this.r.git.bounded(15000, () =>
        this.r.repository.prepareEdit(actor, params.worktree_id, params.path)
      )
      return this.apply(actor, 'repository.v1.write', params, operation)
    })
  }
  restoreRepository(actor: AuthorityContext, params: RepositoryRestore, operation?: string) {
    return this.schedule(async () => {
      await this.r.git.bounded(15000, () =>
        this.r.repository.prepareEdit(actor, params.worktree_id, params.path)
      )
      return this.apply(actor, 'repository.v1.restore', params, operation)
    })
  }
  private schedule(work: () => unknown) {
    const task = this.serial.then(work)
    this.serial = task.catch(() => {})
    return task
  }
  private syncDirectory(path: string) {
    const fd = openSync(dirname(path), constants.O_RDONLY)
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  }
  private copyRow(workspace: string, ref: string, repository = false): Copy {
    const row = this.r.core.db
      .prepare(`SELECT * FROM ${copyTable(repository)} WHERE workspace_id=? AND path=?`)
      .get(workspace, ref) as Copy | undefined
    if (!row) throw new ChannelError('recovery_expired')
    return row
  }
  private copyBytes(row: Copy) {
    const target = join(this.r.core.stateDir, row.path)
    if (
      !RelativePathSchema.safeParse(row.path).success ||
      !row.path.startsWith('file-recovery/') ||
      realpathSync(target) !== target
    )
      throw new ChannelError('unsafe_path')
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > FILE_RECOVERY_LIMITS.bytes)
        throw new ChannelError('file_too_large')
      const bytes = readFileSync(fd)
      if (hash(bytes) !== row.content_id) throw new ChannelError('stale_revision')
      return bytes
    } finally {
      closeSync(fd)
    }
  }
  readRecovery(workspace: string, ref: string, offset: number, length: number, repository = false) {
    const bytes = this.copyBytes(this.copyRow(workspace, ref, repository))
    return {
      offset,
      total: bytes.length,
      base64: bytes.subarray(offset, offset + length).toString('base64'),
    }
  }
  private ensureRecoveryDirectory(path: string) {
    let created = false
    try {
      mkdirSync(path, { mode: 0o700 })
      created = true
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      if (!lstatSync(path).isDirectory() || realpathSync(path) !== path)
        throw new ChannelError('unsafe_path')
    }
    chmodSync(path, 0o700)
    // Persist the new directory entry in its parent before any workspace truncation.
    if (created) this.syncDirectory(path)
  }
  private retainCopy(workspace: string, file: string, bytes: Uint8Array, repository = false) {
    const table = copyTable(repository)
    if (bytes.length > FILE_RECOVERY_LIMITS.bytes) throw new ChannelError('file_too_large')
    // Workspace IDs are node-owned, but keep the state-directory component explicit and bounded.
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(workspace)) throw new ChannelError('unsafe_path')
    const rows = this.r.core.db
      .prepare(`SELECT * FROM ${table} WHERE workspace_id=? ORDER BY ordinal`)
      .all(workspace) as Copy[]
    let total = rows.reduce((n, row) => n + row.size, 0)
    while (
      rows.length >= FILE_RECOVERY_LIMITS.count ||
      total + bytes.length > FILE_RECOVERY_LIMITS.bytes
    ) {
      const row = rows.shift()!
      try {
        unlinkSync(join(this.r.core.stateDir, row.path))
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      }
      this.r.core.transaction(() =>
        this.r.core.db.prepare(`DELETE FROM ${table} WHERE ordinal=?`).run(row.ordinal)
      )
      total -= row.size
    }
    const path = `file-recovery/${workspace}/${randomUUID()}.bin`,
      target = join(this.r.core.stateDir, path),
      directory = dirname(target)
    this.ensureRecoveryDirectory(dirname(directory))
    this.ensureRecoveryDirectory(directory)
    const fd = openSync(
      target,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600
    )
    try {
      for (let offset = 0; offset < bytes.length;) {
        const n = writeSync(fd, bytes, offset, bytes.length - offset)
        if (!n) throw new Error('short_recovery_write')
        offset += n
      }
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    this.syncDirectory(target)
    try {
      this.r.core.transaction(() =>
        this.r.core.db
          .prepare(
            `INSERT INTO ${table}(workspace_id,path,file_path,content_id,size) VALUES(?,?,?,?,?)`
          )
          .run(workspace, path, file, hash(bytes), bytes.length)
      )
    } catch (e) {
      // No workspace effect has happened. An unindexed copy can be removed safely here.
      if (!this.r.core.db.prepare(`SELECT 1 FROM ${table} WHERE path=?`).get(path))
        unlinkSync(target)
      throw e
    }
    return path
  }
  private finish(
    row: IntentRow,
    intent: Intent,
    state: FileMutationResult['state'],
    predecessor = intent.predecessor,
    recovery = intent.recovery_path
  ) {
    const repository = 'worktree_id' in intent.params
    const result = (repository ? RepositoryMutationResultSchema : FileMutationResultSchema).parse({
      operation_id: row.operation_id,
      ...(repository
        ? { worktree_id: resourceId(intent.params) }
        : { workspace_id: resourceId(intent.params) }),
      path: intent.params.path,
      state,
      expected_content_id: intent.params.expected_content_id,
      content_id: intent.content_id,
      predecessor_content_id: predecessor,
      recovery_path: recovery,
    })
    this.r.core.transaction(() => {
      this.r.core.db
        .prepare('INSERT INTO operations VALUES(?,?,?,?)')
        .run(row.principal_id, row.operation_id, row.request_hash, JSON.stringify(result))
      this.r.core.db
        .prepare('DELETE FROM file_mutations WHERE principal_id=? AND operation_id=?')
        .run(row.principal_id, row.operation_id)
      if (repository) {
        const target = this.r.core.db
          .prepare('SELECT project_id FROM repository_targets WHERE worktree_id=?')
          .get(resourceId(intent.params)) as { project_id: string }
        this.r.core.append(
          'catalog',
          'repository.invalidated',
          { kind: 'installation', installation_id: row.principal_id },
          {
            project_id: target.project_id,
            worktree_id: resourceId(intent.params),
            reason: 'filesystem',
            generation: randomUUID(),
          }
        )
      } else
        this.r.core.append(
          'catalog',
          'workspace.changed',
          { kind: 'node' },
          {
            workspace_id: resourceId(intent.params),
            reason: 'file_mutation',
            operation_id: row.operation_id,
            paths: [intent.params.path],
          }
        )
    }, true)
    return result
  }
  private sweepRecoveryDirectory() {
    const root = join(this.r.core.stateDir, 'file-recovery')
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(root)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      throw e
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ChannelError('unsafe_path')
    const referenced = new Set(
      (
        this.r.core.db
          .prepare(
            'SELECT path FROM file_recovery_copies UNION ALL SELECT path FROM repository_recovery_copies'
          )
          .all() as { path: string }[]
      ).map((row) => row.path)
    )
    const visit = (directory: string, relative: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const target = join(directory, entry.name),
          path = relative + '/' + entry.name
        if (entry.isDirectory()) visit(target, path)
        else if (!referenced.has(path)) {
          // Before the row/intent commit, a crash can leave full or partial orphan files.
          // They are never recovery references and cannot consume the durable quota.
          unlinkSync(target)
          this.syncDirectory(target)
        }
      }
    }
    visit(root, 'file-recovery')
  }
  recover() {
    this.sweepRecoveryDirectory()
    for (const row of this.r.core.db.prepare('SELECT * FROM file_mutations').all() as IntentRow[]) {
      const raw = JSON.parse(row.body) as Intent
      if (raw.kind !== 'in_place')
        throw new Error(
          'Mutation requires manual inspection: ' +
            JSON.stringify({ operation_id: row.operation_id })
        )
      const params =
        raw.method === 'repository.v1.restore'
          ? RepositoryRestoreSchema.parse(raw.params)
          : raw.method === 'repository.v1.write'
            ? RepositoryWriteSchema.parse(raw.params)
            : raw.method === 'workspace.restore'
              ? FileRestoreSchema.parse(raw.params)
              : FileWriteSchema.parse(raw.params)
      const intent: Intent = { ...raw, params }
      // Matching current bytes are not proof of completion. Never repeat an uncertain effect.
      this.finish(row, intent, 'outcome_unknown')
    }
  }
  private current(workspace: string, path: string, repository = false) {
    try {
      return this.r.files.read(workspace, path, repository)
    } catch (e) {
      if (e instanceof ChannelError && e.code === 'not_found') return null
      throw e
    }
  }
  private apply(actor: AuthorityContext, method: Method, params: Params, operation?: string) {
    const workspace = resourceId(params),
      repository = 'worktree_id' in params
    const current = () => this.current(workspace, params.path, repository)
    const core = this.r.core,
      previous = core.operationReceipt(actor, method, params, operation)
    if (previous) return previous.result
    const pending = core.db
      .prepare('SELECT * FROM file_mutations WHERE principal_id=? AND operation_id=?')
      .get(actor.installation_id, operation!) as IntentRow | undefined
    if (pending) {
      if (pending.request_hash !== requestHash(method, params))
        throw new ChannelError('idempotency_mismatch')
      return this.finish(pending, JSON.parse(pending.body) as Intent, 'outcome_unknown')
    }
    let bytes: Buffer
    if (method === 'workspace.restore' || method === 'repository.v1.restore') {
      const copy = this.copyRow(
        workspace,
        (params as FileRestore | RepositoryRestore).recovery_path,
        repository
      )
      if (copy.file_path !== params.path) throw new ChannelError('unsafe_path')
      bytes = this.copyBytes(copy)
    } else bytes = Buffer.from((params as FileWrite).text)
    const initial = current()
    if (initial?.too_large) throw new ChannelError('file_too_large')
    if ((method === 'workspace.write' || method === 'repository.v1.write') && initial?.binary)
      throw new ChannelError('invalid_params')
    const intent: Intent = {
      kind: 'in_place',
      method,
      params,
      predecessor: initial?.content_id ?? null,
      recovery_path: null,
      content_id: hash(bytes),
    }
    const row: IntentRow = {
      principal_id: actor.installation_id,
      operation_id: operation!,
      request_hash: requestHash(method, params),
      body: '',
    }
    if ((initial?.content_id ?? null) !== params.expected_content_id)
      return this.finish(row, intent, 'conflict')
    const target = this.r.files.writeTarget(workspace, params.path, !initial, repository)
    let fd: number | undefined
    if (initial) {
      // Probe write access WITHOUT truncation. O_TRUNC's effect is deferred to ftruncate on
      // this same pinned descriptor, after the recovery copy and durable intent are committed.
      try {
        fd = openSync(target, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      } catch {
        throw new ChannelError('file_not_writable')
      }
    }
    try {
      if (initial) {
        if (!sameInode(fstatSync(fd!), lstatSync(target))) throw new ChannelError('unsafe_path')
        this.fault?.('before_check')
        const fresh = current()
        if (
          !fresh ||
          fresh.too_large ||
          fresh.content_id !== params.expected_content_id ||
          !sameInode(fstatSync(fd!), lstatSync(target))
        )
          return this.finish(row, intent, 'conflict', fresh?.content_id ?? null)
        intent.recovery_path = this.retainCopy(
          workspace,
          params.path,
          this.r.files.bytes(workspace, fresh.content_id!, repository),
          repository
        )
      }
      row.body = JSON.stringify(intent)
      core.transaction(() => {
        core.authority.check(actor, method, workspace)
        core.db
          .prepare('INSERT INTO file_mutations VALUES(?,?,?,?)')
          .run(row.principal_id, row.operation_id, row.request_hash, row.body)
      })
      this.fault?.('after_intent')
      core.authority.check(actor, method, workspace)
      // Revalidate approval/identity even for exclusive creation, immediately before the effect.
      if (repository) this.r.repository.fileRoot(workspace)
      if (!initial) this.r.files.writeTarget(workspace, params.path, true, repository)
      if (initial) {
        // Final content/path check immediately before the first destructive write.
        const final = current()
        if (
          !final ||
          final.content_id !== params.expected_content_id ||
          !sameInode(fstatSync(fd!), lstatSync(target))
        )
          return this.finish(row, intent, 'conflict', final?.content_id ?? null, null)
      } else {
        try {
          fd = openSync(
            target,
            constants.O_WRONLY |
              constants.O_CREAT |
              constants.O_EXCL |
              constants.O_NOFOLLOW |
              constants.O_NONBLOCK,
            0o644
          )
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'EEXIST')
            return this.finish(row, intent, 'conflict', current()?.content_id ?? null)
          core.transaction(() =>
            core.db
              .prepare('DELETE FROM file_mutations WHERE principal_id=? AND operation_id=?')
              .run(row.principal_id, row.operation_id)
          )
          throw new ChannelError('file_not_writable')
        }
      }
      let state: FileMutationResult['state'] = 'outcome_unknown'
      try {
        ftruncateSync(fd!, 0)
        this.fault?.('after_truncate')
        for (let offset = 0; offset < bytes.length;) {
          const n = writeSync(fd!, bytes, offset, bytes.length - offset)
          if (!n) throw new Error('short_file_write')
          offset += n
        }
        fsyncSync(fd!)
        if (!initial) this.syncDirectory(target)
        this.fault?.('after_write')
        const actual = current()
        if (
          actual?.content_id === intent.content_id &&
          sameInode(fstatSync(fd!), lstatSync(target))
        )
          state = 'saved'
      } catch (e) {
        if (e instanceof Error && !('code' in e) && !(e instanceof ChannelError)) throw e // injected crash
        if (e instanceof ChannelError && e.code === 'storage_unavailable') throw e
        // A partial write is never a clean rejection: the durable copy is the recovery exit.
      }
      return this.finish(row, intent, state)
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
}
