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
  readSync,
  opendirSync,
  unlinkSync,
  mkdirSync,
  chmodSync,
  linkSync,
  renameSync,
  rmdirSync,
} from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { ChannelError, type AuthorityContext } from '@abele/channel-protocol'
import {
  FileOperationMethodSchemas,
  FileOperationResultSchema,
  type FileOperationMethod,
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
type OperationIntent = {
  kind: 'file_operation'
  method: FileOperationMethod
  params: Record<string, unknown>
  recovery_path: string | null
}
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
  /** A confirmation manifest, bounded independently of the ordinary file editor. */
  directory(id: string, path: string, repository = false) {
    const { content_id, entries } = this.directorySnapshot(id, path, repository)
    return {
      content_id,
      entries: entries.map(({ path, kind, content_id }) => ({ path, kind, content_id })),
    }
  }
  private directorySnapshot(id: string, path: string, repository: boolean) {
    if (!repository) this.plainFileTarget(id)
    const root = this.r.files.childTarget(id, path, repository)
    const entries: {
      path: string
      kind: 'file' | 'directory'
      content_id: string | null
      bytes: string | null
      dev: number
      ino: number
    }[] = []
    let size = 0
    const visit = (relative: string, depth: number) => {
      if (entries.length >= 256 || depth > 32) throw new ChannelError('output_limit')
      const absolute = join(root, relative),
        before = lstatSync(absolute)
      if (
        before.isSymbolicLink() ||
        realpathSync(absolute) !== absolute ||
        (!before.isFile() && !before.isDirectory())
      )
        throw new ChannelError('unsafe_path')
      if (!relative && !before.isDirectory()) throw new ChannelError('unsafe_path')
      let bytes: Buffer | null = null
      if (before.isFile()) {
        size += before.size
        if (size > 8 * 1024 * 1024) throw new ChannelError('file_too_large')
        const fd = openSync(
          absolute,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        )
        try {
          const opened = fstatSync(fd)
          if (!opened.isFile() || !sameInode(before, opened) || opened.size !== before.size)
            throw new ChannelError('stale_revision')
          bytes = Buffer.alloc(opened.size)
          let offset = 0
          while (offset < bytes.length) {
            const n = readSync(fd, bytes, offset, bytes.length - offset, offset)
            if (!n) throw new ChannelError('stale_revision')
            offset += n
          }
          const after = fstatSync(fd)
          if (
            after.size !== opened.size ||
            after.mtimeMs !== opened.mtimeMs ||
            after.ctimeMs !== opened.ctimeMs ||
            !sameInode(after, lstatSync(absolute))
          )
            throw new ChannelError('stale_revision')
        } finally {
          closeSync(fd)
        }
      }
      entries.push({
        path: relative,
        kind: before.isDirectory() ? 'directory' : 'file',
        content_id: bytes ? hash(bytes) : null,
        bytes: bytes?.toString('base64') ?? null,
        dev: before.dev,
        ino: before.ino,
      })
      if (before.isDirectory()) {
        const directory = opendirSync(absolute),
          names: string[] = []
        try {
          for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
            if (names.length + entries.length >= 256) throw new ChannelError('output_limit')
            names.push(entry.name)
          }
        } finally {
          directory.closeSync()
        }
        for (const name of names.sort()) {
          if (name.toLowerCase() === '.git') throw new ChannelError('unsafe_path')
          visit(relative ? relative + '/' + name : name, depth + 1)
        }
        const after = lstatSync(absolute)
        if (
          !sameInode(before, after) ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
        )
          throw new ChannelError('stale_revision')
      }
    }
    visit('', 0)
    return {
      root,
      entries,
      content_id: hash(
        canonical(entries.map(({ path, kind, content_id }) => ({ path, kind, content_id })))
      ),
    }
  }
  fault?: (point: 'before_check' | 'after_intent' | 'after_truncate' | 'after_write') => void
  operationFault?: (point: 'after_intent' | 'destination_created' | 'source_removed') => void
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
  fileOperation(
    actor: AuthorityContext,
    method: FileOperationMethod,
    params: Record<string, unknown>,
    operation?: string
  ) {
    return this.schedule(async () => {
      const previous = this.r.core.operationReceipt(actor, method, params, operation)
      if (previous) return previous.result
      const pending = this.r.core.db
        .prepare('SELECT * FROM file_mutations WHERE principal_id=? AND operation_id=?')
        .get(actor.installation_id, operation!) as IntentRow | undefined
      if (pending)
        return this.finishOperation(
          pending,
          JSON.parse(pending.body) as OperationIntent,
          'outcome_unknown'
        )
      if (!params.worktree_id) this.plainFileTarget(String(params.workspace_id))
      if (params.worktree_id) {
        for (const path of [params.path, params.from, params.to].filter((p) => p !== undefined))
          await this.r.repository.prepareEdit(actor, String(params.worktree_id), String(path))
      }
      return this.applyOperation(actor, method, params, operation!)
    })
  }
  private plainFileTarget(id: string) {
    const workspace = this.r.workspaces.get(id),
      project = this.r.projects.get(workspace.project_id)
    if (workspace.kind !== 'root' || project.repository_path || project.git_common_dir)
      throw new ChannelError('git_required')
  }
  private finishOperation(
    row: IntentRow,
    intent: OperationIntent,
    state: 'applied' | 'conflict' | 'outcome_unknown'
  ) {
    const result = FileOperationResultSchema.parse({
      operation_id: row.operation_id,
      state,
      recovery_path: intent.recovery_path,
    })
    return this.r.core.transaction(() => {
      const previous = this.r.core.storedOperationReceipt(
        row.principal_id,
        row.operation_id,
        row.request_hash
      )
      if (previous) {
        this.r.core.db
          .prepare('DELETE FROM file_mutations WHERE principal_id=? AND operation_id=?')
          .run(row.principal_id, row.operation_id)
        return previous.result
      }
      this.r.core.db
        .prepare('INSERT INTO operations VALUES(?,?,?,?)')
        .run(row.principal_id, row.operation_id, row.request_hash, JSON.stringify(result))
      this.r.core.db
        .prepare('DELETE FROM file_mutations WHERE principal_id=? AND operation_id=?')
        .run(row.principal_id, row.operation_id)
      if (intent.params.worktree_id) {
        const target = this.r.core.db
          .prepare('SELECT project_id FROM repository_targets WHERE worktree_id=?')
          .get(String(intent.params.worktree_id)) as { project_id: string }
        this.r.core.append(
          'catalog',
          'repository.invalidated',
          { kind: 'installation', installation_id: row.principal_id },
          {
            project_id: target.project_id,
            worktree_id: intent.params.worktree_id,
            reason: 'filesystem',
            generation: randomUUID(),
          }
        )
      } else
        this.r.core.append(
          'catalog',
          'workspace.invalidated',
          { kind: 'installation', installation_id: row.principal_id },
          {
            workspace_id: intent.params.workspace_id,
            reason: 'filesystem',
            generation: randomUUID(),
          }
        )
      return result
    }, true)
  }
  private applyOperation(
    actor: AuthorityContext,
    method: FileOperationMethod,
    params: Record<string, unknown>,
    operation: string
  ) {
    const core = this.r.core,
      repository = params.worktree_id !== undefined,
      id = String(params.worktree_id ?? params.workspace_id)
    const previous = core.operationReceipt(actor, method, params, operation)
    if (previous) return previous.result
    const kind = method.split('.').at(-1)!,
      sourcePath = String(params.from ?? params.path),
      destPath = String(params.to ?? params.path)
    const intent: OperationIntent = { kind: 'file_operation', method, params, recovery_path: null }
    const row: IntentRow = {
      principal_id: actor.installation_id,
      operation_id: operation,
      request_hash: hash(canonical({ method, params })),
      body: '',
    }
    if (params.directory === true)
      return this.applyDirectory(
        actor,
        id,
        repository,
        sourcePath,
        destPath,
        kind,
        params,
        row,
        intent
      )
    const initial = kind === 'mkdir' ? null : this.current(id, sourcePath, repository)
    if (initial?.too_large) throw new ChannelError('file_too_large')
    if (kind !== 'mkdir' && initial?.content_id !== params.expected_content_id)
      return this.finishOperation(row, intent, 'conflict')
    const source =
      kind === 'mkdir' ? null : this.r.files.writeTarget(id, sourcePath, false, repository)
    const destination =
      kind === 'remove' ? null : this.r.files.childTarget(id, destPath, repository)
    const exists = (path: string) => {
      try {
        lstatSync(path)
        return true
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw e
      }
    }
    if (destination && exists(destination)) return this.finishOperation(row, intent, 'conflict')
    const parents = new Map<string, number>(),
      parentStamps = new Map<string, { dev: number; ino: number }>()
    let sourceFd: number | undefined, destinationFd: number | undefined
    const pin = (path: string) => {
      const parent = dirname(path)
      if (!parents.has(parent)) {
        const before = lstatSync(parent),
          fd = openSync(parent, constants.O_RDONLY | constants.O_NOFOLLOW)
        parents.set(parent, fd)
        parentStamps.set(parent, before)
        if (
          !sameInode(before, fstatSync(fd)) ||
          !before.isDirectory() ||
          realpathSync(parent) !== parent
        )
          throw new ChannelError('unsafe_path')
      }
    }
    const anchored = (path: string) =>
      process.platform === 'linux'
        ? `/proc/self/fd/${parents.get(dirname(path))!}/${basename(path)}`
        : path
    const recheck = () => {
      core.authority.check(actor, 'mutate', id)
      if (repository) this.r.repository.fileRoot(id)
      else this.plainFileTarget(id)
      for (const [parent, fd] of parents)
        if (
          realpathSync(parent) !== parent ||
          !sameInode(lstatSync(parent), fstatSync(fd)) ||
          !sameInode(parentStamps.get(parent)!, fstatSync(fd))
        )
          throw new ChannelError('unsafe_path')
      this.r.files.childTarget(id, kind === 'remove' ? sourcePath : destPath, repository)
      if (source) {
        const current = this.current(id, sourcePath, repository)
        if (
          current?.content_id !== params.expected_content_id ||
          !sameInode(fstatSync(sourceFd!), lstatSync(source))
        )
          throw new ChannelError('stale_revision')
      }
    }
    try {
      if (source) {
        pin(source)
        sourceFd = openSync(
          source,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
        )
        if (!fstatSync(sourceFd).isFile() || !sameInode(fstatSync(sourceFd), lstatSync(source)))
          throw new ChannelError('unsafe_path')
      }
      if (destination) pin(destination)
      if (
        kind === 'move' &&
        parentStamps.get(dirname(source!))!.dev !== parentStamps.get(dirname(destination!))!.dev
      )
        throw new ChannelError('unsafe_path')
      recheck()
      const bytes = initial
        ? this.r.files.bytes(id, initial.content_id!, repository)
        : Buffer.alloc(0)
      if (kind === 'move' || kind === 'remove')
        intent.recovery_path = this.retainCopy(id, sourcePath, bytes, repository)
      row.body = JSON.stringify(intent)
      const reserved = core.reserveOperation(actor, method, params, operation, () => {
        core.db
          .prepare('INSERT INTO file_mutations VALUES(?,?,?,?)')
          .run(row.principal_id, row.operation_id, row.request_hash, row.body)
      })
      if (reserved) return reserved.result
      this.operationFault?.('after_intent')
      try {
        recheck()
        if (kind === 'mkdir') mkdirSync(anchored(destination!), { mode: 0o755 })
        else if (kind === 'copy') {
          destinationFd = openSync(
            anchored(destination!),
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
            0o644
          )
          for (let offset = 0; offset < bytes.length;) {
            const n = writeSync(destinationFd, bytes, offset, bytes.length - offset)
            if (!n) throw new Error('short_file_write')
            offset += n
          }
          fsyncSync(destinationFd)
        } else if (kind === 'move') {
          // Exclusive hard-link publication is a same-target move, never an overwriting rename.
          linkSync(anchored(source!), anchored(destination!))
          if (!sameInode(fstatSync(sourceFd!), lstatSync(destination!)))
            throw new ChannelError('stale_revision')
          fsyncSync(parents.get(dirname(destination!))!)
          this.operationFault?.('destination_created')
          recheck()
          unlinkSync(anchored(source!))
          this.operationFault?.('source_removed')
        } else {
          unlinkSync(anchored(source!))
          this.operationFault?.('source_removed')
        }
        for (const fd of parents.values()) fsyncSync(fd)
        if (kind === 'copy' || kind === 'mkdir') this.operationFault?.('destination_created')
        if (source && (kind === 'move' || kind === 'remove') && exists(source))
          return this.finishOperation(row, intent, 'outcome_unknown')
        if (
          destination &&
          kind === 'move' &&
          !sameInode(fstatSync(sourceFd!), lstatSync(destination))
        )
          return this.finishOperation(row, intent, 'outcome_unknown')
        if (
          destination &&
          kind === 'copy' &&
          !sameInode(fstatSync(destinationFd!), lstatSync(destination))
        )
          return this.finishOperation(row, intent, 'outcome_unknown')
        if (destination) {
          this.r.files.childTarget(id, destPath, repository)
          if (
            kind !== 'mkdir' &&
            this.current(id, destPath, repository)?.content_id !== params.expected_content_id
          )
            return this.finishOperation(row, intent, 'outcome_unknown')
        }
        for (const [parent, fd] of parents)
          if (!sameInode(lstatSync(parent), fstatSync(fd)))
            return this.finishOperation(row, intent, 'outcome_unknown')
        return this.finishOperation(row, intent, 'applied')
      } catch (e) {
        if (e instanceof Error && !('code' in e) && !(e instanceof ChannelError)) throw e
        if ((e as NodeJS.ErrnoException).code === 'EEXIST')
          return this.finishOperation(row, intent, 'conflict')
        return this.finishOperation(row, intent, 'outcome_unknown')
      }
    } finally {
      if (sourceFd !== undefined) closeSync(sourceFd)
      if (destinationFd !== undefined) closeSync(destinationFd)
      for (const fd of parents.values()) closeSync(fd)
    }
  }
  private schedule(work: () => unknown) {
    const task = this.serial.then(work)
    this.serial = task.catch(() => {})
    return task
  }
  private applyDirectory(
    actor: AuthorityContext,
    id: string,
    repository: boolean,
    sourcePath: string,
    destPath: string,
    kind: string,
    params: Record<string, unknown>,
    row: IntentRow,
    intent: OperationIntent
  ) {
    if (kind !== 'move' && kind !== 'remove') throw new ChannelError('invalid_params')
    const snapshot = this.directorySnapshot(id, sourcePath, repository)
    if (snapshot.content_id !== params.expected_content_id)
      return this.finishOperation(row, intent, 'conflict')
    const destination = kind === 'move' ? this.r.files.childTarget(id, destPath, repository) : null
    const exists = (path: string) => {
      try {
        lstatSync(path)
        return true
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false
        throw e
      }
    }
    if (
      destination &&
      (destination === snapshot.root ||
        destination.startsWith(snapshot.root + '/') ||
        exists(destination))
    )
      return this.finishOperation(row, intent, 'conflict')
    const parents = new Map<string, number>()
    const checkParents = () => {
      this.r.core.authority.check(actor, 'mutate', id)
      this.r.files.root(id, repository)
      for (const [path, fd] of parents)
        if (realpathSync(path) !== path || !sameInode(fstatSync(fd), lstatSync(path)))
          throw new ChannelError('unsafe_path')
    }
    try {
      for (const path of new Set([
        dirname(snapshot.root),
        ...(destination ? [dirname(destination)] : []),
      ])) {
        const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        parents.set(path, fd)
        if (!fstatSync(fd).isDirectory()) throw new ChannelError('unsafe_path')
      }
      checkParents()
      if (
        destination &&
        fstatSync(parents.get(dirname(destination))!).dev !==
          fstatSync(parents.get(dirname(snapshot.root))!).dev
      )
        throw new ChannelError('unsafe_path')
      // Keep a bounded, complete manifest and file bytes before any destructive effect.
      intent.recovery_path = this.retainCopy(
        id,
        sourcePath,
        Buffer.from(JSON.stringify({ format: 'directory-v1', entries: snapshot.entries })),
        repository
      )
      row.body = JSON.stringify(intent)
      const reserved = this.r.core.reserveOperation(
        actor,
        intent.method,
        params,
        row.operation_id,
        () => {
          this.r.core.db
            .prepare('INSERT INTO file_mutations VALUES(?,?,?,?)')
            .run(row.principal_id, row.operation_id, row.request_hash, row.body)
        }
      )
      if (reserved) return reserved.result
      this.operationFault?.('after_intent')
      try {
        checkParents()
        const current = this.directorySnapshot(id, sourcePath, repository)
        if (
          current.content_id !== snapshot.content_id ||
          canonical(current.entries) !== canonical(snapshot.entries)
        )
          return this.finishOperation(row, intent, 'conflict')
        if (destination) {
          if (exists(destination)) return this.finishOperation(row, intent, 'conflict')
          renameSync(snapshot.root, destination)
          this.operationFault?.('destination_created')
          if (!sameInode(snapshot.entries[0]!, lstatSync(destination)))
            throw new ChannelError('stale_revision')
        } else {
          for (const entry of [...snapshot.entries].reverse()) {
            checkParents()
            const absolute = join(snapshot.root, entry.path)
            if (realpathSync(absolute) !== absolute || !sameInode(entry, lstatSync(absolute)))
              throw new ChannelError('unsafe_path')
            if (entry.kind === 'directory') rmdirSync(absolute)
            else {
              // Check each file again immediately before unlinking; never recurse through a link.
              if (
                this.current(id, sourcePath + '/' + entry.path, repository)?.content_id !==
                entry.content_id
              )
                throw new ChannelError('stale_revision')
              unlinkSync(absolute)
            }
          }
        }
        this.operationFault?.('source_removed')
        for (const fd of parents.values()) fsyncSync(fd)
        checkParents()
        return this.finishOperation(row, intent, 'applied')
      } catch (e) {
        if (e instanceof Error && !('code' in e) && !(e instanceof ChannelError)) throw e
        return this.finishOperation(row, intent, 'outcome_unknown')
      }
    } finally {
      for (const fd of parents.values()) closeSync(fd)
    }
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
    return this.r.core.transaction(() => {
      const previous = this.r.core.storedOperationReceipt(
        row.principal_id,
        row.operation_id,
        row.request_hash
      )
      if (previous) {
        this.r.core.db
          .prepare('DELETE FROM file_mutations WHERE principal_id=? AND operation_id=?')
          .run(row.principal_id, row.operation_id)
        return previous.result
      }
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
      return result
    }, true)
  }
  private recoverySweep?: { directory: ReturnType<typeof opendirSync>; relative: string }[]
  close() {
    for (const cursor of this.recoverySweep ?? []) cursor.directory.closeSync()
    this.recoverySweep = []
  }
  /** Orphan cleanup is maintenance, not a reason to read all retained copies at boot. */
  sweepRecoveryFiles() {
    if (!this.recoverySweep) {
      const root = join(this.r.core.stateDir, 'file-recovery')
      this.recoverySweep = []
      try {
        const stat = lstatSync(root)
        if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ChannelError('unsafe_path')
        this.recoverySweep.push({ directory: opendirSync(root), relative: 'file-recovery' })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
    }
    for (let remaining = 128; remaining > 0 && this.recoverySweep.length; remaining--) {
      const cursor = this.recoverySweep.at(-1)!
      const entry = cursor.directory.readSync()
      if (!entry) {
        cursor.directory.closeSync()
        this.recoverySweep.pop()
        continue
      }
      const path = cursor.relative + '/' + entry.name
      const target = join(this.r.core.stateDir, path)
      if (entry.isDirectory()) {
        if (realpathSync(target) !== target) throw new ChannelError('unsafe_path')
        this.recoverySweep.push({ directory: opendirSync(target), relative: path })
      } else if (
        !this.r.core.db
          .prepare(
            'SELECT 1 FROM file_recovery_copies WHERE path=? UNION ALL SELECT 1 FROM repository_recovery_copies WHERE path=? LIMIT 1'
          )
          .get(path, path)
      ) {
        unlinkSync(target)
        this.syncDirectory(target)
      }
    }
  }
  recover() {
    this.sweepRecoveryFiles()
    for (const row of this.r.core.db
      .prepare('SELECT * FROM file_mutations')
      .iterate() as Iterable<IntentRow>) {
      const raw = JSON.parse(row.body) as Intent | OperationIntent
      if (raw.kind === 'file_operation') {
        const params = FileOperationMethodSchemas[raw.method].parse(raw.params)
        this.finishOperation(row, { ...raw, params }, 'outcome_unknown')
        continue
      }
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
      const reserved = core.reserveOperation(actor, method, params, operation!, () => {
        core.authority.check(actor, method, workspace)
        core.db
          .prepare('INSERT INTO file_mutations VALUES(?,?,?,?)')
          .run(row.principal_id, row.operation_id, row.request_hash, row.body)
      })
      if (reserved) return reserved.result
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
