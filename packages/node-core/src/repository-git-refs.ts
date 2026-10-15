import type { RepositoryTarget } from './repository.js'
import { AUTH, COMMIT, UNREACHABLE, fail, type RepositoryGitService } from './repository-git.js'

type Params = Record<string, unknown>
type Effect = () => Promise<void>

/** Every branch ref under `prefix` with its object (not `<remote>/HEAD`), to report what moved. */
async function refsUnder(git: RepositoryGitService, target: RepositoryTarget, prefix: string) {
  const text = await git.text(target, [
    'for-each-ref',
    '--format=%(refname) %(objectname) %(symref)',
    prefix,
  ])
  return new Map(
    (text ?? '')
      .split('\n')
      .map((line) => line.split(' '))
      .filter(([ref, object, symref]) => ref && object && !symref)
      .map(([ref, object]) => [ref!, object!])
  )
}

/**
 * Fetch one configured remote: `remote`, else `origin`, else the only remote. Never prunes
 * unless asked (`prune: true`), whatever `fetch.prune` says.
 */
export async function fetchRemote(
  git: RepositoryGitService,
  p: Params,
  target: RepositoryTarget,
  effect: Effect
) {
  const remotes = await git.remotes(target)
  if (!remotes.length) return fail('no_remote')
  const remote =
    (p.remote as string | undefined) ??
    (remotes.includes('origin') ? 'origin' : remotes.length === 1 ? remotes[0] : undefined)
  if (!remote) return fail('remote_required')
  if (!remotes.includes(remote)) return fail('no_remote')
  const prefix = `refs/remotes/${remote}/`
  const before = await refsUnder(git, target, prefix)
  await effect()
  const r = await git.git(target, ['fetch', p.prune ? '--prune' : '--no-prune', remote], {
    timeoutMs: 120000,
  })
  if (r.code !== 0) {
    if (AUTH.test(r.output)) return fail('auth_failed', r.output)
    if (UNREACHABLE.test(r.output)) return fail('remote_unreachable', r.output)
    return fail('fetch_failed', r.output)
  }
  const after = await refsUnder(git, target, prefix)
  const head = await git.text(target, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  const branch = await git.branch(target)
  return {
    state: 'fetched',
    remote,
    pruned: Boolean(p.prune),
    updated: [...after]
      .filter(([ref, object]) => before.get(ref) !== object)
      .map(([ref]) => ref)
      .slice(0, 1000),
    removed: [...before.keys()].filter((ref) => !after.has(ref)).slice(0, 1000),
    upstream: branch
      ? await git.tracking(target, head && COMMIT.test(head) ? head : null, branch)
      : null,
  }
}

/**
 * Create `refs/heads/<name>` at a commit, refusing a name git would not accept or one that
 * exists. With `switch`, a clean worktree is then switched to it; a failed switch removes the
 * new branch again, so the result is either both or neither.
 */
export async function createBranch(
  git: RepositoryGitService,
  p: Params,
  target: RepositoryTarget,
  effect: Effect
) {
  const name = String(p.name),
    ref = 'refs/heads/' + name,
    commit = String(p.start_point)
  if (p.switch) await git.expectHead(target, p.expected_head)
  // `HEAD` and `@` pass check-ref-format under refs/heads/ but name HEAD itself to git.
  if (
    name === 'HEAD' ||
    name === '@' ||
    (await git.git(target, ['check-ref-format', ref], { probe: true })).code !== 0
  )
    return fail('invalid_branch_name')
  if ((await git.git(target, ['show-ref', '--verify', '--quiet', ref], { probe: true })).code === 0)
    return fail('branch_exists')
  const object = await git.text(target, ['rev-parse', '--verify', '--quiet', commit + '^{commit}'])
  if (object !== commit) return fail('commit_not_found')
  if (p.switch) {
    if (target.kind === 'managed') return fail('managed_branch')
    if (await git.operation(target)) return fail('operation_in_progress')
    const dirty = await git.git(
      target,
      ['status', '--porcelain', '-z', '--untracked-files=no', '--ignore-submodules=all'],
      { probe: true }
    )
    if (dirty.code !== 0) return fail('git_failed', dirty.output)
    if (dirty.stdout.length) return fail('workspace_dirty')
  }
  await effect()
  // The empty old value makes the creation refuse a ref that appeared meanwhile.
  const created = await git.git(target, [
    'update-ref',
    '-m',
    'branch: Created from ' + commit,
    ref,
    commit,
    '',
  ])
  if (created.code !== 0)
    return (await git.git(target, ['show-ref', '--verify', '--quiet', ref], { probe: true }))
      .code === 0 || /exists|cannot lock/i.test(created.output)
      ? fail('branch_exists', created.output)
      : fail('git_failed', created.output)
  if (p.switch) {
    const r = await git.git(target, ['switch', '--quiet', '--no-guess', name], {
      timeoutMs: 120000,
    })
    // A post-checkout hook may fail after the switch happened; what counts is where HEAD is.
    if ((await git.branch(target)) !== ref) {
      // The branch was made for this switch: remove it, and only while it is still our commit.
      await git.git(target, ['update-ref', '-d', ref, commit]).catch(() => undefined)
      return fail('switch_failed', r.output)
    }
  }
  return {
    state: 'created',
    branch: ref,
    commit,
    switched: Boolean(p.switch),
    head: await git.text(target, ['rev-parse', '--verify', '--quiet', 'HEAD']),
  }
}
