import { createHash, randomUUID } from 'node:crypto'
import { accessSync, constants, existsSync, lstatSync, realpathSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { ChannelError, type AuthorityContext } from '@abele/channel-protocol'
import {
  GIT_WRITE_ERROR_MESSAGES,
  REPOSITORY_GIT_MUTATIONS,
  type GitFailureCode,
  type GitInfo,
} from '@abele/node-protocol'
import type { ResourceServices } from './resources.js'
import type { RepositoryTarget } from './repository.js'
import { canonical } from './index.js'
import { OwnerGit, stripCredentials } from './git-owner.js'
import { createBranch, fetchRemote } from './repository-git-refs.js'

const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')
type Params = Record<string, unknown>
type Operation = 'rebase' | 'merge' | 'cherry-pick' | 'revert'
export interface Failure {
  state: 'failed'
  code: GitFailureCode
  message: string
  output: string
}
export const fail = (code: GitFailureCode, output = ''): Failure => ({
  state: 'failed',
  code,
  message: GIT_WRITE_ERROR_MESSAGES[code] ?? code,
  output: output.slice(-4096),
})
export const AUTH =
  /Authentication failed|Permission denied|could not read (Username|Password)|terminal prompts disabled|Invalid username or password|The requested URL returned error: 40[13]|Repository not found|access denied/i
export const UNREACHABLE =
  /Could not resolve host|Connection refused|Connection timed out|Operation timed out|Network is unreachable|unable to access|Could not read from remote repository|does not appear to be a git repository|No such device or address/i
const STALE = /\(stale info\)/
const REJECTED = /\[rejected\]|\(fetch first\)|non-fast-forward|\[remote rejected\]/i
const HOOK = /hook declined|pre-push hook|hook .* failed/i
/** A remote name we are willing to pass as an argument: never option-like. */
export const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
export const COMMIT = /^[a-f0-9]{40,64}$/

/** Remove credentials from a remote URL; scp-like and ssh users are not secrets. */
export function sanitizeRemoteUrl(url: string) {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/([^/]*@)?(.*)$/i.exec(url)
  if (!scheme) return stripCredentials(url)
  const [, protocol, userinfo, rest] = scheme
  const keepUser =
    /^ssh$|^git\+ssh$|^ssh\+git$/i.test(protocol!) && userinfo && !userinfo.includes(':')
  return `${protocol}://${keepUser ? userinfo : ''}${rest}`.replace(/[?#].*$/, '')
}
/** Which hosted repository a remote is, when it looks like one. */
export function remoteForge(url: string): GitInfo['remotes'][number]['forge'] {
  const match =
    /^(?:https?|ssh|git|git\+ssh|ssh\+git):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/*$/i.exec(
      url
    ) ?? /^(?:[^@/:]+@)?([^/:]+):(?!\/)(.+?)(?:\.git)?\/*$/.exec(url)
  if (!match) return null
  const host = match[1]!.toLowerCase(),
    parts = match[2]!.split('/').filter(Boolean)
  if (parts.length < 2 || !host.includes('.')) return null
  return {
    kind:
      host === 'github.com' || host.endsWith('.github.com')
        ? 'github'
        : host.includes('gitlab')
          ? 'gitlab'
          : 'other',
    host: host.replace(/^ssh\.(github\.com)$/, '$1'),
    owner: parts.slice(0, -1).join('/'),
    name: parts[parts.length - 1]!,
  }
}

/**
 * Explicit owner git writes on a repository target: stage, discard, commit, update from base,
 * push. Authority is the target's editing permission; each write is a durable operation whose
 * interrupted effect settles as `outcome_unknown` and is never replayed.
 */
export class RepositoryGitService {
  readonly owner: OwnerGit
  /** Test hook: runs after the durable intent and before the git effect. */
  fault?: (method: string) => void | Promise<void>
  constructor(private r: ResourceServices) {
    this.owner = new OwnerGit(r.git.executable)
    r.core.db.exec(
      `CREATE TABLE IF NOT EXISTS repository_git_effects(principal_id TEXT NOT NULL, operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, PRIMARY KEY(principal_id,operation_id));`
    )
    // Effects a previous run did not finish: settled as unknown, never repeated.
    for (const row of r.core.db.prepare('SELECT * FROM repository_git_effects').all() as {
      principal_id: string
      operation_id: string
      request_hash: string
    }[])
      r.core.transaction(() => {
        r.core.db
          .prepare('INSERT OR IGNORE INTO operations VALUES(?,?,?,?)')
          .run(
            row.principal_id,
            row.operation_id,
            row.request_hash,
            JSON.stringify({ state: 'outcome_unknown' })
          )
        r.core.db
          .prepare('DELETE FROM repository_git_effects WHERE principal_id=? AND operation_id=?')
          .run(row.principal_id, row.operation_id)
      })
  }
  handles(method: string) {
    return method.startsWith('repository.v1.git.')
  }
  isMutation(method: string) {
    return (REPOSITORY_GIT_MUTATIONS as readonly string[]).includes(method)
  }
  async request(actor: AuthorityContext, method: string, p: Params, operation?: string) {
    if (method === 'repository.v1.git.info') return this.info(actor, p)
    if (!this.isMutation(method)) throw new ChannelError('unsupported_method')
    if (!operation || operation.length > 128) throw new ChannelError('operation_id_required')
    const core = this.r.core
    const previous = core.operationReceipt(actor, method, p, operation)
    if (previous) return previous.result
    const target = await this.r.repository.writableTarget(actor, String(p.worktree_id))
    // One write at a time per worktree; a retry waits for the effect it repeats.
    return this.r.git.serialize('git-write:' + target.path, async () => {
      const previous = core.operationReceipt(actor, method, p, operation)
      if (previous) return previous.result
      const pending = core.db
        .prepare(
          'SELECT request_hash FROM repository_git_effects WHERE principal_id=? AND operation_id=?'
        )
        .get(actor.installation_id, operation) as { request_hash: string } | undefined
      if (pending) {
        if (pending.request_hash !== hash({ method, params: p }))
          throw new ChannelError('idempotency_mismatch')
        return this.finish(actor, method, p, operation, target, { state: 'outcome_unknown' })
      }
      let started = false
      const effect = async () => {
        this.r.repository.checkWritable(actor, target.worktree_id)
        const reserved = core.reserveOperation(actor, method, p, operation, () => {
          core.db
            .prepare('INSERT INTO repository_git_effects VALUES(?,?,?)')
            .run(actor.installation_id, operation, hash({ method, params: p }))
        })
        if (reserved) throw new Replayed(reserved.result)
        started = true
        await this.fault?.(method)
      }
      let result: unknown
      try {
        result = await this.operate(actor, method, p, target, effect)
      } catch (e) {
        if (e instanceof Replayed) return e.result
        if (!started) throw e
        result = { state: 'outcome_unknown' }
      }
      return this.finish(actor, method, p, operation, target, result)
    })
  }
  private finish(
    actor: AuthorityContext,
    method: string,
    p: Params,
    operation: string,
    target: RepositoryTarget,
    result: unknown
  ) {
    const receipt = this.r.core.commitOperation(actor, method, p, operation, () => {
      this.r.core.db
        .prepare('DELETE FROM repository_git_effects WHERE principal_id=? AND operation_id=?')
        .run(actor.installation_id, operation)
      return result
    })
    try {
      this.r.repository.gitChanged(actor, target)
    } catch {
      // A refresh hint is best effort; the receipt is what the client relies on.
    }
    return receipt
  }
  private operate(
    actor: AuthorityContext,
    method: string,
    p: Params,
    target: RepositoryTarget,
    effect: () => Promise<void>
  ): Promise<unknown> {
    switch (method) {
      case 'repository.v1.git.stage':
        return this.stage(p, target, effect)
      case 'repository.v1.git.unstage':
        return this.unstage(p, target, effect)
      case 'repository.v1.git.discard':
        return this.discard(actor, p, target, effect)
      case 'repository.v1.git.commit':
        return this.commit(p, target, effect)
      case 'repository.v1.git.update':
        return this.update(actor, p, target, effect)
      case 'repository.v1.git.continue':
        return this.continue(p, target, effect)
      case 'repository.v1.git.abort':
        return this.abort(p, target, effect)
      case 'repository.v1.git.push':
        return this.push(p, target, effect)
      case 'repository.v1.git.fetch':
        return fetchRemote(this, p, target, effect)
      case 'repository.v1.git.create_branch':
        return createBranch(this, p, target, effect)
      default:
        throw new ChannelError('unsupported_method')
    }
  }
  git(target: RepositoryTarget, args: string[], options?: Parameters<OwnerGit['run']>[2]) {
    return this.owner.run(target.path, args, { timeoutMs: 15000, ...options })
  }
  async text(target: RepositoryTarget, args: string[]) {
    const r = await this.git(target, args, { probe: true })
    return r.code === 0 ? r.stdout.toString('utf8').trim() : null
  }
  async expectHead(target: RepositoryTarget, expected: unknown) {
    const head = await this.r.repository.headOf(target)
    if (head !== expected) throw new ChannelError('stale_revision')
    return head
  }
  async branch(target: RepositoryTarget) {
    return this.text(target, ['symbolic-ref', '--quiet', 'HEAD'])
  }
  async operation(target: RepositoryTarget): Promise<Operation | null> {
    const dir = (await this.r.git.text(target.path, { kind: 'directory' })).trim()
    if (existsSync(join(dir, 'rebase-merge')) || existsSync(join(dir, 'rebase-apply')))
      return 'rebase'
    if (existsSync(join(dir, 'MERGE_HEAD'))) return 'merge'
    if (existsSync(join(dir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick'
    if (existsSync(join(dir, 'REVERT_HEAD'))) return 'revert'
    return null
  }
  async conflicted(target: RepositoryTarget) {
    const r = await this.git(target, ['diff', '--name-only', '--diff-filter=U', '-z'], {
      probe: true,
    })
    if (r.code !== 0) throw new ChannelError('git_failed')
    return [...new Set(r.stdout.toString('utf8').split('\0').filter(Boolean))].slice(0, 1000)
  }
  private async author(target: RepositoryTarget) {
    const ident = await this.text(target, ['var', 'GIT_AUTHOR_IDENT'])
    const match = ident && /^(.*) <(.*)> \d+ [+-]\d{4}$/.exec(ident)
    return match && match[1] && match[2] ? { name: match[1], email: match[2] } : null
  }
  async remotes(target: RepositoryTarget) {
    const names = ((await this.text(target, ['remote'])) ?? '')
      .split('\n')
      .map((n) => n.trim())
      .filter(Boolean)
    return names.filter((n) => REMOTE.test(n)).slice(0, 32)
  }
  async upstream(target: RepositoryTarget, branch: string) {
    const row = await this.text(target, [
      'for-each-ref',
      '--format=%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)',
      branch,
    ])
    if (!row) return null
    const [ref, remote, remoteRef] = row.split('\0')
    return ref && remote && remoteRef ? { ref, remote, branch: remoteRef } : null
  }
  /** The branch's upstream with its local remote-tracking commit and ahead/behind (no fetch). */
  async tracking(
    target: RepositoryTarget,
    head: string | null,
    branch: string
  ): Promise<GitInfo['upstream']> {
    const tracked = await this.upstream(target, branch)
    if (!tracked) return null
    let ahead: number | null = null,
      behind: number | null = null
    const remoteHead = await this.text(target, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      tracked.ref + '^{commit}',
    ])
    const commit = remoteHead && COMMIT.test(remoteHead) ? remoteHead : null
    if (head && commit) {
      const counts = (
        (await this.text(target, [
          'rev-list',
          '--left-right',
          '--count',
          `${head}...${commit}`,
          '--',
        ])) ?? ''
      )
        .split(/\s+/)
        .map(Number)
      if (counts.length === 2 && counts.every((n) => Number.isSafeInteger(n) && n >= 0))
        [ahead, behind] = counts as [number, number]
    }
    return { ...tracked, commit, ahead, behind }
  }
  private async hasHook(target: RepositoryTarget, names: string[]) {
    const configured = await this.text(target, ['config', '--get', 'core.hooksPath'])
    const hooks = configured
      ? isAbsolute(configured)
        ? configured
        : join(target.path, configured)
      : await this.text(target, ['rev-parse', '--path-format=absolute', '--git-path', 'hooks'])
    if (!hooks) return false
    return names.some((name) => {
      try {
        accessSync(join(hooks, name), constants.X_OK)
        return true
      } catch {
        return false
      }
    })
  }
  private async stage(p: Params, target: RepositoryTarget, effect: () => Promise<void>) {
    const head = await this.expectHead(target, p.expected_head)
    await effect()
    const r = await this.git(
      target,
      p.all ? ['add', '--all'] : ['add', '--all', '--', ...(p.paths as string[])],
      { timeoutMs: 60000 }
    )
    return r.code === 0 ? { state: 'applied', head } : fail('git_failed', r.output)
  }
  private async unstage(p: Params, target: RepositoryTarget, effect: () => Promise<void>) {
    const head = await this.expectHead(target, p.expected_head)
    const paths = p.all ? ['.'] : (p.paths as string[])
    await effect()
    const r = await this.git(
      target,
      head === null
        ? ['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', ...paths]
        : ['restore', '--staged', '--', ...paths],
      { timeoutMs: 60000 }
    )
    return r.code === 0 ? { state: 'applied', head } : fail('git_failed', r.output)
  }
  /** Delete an untracked regular file or link without following links on the way to it. */
  private removeUntracked(target: RepositoryTarget, path: string) {
    let full = target.path
    for (const part of path.split('/').slice(0, -1)) {
      full = join(full, part)
      const s = lstatSync(full)
      if (s.isSymbolicLink() || !s.isDirectory()) throw new ChannelError('unsafe_path')
    }
    if (realpathSync(dirname(join(target.path, path))) !== dirname(join(target.path, path)))
      throw new ChannelError('unsafe_path')
    const file = join(target.path, path),
      s = lstatSync(file)
    if (!s.isFile() && !s.isSymbolicLink()) throw new ChannelError('unsafe_path')
    unlinkSync(file)
  }
  private async discard(
    actor: AuthorityContext,
    p: Params,
    target: RepositoryTarget,
    effect: () => Promise<void>
  ) {
    if (p.confirmed !== true) throw new ChannelError('confirmation_required')
    const rows = await this.r.repository.observedChanges(
      actor,
      target,
      String(p.expected_observation_id),
      [...new Set(p.paths as string[])]
    )
    if (
      rows.some(
        (r) =>
          r.index === 'U' ||
          r.worktree === 'U' ||
          (r.index === 'A' && r.worktree === 'A') ||
          (r.index === 'D' && r.worktree === 'D')
      )
    )
      return fail('conflicted')
    const head = await this.r.repository.headOf(target)
    const untracked = rows.filter((r) => r.index === '?').map((r) => r.path)
    const tracked = rows.filter((r) => r.index !== '?' && r.index !== '!')
    // Paths the index added: with staged changes discarded they leave the index and the disk.
    const added = p.include_staged
      ? tracked.filter((r) => head === null || 'ARC'.includes(r.index)).map((r) => r.path)
      : []
    const restore = p.include_staged
      ? tracked.filter((r) => !added.includes(r.path)).map((r) => r.path)
      : tracked.filter((r) => r.worktree !== ' ').map((r) => r.path)
    await effect()
    if (restore.length) {
      const r = await this.git(
        target,
        p.include_staged
          ? ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...restore]
          : ['restore', '--worktree', '--', ...restore],
        { timeoutMs: 60000 }
      )
      if (r.code !== 0) return fail('git_failed', r.output)
    }
    if (added.length) {
      const r = await this.git(target, ['rm', '--cached', '--quiet', '--', ...added])
      if (r.code !== 0) return fail('git_failed', r.output)
      for (const path of added)
        try {
          this.removeUntracked(target, path)
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
        }
    }
    for (const path of untracked) this.removeUntracked(target, path)
    return {
      state: 'applied',
      head,
      discarded: rows
        .filter(
          (r) => untracked.includes(r.path) || added.includes(r.path) || restore.includes(r.path)
        )
        .map((r) => r.path),
    }
  }
  private async commit(p: Params, target: RepositoryTarget, effect: () => Promise<void>) {
    const parent = await this.expectHead(target, p.expected_head)
    if (await this.operation(target)) return fail('operation_in_progress')
    if ((await this.conflicted(target)).length) return fail('conflicted')
    const staged = await this.git(target, [
      'diff',
      '--cached',
      '--quiet',
      '--ignore-submodules=none',
    ])
    if (staged.code === 0) return fail('nothing_staged')
    if (staged.code !== 1) return fail('git_failed', staged.output)
    const author = await this.author(target)
    if (!author) return fail('identity_missing')
    await effect()
    const r = await this.git(target, ['commit', '--file=-'], {
      stdin: String(p.message),
      timeoutMs: 120000,
    })
    const head = await this.r.repository.headOf(target)
    if (head && head !== parent) return { state: 'committed', commit: head, parent, author }
    if (await this.hasHook(target, ['pre-commit', 'prepare-commit-msg', 'commit-msg']))
      return fail('hook_failed', r.output)
    return fail('commit_failed', r.output)
  }
  private async update(
    actor: AuthorityContext,
    p: Params,
    target: RepositoryTarget,
    effect: () => Promise<void>
  ) {
    const previous = await this.expectHead(target, p.expected_head)
    if (await this.operation(target)) return fail('operation_in_progress')
    if (!(await this.branch(target))) return fail('detached_head')
    const dirty = await this.git(target, [
      'status',
      '--porcelain',
      '-z',
      '--untracked-files=no',
      '--ignore-submodules=all',
    ])
    if (dirty.code !== 0) return fail('git_failed', dirty.output)
    if (dirty.stdout.length) return fail('workspace_dirty')
    const base =
      (p.base_ref as string | undefined) ?? (await this.r.repository.defaultBranchOf(actor, target))
    if (!base) return fail('default_branch_required')
    const remotes = await this.remotes(target)
    const exists = async (ref: string) =>
      (
        await this.git(target, [
          'rev-parse',
          '--verify',
          '--quiet',
          '--end-of-options',
          ref + '^{commit}',
        ])
      ).code === 0
    const candidates = base.startsWith('refs/')
      ? [base]
      : ['refs/remotes/' + base, 'refs/heads/' + base]
    let full: string | undefined
    let remote: { name: string; branch: string } | undefined
    for (const candidate of candidates) {
      const name = remotes
        .filter((r) => candidate.startsWith(`refs/remotes/${r}/`))
        .sort((a, b) => b.length - a.length)[0]
      if (name && REMOTE.test(name)) {
        full = candidate
        remote = { name, branch: candidate.slice(`refs/remotes/${name}/`.length) }
        break
      }
      if (!candidate.startsWith('refs/remotes/') && (await exists(candidate))) {
        full = candidate
        break
      }
    }
    if (!full) return fail('base_not_found')
    let forkPoint: string | null = null
    if (remote && previous) {
      const fork = await this.text(target, ['merge-base', '--fork-point', full, 'HEAD'])
      forkPoint = fork && COMMIT.test(fork) ? fork : null
    }
    await effect()
    const scratch = `refs/abele/update/${randomUUID()}`
    try {
      let baseCommit: string | null
      if (remote) {
        const fetch = await this.git(
          target,
          [
            'fetch',
            '--no-tags',
            '--no-write-fetch-head',
            remote.name,
            `+refs/heads/${remote.branch}:${scratch}`,
            `+refs/heads/${remote.branch}:${full}`,
          ],
          { timeoutMs: 60000 }
        )
        if (fetch.code !== 0) {
          if (/couldn't find remote ref/i.test(fetch.output))
            return fail('base_not_found', fetch.output)
          if (AUTH.test(fetch.output)) return fail('auth_failed', fetch.output)
          if (UNREACHABLE.test(fetch.output)) return fail('remote_unreachable', fetch.output)
          return fail('fetch_failed', fetch.output)
        }
        baseCommit = await this.text(target, ['rev-parse', '--verify', '--quiet', scratch])
      } else
        baseCommit = await this.text(target, [
          'rev-parse',
          '--verify',
          '--quiet',
          full + '^{commit}',
        ])
      if (!baseCommit || !COMMIT.test(baseCommit)) return fail('base_not_found')
      const strategy = previous ? 'rebase' : 'fast-forward'
      const r = await this.git(
        target,
        previous
          ? forkPoint
            ? ['rebase', '--no-autostash', '--onto', baseCommit, forkPoint]
            : ['rebase', '--no-autostash', baseCommit]
          : ['merge', '--ff-only', baseCommit],
        { timeoutMs: 120000 }
      )
      if (r.code !== 0) {
        if ((await this.operation(target)) === 'rebase') {
          const conflicted_paths = await this.conflicted(target)
          if (conflicted_paths.length)
            return { state: 'conflicts', operation: 'rebase', base_ref: full, conflicted_paths }
          // Stopped for another reason: put the worktree back rather than leave it half-way.
          const abort = await this.git(target, ['rebase', '--abort'], { timeoutMs: 60000 })
          if (abort.code !== 0) throw new ChannelError('git_failed')
        }
        return fail(
          (await this.hasHook(target, ['pre-rebase'])) && /hook/i.test(r.output)
            ? 'hook_failed'
            : 'update_failed',
          r.output
        )
      }
      const head = await this.r.repository.headOf(target)
      return {
        state: 'updated',
        strategy,
        previous_head: previous,
        head,
        base_ref: full,
        base_commit: baseCommit,
        changed: head !== previous,
      }
    } finally {
      await this.git(target, ['update-ref', '-d', scratch]).catch(() => undefined)
    }
  }
  private async continue(p: Params, target: RepositoryTarget, effect: () => Promise<void>) {
    if ((await this.operation(target)) !== p.operation) return fail('no_operation')
    const operation = p.operation as 'rebase' | 'merge'
    let conflicted_paths = await this.conflicted(target)
    if (conflicted_paths.length)
      return { state: 'conflicts', operation, base_ref: null, conflicted_paths }
    await effect()
    const r = await this.git(target, [operation, '--continue'], { timeoutMs: 120000 })
    if (r.code !== 0) {
      conflicted_paths = (await this.operation(target)) ? await this.conflicted(target) : []
      if (conflicted_paths.length)
        return { state: 'conflicts', operation, base_ref: null, conflicted_paths }
      return fail('git_failed', r.output)
    }
    return { state: 'continued', head: await this.r.repository.headOf(target) }
  }
  private async abort(p: Params, target: RepositoryTarget, effect: () => Promise<void>) {
    const current = await this.operation(target)
    if (!current) return { state: 'not_in_progress', head: await this.r.repository.headOf(target) }
    if (current !== p.operation) return fail('no_operation')
    await effect()
    const r = await this.git(target, [String(p.operation), '--abort'], { timeoutMs: 60000 })
    if (r.code !== 0) return fail('git_failed', r.output)
    return { state: 'aborted', head: await this.r.repository.headOf(target) }
  }
  private async push(p: Params, target: RepositoryTarget, effect: () => Promise<void>) {
    const head = await this.expectHead(target, p.expected_head)
    const branch = await this.branch(target)
    if (!branch) return fail('detached_head')
    if (await this.operation(target)) return fail('operation_in_progress')
    const remotes = await this.remotes(target)
    if (!remotes.length) return fail('no_remote')
    const upstream = await this.upstream(target, branch)
    if (upstream && p.remote !== undefined && p.remote !== upstream.remote)
      return fail('upstream_mismatch')
    if (upstream && upstream.branch !== branch) return fail('upstream_mismatch')
    const remote =
      upstream?.remote ??
      (p.remote as string | undefined) ??
      (remotes.length === 1 ? remotes[0] : remotes.includes('origin') ? 'origin' : undefined)
    if (!remote) return fail('remote_required')
    if (!remotes.includes(remote)) return fail('no_remote')
    await effect()
    const r = await this.git(
      target,
      [
        'push',
        '--porcelain',
        ...(upstream ? [] : ['--set-upstream']),
        // Never a bare force: the remote branch is replaced only if it is still the commit
        // the client saw.
        ...(p.force_with_lease ? [`--force-with-lease=${branch}:${p.force_with_lease}`] : []),
        remote,
        `${branch}:${branch}`,
      ],
      { timeoutMs: 120000 }
    )
    if (r.code !== 0) {
      if (STALE.test(r.output)) return fail('lease_rejected', r.output)
      if (REJECTED.test(r.output)) return fail('push_rejected', r.output)
      if (HOOK.test(r.output)) return fail('hook_failed', r.output)
      if (AUTH.test(r.output)) return fail('auth_failed', r.output)
      if (UNREACHABLE.test(r.output)) return fail('remote_unreachable', r.output)
      return fail('push_failed', r.output)
    }
    const short = branch.replace(/^refs\/heads\//, '')
    return {
      state: 'pushed',
      remote,
      branch,
      upstream: (await this.upstream(target, branch))?.ref ?? `refs/remotes/${remote}/${short}`,
      set_upstream: !upstream,
      commit: head,
    }
  }
  private async info(actor: AuthorityContext, p: Params): Promise<GitInfo> {
    const target = await this.r.repository.readableTarget(actor, String(p.worktree_id))
    const head = await this.r.repository.headOf(target)
    const branch = await this.branch(target)
    const kind = await this.operation(target)
    const upstream = branch ? await this.tracking(target, head, branch) : null
    const remotes: GitInfo['remotes'] = []
    for (const name of await this.remotes(target)) {
      const raw = await this.text(target, ['remote', 'get-url', name])
      if (raw === null) continue
      const url = sanitizeRemoteUrl(raw)
      remotes.push({ name, url, forge: remoteForge(url) })
    }
    const result: GitInfo = {
      head,
      branch,
      detached: branch === null,
      operation: kind ? { kind, conflicted_paths: await this.conflicted(target) } : null,
      upstream,
      default_branch: await this.r.repository.defaultBranchOf(actor, target),
      remotes,
      author: await this.author(target),
    }
    await this.r.repository.readableTarget(actor, target.worktree_id)
    return result
  }
}
class Replayed {
  constructor(readonly result: unknown) {}
}
