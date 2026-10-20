# Node path API

`node_path_v2` advertises the folder/read catalogue additions. Inspect the separate
`node_path_file_operations` and `node_path_execution` capabilities before enabling
file lifecycle tools or root/plain/external execution. Browsing is not execution
approval, and a listed external worktree is not a managed workspace.

## Folder and picker

`client.nodePath.directories({path?, cursor?, limit?})` returns a bounded directory
page and a short-lived, installation-bound `directory_id`. An omitted path starts
at the node user's home. Symlink entries are not followed. `mkdir({directory_id,
name}, operationId)` creates exactly one child. Keep the operation ID until a
receipt is known; an uncertain effect is never replayed under a fresh ID. Folder
creation does not register or trust the folder. `register({path, trust,
exact_root:true}, operationId)` preserves the selected folder and does not grant
access to an enclosing repository.

`gitInit({project_id, initial_branch}, operationId)` explicitly initializes an
unbound plain root. It preserves project/workspace IDs, creates no commit, and
disables templates, hooks and global Git customization. An inherited/incompatible
repository is refused. Durable intents survive restart as unknown outcomes, rather
than repeating a filesystem effect automatically.

## Worktree presentation

`repository.worktrees({project_id, include_selection:true})` adds `listed` to each
entry, root first. Root and managed entries default listed; external entries do
not. `nodePath.worktreeSelection({project_id, worktree_id, listed}, operationId)`
is an installation-local durable presentation choice, not a read/edit/execution
grant. The root cannot be hidden independently. Existing external-read opt-in is
still mandatory. Callers omitting `include_selection` retain the original shape.

## Execution targets

`nodePath.trust({project_id, trust}, operationId)` changes explicit project trust.
`execution({project_id, target, enabled}, operationId)` approves an inspected target
identity independently of browsing, attachment and editing. Targets are either
`{kind:'workspace', workspace_id}` (plain roots) or `{kind:'worktree', worktree_id}`
(Git root, managed or external). No mutation accepts a provider cwd from a client.

`createSession({title?, provider?, target}, operationId)` binds a chat separately
from the legacy Session response. Use `sessionWorktreeGet({session_id})` for its
project/target. Multiple chats may reference one target. Only an executing turn
holds its canonical-identity lease; legacy managed lifetime leases also block
conflicting execution. Active/unconfirmed cleanup blocks deletion, unregistration
and trust/grant changes. Leases survive restart until provider reconciliation
proves cleanup. Read/edit grants do not imply permission to execute a provider.

`sessionWorktreeSet({session_id, expected_target, target}, operationId)` switches
an idle chat within its registered project. Queued/running work is refused.
The trusted existing run IPC exposes `node_worktrees` and `node_worktree_switch`
for target-bound node sessions. Model arguments contain only the destination,
not credentials, session/run IDs or a cwd. A requested agent switch is `pending`
until the current worker cleanup is confirmed. Only the actual binding commit
emits `session.worktree.changed` on chat and catalog, once. The next turn uses
the new target's backend-resolved cwd.

**Current continuation limit:** a session already bound to a provider-native
conversation cannot yet move to another target. The node returns
`provider_target_continuation_unsupported`; it does not reset native history,
reuse an old cwd, or claim a successful move. In particular, Codex's path binding
and the native Pi session cwd must not be silently reused. Inspect
`node_path_native_switching` (currently unsupported) and the session's native
binding before enabling that action. Fresh/unbound sessions and deterministic
fake providers exercise the switching state machine; they are not evidence of
native conversation continuity. Initial root/plain/external execution and
subsequent turns at the same approved target are implemented.

### Guarded turn admission

To pin a draft to the target the user saw, read
`nodePath.sessionWorktreeGet({session_id, include_incarnation:true})` and retain
`{target, incarnation}` with the draft. `incarnation` is opaque and stable across
reads and node restarts; a binding switch (including away and back to the same
ID) replaces it. Legacy workspace bindings expose their inspected target identity.
Omitting `include_incarnation` preserves the original response shape.

`session.send`, `delegation.send` and `review.submit` accept an optional
`expected_target: {target, incarnation}`. The node compares it to the session's
binding **inside the transaction that records the input and operation receipt**.
A mismatch records only a typed refusal receipt:
`{code:'target_changed', current_target:{target, incarnation}}`. An unbound session
has `current_target:null`. No input, review event or provider turn is created.
Clients omitting the precondition keep the original admission behaviour.
`delegation.create` creates a new target rather than admitting into an existing
displayed binding, so it has no expected-target precondition.

The client surface is
`send(session_id, text, observed_seq, script?, expected_target?, operationId?)`;
inspect `sendResult(operation_id)` for the validated acceptance/refusal union.
`sendDelegation` accepts the precondition and retained operation ID after
`observed_seq`; review batches carry the field directly. The client exports
`ExpectedExecutionTarget`, `TargetChangedRefusal`, `TurnAdmissionResult` and their
schemas. Persist the precondition and operation ID **with** the draft, including
offline drafts. Reload/reconnect/retry replays that exact request; changing or
removing the precondition under the same ID is an `idempotency_mismatch`, not a
new send. A refusal is durable too: a later target switch does not turn its retry
into an admission. An intentional resend after checking the new target needs a
new operation ID and explicit confirmation, never automatic retargeting.

Guarded queued inputs are checked again before dispatch. If a previously scheduled
agent switch settles after admission, an input pinned to the previous incarnation
is cancelled/failed without dispatch, rather than executed in the new target.
Admission receipts remain immutable; inspect the session input events for this
post-admission outcome.

## Lifecycle and file operations

`nodePath.createWorkspace({project_id, branch?, base_ref?}, operationId)` uses a
named new branch from the base, or an existing branch's own tip. A checked-out
branch is refused. Omitting `branch` preserves generated branch names. Managed
worktrees default to `<repository-parent>/<repository-name>.worktrees/<branch>`;
the branch is percent-encoded as one directory name (for example `feature%2Ffiles`).
The existing `worktreeRoot` setting overrides the parent, with a project-ID namespace.
Previously provisioned UUID paths remain valid and are never moved automatically.
Local `main` or `master` is used as the comparison base when exactly one exists
and there is no remote default or explicit project override.
Managed removal still uses `workspace.remove` and durable jobs. External owner deletion
uses `nodePath.deleteWorktree({worktree_id, expected_head,
expected_observation_id}, operationId)` after a separate exact-target confirmation.
Root, locked, missing, leased, dirty, untracked and ignored targets are refused.
An owner-stopped session whose work has settled releases its persistent workspace
binding on deletion, while preserving the chat. Active execution and other bound
sessions return `resource_busy` with `holder`, `session_id`, and `title` details;
Git locks identify `holder: 'git_lock'`. Language servers and repository watchers
are released as part of worktree removal.
There is no force, prune, recursive deletion or branch deletion. A lost effect
reply is never blindly replayed. Removal runs behind a gated process group whose
identity is durably recorded before Git can start. Startup and retained-ID retry
inspect process settlement, the Git catalogue and the pinned target: gone means
`deleted` with `reconciliation:'applied_as_observed'`; an existing original target
means `not_applied`. These are observations, not invented command-success evidence.
An unconfirmed process or inconsistent target stays `outcome_unknown` and fenced.

The owner can check again with `abele-node recover-worktree-deletion
[OPERATION_ID] [INSTALLATION_ID] [--json]`. This uses protected owner IPC or the
offline ownership lock, only inspects/reconciles, and never replays removal or
forces a fence open. Reasons distinguish a live/unconfirmed Git process from an
unconfirmed target. Local client caches of an unknown receipt are not a fresh
inspection; use the recovery result and reload mutable catalogue state. SDK hosts
must await `core.resources.ready` before admission and stop resources before closing
SQLite, just as the daemon does.

`fileMove`, `fileCopy`, `fileRemove`, and `fileMkdir` on `client.nodePath` accept
plain-root workspace IDs or opaque Git worktree IDs and relative paths. Git root
and managed workspace IDs are rejected by the workspace-form lifecycle methods;
use the repository form, with its submodule and editing validation. Move/copy/remove require the
source's exact SHA-256 content ID. Operations are single regular-file, same-target,
bounded operations with exclusive destinations. Moves publish an exclusive hard
link before removing the original name under one serialized durable coordinator;
they never overwrite a destination or use client-side copy/delete. Mount-crossing
moves are refused. Remove/move retain a private recovery copy. Crashes can leave
an intermediate pair of names; receipts then say `outcome_unknown`, not success.
Mkdir creates one relative child, never missing parents. External operations still
require the existing editing approval. Symlinks, Git metadata and submodules are
not traversed. These checks do not claim filesystem CAS against arbitrary external
editors; a fully interleaved same-user pathname attack remains an existing limitation
of platforms without descriptor-relative filesystem primitives.

Create a file with `workspace.write` or `repository.v1.write`, passing
`expected_content_id: null`; the existing text bound and editing rules apply.
For directories, first call `nodePath.fileDirectory({workspace_id|worktree_id, path})`
and pass its `content_id` to `fileMove` or `fileRemove` with `directory: true`.
The manifest covers the entire subtree, including empty directories, and is limited
to 256 entries, depth 32 and 8 MiB of file bytes. Changed contents return `conflict`.
Symlinks, special files, nested repositories and submodules are refused. Directory
moves rename on the same filesystem after checking the destination is absent;
they share the platform pathname-race limitation above. Deletion removes only the
confirmed entries, without recursive `rm`, and retains a private `directory-v1`
JSON recovery manifest with base64 file contents. Partial effects and interrupted
operations retain an `outcome_unknown` receipt and must not be blindly retried.

`nodePath.search({workspace_id, query, mode?, case_sensitive?, path_glob?,
cursor?, limit?})` searches plain roots with the same killable bounded matcher as
repository search. Continuations bind owner, target and query; omissions are explicit.
Search never traverses symlinks or Git metadata.
For Git trees, `repository.v1.search` with `mode: 'filename'` and a fresh working
observation searches the whole gitignore-aware tree without expanding directories.
Filename searches do not read file content or omit files because of content size.

## Status, divergence and refresh

`observe` followed by `status({worktree_id, revision,
include_change_details:true})` returns raw index/worktree columns and rename origin
plus `kind`, `stage`, `change_id`, `changed_at`, `time_basis:'observed'`. Partly
staged files occupy both UI groups, but count once. Unmerged files are conflicts,
not clean staged entries. Change stamps survive refresh/restart; observation time
is not the actual edit time. These are observations, not a filesystem audit log.
Callers omitting the flag retain the original status shape.

`nodePath.divergence({worktree_id, base_ref?})` resolves frozen tips and counts both
sides of `base...HEAD`. The omitted base uses the owner default/unique remote HEAD,
never a guessed branch or a page of history. Missing defaults and unborn tips
return explicit reasons and null counts. Unborn comparisons accept `{kind:'empty'}`
as their base only; this is not a general revision or an invented first commit.

Git updates use the existing repository watcher leases and catalog stream.
Plain roots use `nodePath.watch({workspace_id})` and `workspace.invalidated` events.
Both are 60-second leases with bounded watchers/reconciliation. Renew before
expiry; invalidations mean reload, not patch application. Refresh uses new reads
and a fresh observation. Reconnect/gaps/redaction require reload/resubscription.
Retained revisions and drafts must not be discarded by a mutable-state refresh.
