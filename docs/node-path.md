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

## Lifecycle and file operations

`nodePath.createWorkspace({project_id, branch?, base_ref?}, operationId)` uses a
named new branch from the base, or an existing branch's own tip. A checked-out
branch is refused. Omitting `branch` preserves generated legacy names. Managed
removal still uses `workspace.remove` and durable jobs. External owner deletion
uses `nodePath.deleteWorktree({worktree_id, expected_head,
expected_observation_id}, operationId)` after a separate exact-target confirmation.
Root, locked, missing, leased, dirty, untracked and ignored targets are refused.
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

`nodePath.search({workspace_id, query, mode?, case_sensitive?, path_glob?,
cursor?, limit?})` searches plain roots with the same killable bounded matcher as
repository search. Continuations bind owner, target and query; omissions are explicit.
Search never traverses symlinks or Git metadata.

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
