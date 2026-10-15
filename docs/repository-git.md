# Repository git writes (v1)

The node advertises `repository_git_write_v1` when it accepts owner git writes on
repository targets: stage, unstage, discard, commit, update from the base branch, continue
or abort a rebase/merge, push (also with a lease after a rebase), fetch, create a branch, and a
read describing branch, upstream and remotes. Wire
methods are `repository.v1.git.*`; schemas, result schemas and plain-language messages
(`GIT_WRITE_ERROR_MESSAGES`) live in `@abele/node-protocol`, and `client.repository.git`
validates requests and results.

These are **owner APIs**. Do not register them as model tools.

## Authority

A write needs the permission a file save in the same worktree needs
(`repository.v1.editing.get` → `enabled: true`): a registered root or a ready managed
worktree, or an external worktree with project external access **and** the owner's editing
approval for that identity. `git.info` needs read access only. Revoking editing or
external access stops further writes; permission is checked again immediately before the git
effect and before the result is published.

## Operations, receipts and outcomes

Every write takes an operation id (`client.repository.git.commit(params, operationId?)`).
The node reserves a durable intent before the first git effect and stores the result as the
operation's receipt, so retrying with the same id returns the same result and never runs git
twice; reusing an id with other parameters is `idempotency_mismatch`. Writes to one worktree
run one at a time. An effect that a crash, timeout or restart interrupted settles as
`{ state: 'outcome_unknown' }`: refresh status and `git.info` and decide; never retry it
automatically under a new id.

Expected git failures are results, so a client can show them:

```ts
{
  state: ('failed', code, message, output)
} // message: plain English; output: ≤ 4 KiB, credentials removed
```

Precondition and permission refusals are channel errors: `stale_revision` (HEAD or the
observed paths changed), `unauthorized`, `confirmation_required`, `invalid_params`,
`stale_resource`, `resource_busy`, `repository_unavailable`. After an applied write the node
publishes `repository.invalidated` with reason `reconciliation`.

Paths are worktree-relative; absolute paths, `..`, `.git` components, empty segments and NUL
are refused. They are passed after `--` with literal pathspecs, so a name like `-n` or `*` is a
file name, never an option or a pattern.

| Method              | Parameters                                                         | Result                                                                         |
| ------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `stage` / `unstage` | `expected_head`, `paths` or `all: true`                            | `{ state: 'applied', head }`                                                   |
| `discard`           | `paths`, `expected_observation_id`, `include_staged?`, `confirmed` | `{ state: 'applied', head, discarded }`                                        |
| `commit`            | `expected_head`, `message`                                         | `{ state: 'committed', commit, parent, author }`                               |
| `update`            | `expected_head`, `base_ref?`                                       | `updated` / `conflicts`                                                        |
| `continue`          | `operation: 'rebase' \| 'merge'`                                   | `continued` / `conflicts`                                                      |
| `abort`             | `operation`                                                        | `aborted` / `not_in_progress`                                                  |
| `push`              | `expected_head`, `remote?`, `force_with_lease?`                    | `{ state: 'pushed', remote, branch, upstream, set_upstream, commit }`          |
| `fetch`             | `remote?`, `prune?`                                                | `{ state: 'fetched', remote, pruned, updated, removed, upstream }`             |
| `create_branch`     | `name`, `start_point`, `switch?`, `expected_head?`                 | `{ state: 'created', branch, commit, switched, head }`                         |
| `info`              | worktree                                                           | branch, upstream with ahead/behind, operation, remotes, default branch, author |

**Discard** is destructive. The client sets `confirmed: true` only after the user confirmed
those paths, and passes the `observation_id` of the observation the user looked at. Each path
must be a change in that observation and unchanged since (its file, status and HEAD); other
paths may change meanwhile. Tracked files are restored from the index, or from HEAD with
`include_staged`, which also removes files only the index added. Untracked files are deleted;
folders and paths through symlinks are refused. Conflicted paths fail with `conflicted`.

**Commit** records staged changes only. Author and committer come from the git configuration
of that worktree (repository, then user configuration); the node never invents an identity
or takes it from its environment, and fails with `identity_missing` instead. Hook refusals
fail with `hook_failed` and the hook's output.

**Update from base** fetches the base branch and rebases onto it, as Orca does: the base is
`base_ref` or the project's default branch (as in `repository.v1.refs`). A remote-tracking
base is fetched first, and the rebase uses its fork point when the reflog has one. An unborn
branch is fast-forwarded. Tracked uncommitted changes, a detached HEAD or a rebase/merge
already in progress are refused before anything runs. On conflicts the rebase stays in
progress and the result lists the conflicted paths (also in `git.info`); resolve, stage, then
`continue`, or `abort`. A rebase that stops for any other reason is aborted before the node
answers, so the worktree is either updated, stopped at reported conflicts, or as it was.

**Push** sends the current branch to the branch of the same name. The remote is the
upstream's, else `remote`, else the only remote, else `origin`; a missing upstream is set.
Failures distinguish `no_remote`, `remote_required`, `upstream_mismatch`, `auth_failed`,
`push_rejected` (update first), `remote_unreachable` and `hook_failed`.

A branch rebased after it was pushed is sent with `force_with_lease`: the remote branch commit
the client last saw (`info().upstream.commit`, shown to the user). The node passes exactly that
commit as the lease, `--force-with-lease=<branch>:<commit>`, never a bare force and never
"whatever the remote-tracking ref says now", so a fetch the user did not look at cannot widen
it. If the remote branch is anywhere else the push fails with `lease_rejected` and nothing on
the remote changes: fetch, look, decide again.

**Fetch** fetches one configured remote: `remote`, else `origin`, else the only remote. It
never prunes unless the request says `prune: true`, even when the repository sets
`fetch.prune`. The result lists the remote-tracking branches that moved or appeared
(`updated`) and, when pruning, those removed, plus the current branch's `upstream` with fresh
ahead/behind, the same shape as `info`. Failures: `no_remote`, `remote_required`,
`auth_failed`, `remote_unreachable`, `fetch_failed`.

**Create branch** makes `refs/heads/<name>` at `start_point` (a full commit id that must exist,
else `commit_not_found`). The name is checked with `git check-ref-format` as
`refs/heads/<name>`; `HEAD`, `@` and anything it refuses fail with `invalid_branch_name`, a
leading `-` is refused by the schema. An existing name (or one inside an existing branch's
path) is `branch_exists`; the ref is created only if it still does not exist. With
`switch: true` and `expected_head` the worktree then switches to it, which needs no tracked
changes (untracked files are fine unless the switch would overwrite one) and no operation in
progress; worktrees the node manages keep their branch (`managed_branch`). If git refuses the
switch, the new branch is removed again and the result is `switch_failed` with git's words.

**Info** reports remote URLs without user names or passwords for http(s), and recognises a
hosted repository (`forge: { kind: 'github' | 'gitlab' | 'other', host, owner, name }`) so a
client can list pull requests itself. Ahead/behind compare with the local remote-tracking
ref; info does not fetch.

Deleting worktrees uses the existing methods: `nodePath.deleteWorktree` (external targets,
with the observed HEAD and observation as the confirmed precondition) and `removeWorkspace`
(managed workspaces).

## How git runs for writes

Reads keep the hardened profile described in [security](security.md). Writes are explicit owner
actions and run git as the owner would in a terminal: the repository and user configuration
apply, including hooks, clean/smudge filters and credential helpers. They still use a fixed
argument list without a shell, no editor, pager or terminal prompt, a session without a
controlling terminal, bounded output and deadlines, the daemon's own `GIT_*` variables and
`$EMAIL` removed, and only the file, git, http(s) and ssh transports.

Tests: `tests/repository-git-write.test.ts` uses disposable repositories, bare remotes and
linked worktrees.
