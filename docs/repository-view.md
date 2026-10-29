# Repository view (v1)

For a user-facing overview of browsing, external access, editing approval and
limits, see [Repository view in the README](../README.md#repository-view).
This page specifies the node/client API; it does not promise a particular plugin
UI version or register repository endpoints as agent tools.

The node advertises `repository_read_v1`, `repository_notifications_v1`,
`repository_changes_v1` and `repository_editing_v1` in `node.describe` and the channel welcome. Requests use `repository.v1.*`; protocol
schemas live in `@abele/node-protocol`, and `NodeClient.repository` validates both
requests and results. No repository endpoint takes shell text or arbitrary Git
arguments. No Git mutations or provider execution are authorized by this feature.
Current working files can use the existing durable editor through the versioned
repository adapter; external targets additionally need identity-bound owner approval.

## Owner opt-in and identities

`NodeClient.setRepositorySettings({ project_id, external_read, default_branch? })`
is a durable, operation-ID-backed owner mutation (`project.repository_settings`).
External discovery/access defaults to **off** per registered project. Omitting
`default_branch` preserves the setting; `null` clears it. There is no fetch and
no assumption that the default is `main` or `master`: an owner setting wins;
otherwise exactly one distinct local `refs/remotes/*/HEAD` target is required.
If neither exists, clients must ask the owner to select a branch.
`NodeClient.getRepositorySettings(project_id)` (`project.repository_settings.get`)
reads both back, so a client can show whether browsing is on; a node without this read
answers `unsupported_method`, and `project.get` keeps its shape either way.

`repository.v1.worktrees` runs hardened `git worktree list --porcelain -z` from
the validated registered root/common directory. Root and managed workspace
records are deduplicated by path, independently of workspace-list pagination.
External targets have their **own** opaque persisted `worktree_id`; they are
not inserted into `workspaces`, leased to sessions, provisioned, adopted,
repaired, or pruned. A `workspace_id` is returned only for an existing root or
managed workspace. Every target returns:

- `kind`: root, managed, or external; a basename-only `path_label`;
- branch ref, detached flag, HEAD (null for unborn/bare);
- available, missing, unavailable, or bare availability;
- locked/prunable flags and observed dirty state (`null` means not observed).

Call `repository.v1.worktrees` with `include_identity: true` to receive an
`identity: { canonical_path, fingerprint }` on available entries. The fingerprint
is an opaque pin of the target directory and its `.git` inode identity. Save both
fields with the project and target IDs. An automatic rebind requires exactly one
available entry in the same node/project with both fields unchanged; basename,
branch, HEAD, or path alone is insufficient. Legacy selections without a saved
identity require explicit reselection. Older nodes reject `include_identity` as
`invalid_params`; clients may retry without it, but cannot safely auto-rebind.
The default response omits identity to preserve compatibility with strict clients.

Target IDs persist in the node state database across restarts. Version 0.4.27
keeps 0.4.26's ID allocation and fingerprint derivation. It canonicalizes Git's
symlinked worktree registration paths before discovery, which can retire an old
logical-path entry; plain canonical repository paths are unaffected. A fresh
state home or changed filesystem identity must not revive an old ID.

Root/common-directory and target inode identities are pinned. Registration
removal suspends target IDs; explicitly re-adding the same root/common-directory
identity restores unchanged targets and their session bindings. Browsing settings
and editing approvals remain revoked. Legacy removed plain repositories can be
recognized from their saved root target fingerprint; when identity cannot be
proved, re-registration creates a fresh project and leaves old sessions/grants
attached to the retired project. Unregistering needs no filesystem access and
never deletes files, even if the folder or Git metadata is gone.
Replacing a directory or Git metadata creates a new
identity, never retargets the old ID. Reads revalidate registration, canonical
root, worktree-list membership, common directory, and current opt-in. Opt-out
stops external watchers and invalidates external observations, comparisons,
cursors, and retained bytes. Old results cannot be resumed by opting in again.
In-flight external reads capture a project access generation. Opt-out invalidates
that generation before new bytes can be retained or results published, even if
opt-in is enabled again while the original Git read is still pending. A fresh read
is required; old bytes are not repopulated behind an expired identity. Catalogue
continuations and watcher setup use the same access generation, so interrupted
reads cannot retain a fresh cursor or allocate late watcher handles after reapproval.
Legacy registrations are pinned at their first repository-v1 access. Bare entries
are catalogue metadata only. Plain folders retain the existing workspace-file
API but return `git_required` from repository-v1 discovery.

Confirmed installations have **node-wide owner authority**. Project opt-in
exposes browsing to all those owners; it is not a project ACL against a stolen
owner credential. A future plugin/chat read grant must be separate from both
node delegation and human-opened tabs. Delivered bytes may remain in chat or
client history and cannot be recalled. External editing needs explicit per-worktree owner approval through
`repository.v1.editing`; read opt-in alone never permits saves. The approval binds
the opaque identity, not a path label, and does not grant managed workspace
lifecycle or provider admission. Opt-out erases these editing approvals too.

## APIs

All methods below are also available on `client.repository` with the same name
without the `repository.v1.` prefix and an object argument.

| Method          | Inputs / result                                                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worktrees`     | Project; paged worktree catalogue                                                                                                                 |
| `refs`          | Worktree; branches/tags/local remote refs, resolved commit when applicable, symbolic target, default branch                                       |
| `resolve`       | Worktree and a validated ref or object ID; frozen `{ kind: 'commit', commit }`                                                                    |
| `observe`       | Worktree, optional `include_ignored`; captured working revision and `atomic: false`                                                               |
| `status`        | Working revision; paged porcelain status with independent index/worktree columns, including renames and untracked files                           |
| `tree`          | Revision and relative directory (empty string for root); lazy directory pages, symlink/gitlink metadata only                                      |
| `blob`          | Revision/path; retained content identity, size/binary flags; explicit `larger: true` for larger display                                           |
| `content`       | Worktree/content identity, byte offset/length; bounded base64 chunks                                                                              |
| `history`       | Revision, optional file path; paged author/email/date/subject/message/parents anchored to the selected commit                                     |
| `commit`        | Revision; selected commit metadata (working revisions use captured HEAD, or return `unborn_head` when absent)                                     |
| `compare`       | Frozen commit base and commit/working head; paged changes and a comparison identity                                                               |
| `patch`         | Comparison identity and changed path; lazily retained per-file patch                                                                              |
| `blame`         | Revision/path, starting line and count; content identity and paged attribution                                                                    |
| `search`        | Explicit revision, query, literal/regex/filename mode, case sensitivity, path glob, repository/changed scope; retained match identities and pages |
| `watch`         | Worktree, optional `changes` cursor; renewable 60-second lease (see [change stream](#change-stream))                                              |
| `unwatch`       | Worktree/subscription identity; releases the lease                                                                                                |
| `editing.get`   | Worktree; effective `{ worktree_id, enabled }` editing status (registered roots/ready managed targets do not need external approval)              |
| `editing`       | External worktree and `enabled`; durable owner approval/revocation, returns `{ worktree_id, enabled }`                                            |
| `write`         | Worktree, relative path, nullable expected content ID and proposed text; existing durable save semantics                                          |
| `restore`       | Worktree, relative path, nullable expected content ID and recovery reference; existing durable explicit restore semantics                         |
| `recovery.read` | Worktree/recovery reference, offset/length; bounded original-byte chunks                                                                          |

Example:

```ts
const catalog = await client.repository.worktrees({ project_id })
const worktree_id = catalog.entries[0].worktree_id
const base = await client.repository.resolve({ worktree_id, ref: 'HEAD' })
const { revision } = await client.repository.observe({ worktree_id })
const changes = await client.repository.compare({ worktree_id, base, head: revision })
const patch = await client.repository.patch({
  worktree_id,
  comparison_id: changes.comparison_id,
  path: changes.entries[0].path,
})
const bytes = await client.repository.content({ worktree_id, content_id: patch.content_id! })
```

Follow `cursor` with the **same normalized query, target, and revision**, optionally
changing the page limit. Continuations are installation-scoped. Catalogue/ref
changes, working-observation changes, expiry, eviction, or wrong authority/query
produce an explicit stale error, not a silently restarted query. History follows
the frozen selected object even after HEAD moves. File history is path-based;
rename-following is not offered in v1. Resolve supports the existing conservative
ASCII ref grammar; refs with other names can be selected by their advertised
commit ID instead.

## Working tree and comparisons

Working revisions carry `observation_id`, captured nullable HEAD and observation
time. They are not Git objects and are not atomically captured whole trees.
Status, visible tracked/untracked paths, file identity/size/timestamps and
HEAD/index metadata are captured before/after observation. A shared working index
holds path lookups and pre-sorted directory children. Mutable reads check a cheap
HEAD/index/ref signature and recursive filesystem generation, plus metadata for
only the requested file or returned tree page. Descriptor checks still fence file
replacement during reads. Filesystem hints are asynchronous: these observations
remain non-atomic, not a synchronous guarantee against unrelated same-turn edits.
An item-level mismatch also invalidates the shared cache before a new observation.
Fresh observations reconcile known file/directory metadata before reusing an
unchanged index; item reads never do this whole-index reconciliation. Cache misses,
filesystem errors and unsupported recursive watching take the conservative
capture/full-validation route.

Ignore dependencies include the effective `core.excludesFile` (Git-resolved relative
and tilde paths), the default XDG ignore file when applicable, `info/exclude`, and
configuration origins/includes, including worktree and conditional configuration.
External or symlinked sources are fenced by metadata signatures even without a
filesystem hint. Each requested item/page also checks ancestor `.gitignore`
dependencies, including absent files that could be created. Fresh captures confirm
status/path enumeration while those rule stamps are pinned, so a rule edit during
capture cannot admit old visible paths under new rules. System/global Git config
remains disabled; this does not disable Git's default XDG ignore file. Changed observations return `stale_revision`; refresh intentionally to
get another revision. Ignored files are excluded unless an observation explicitly
requests `include_ignored: true`. Submodule contents and symlinks are never read.

Ignored observations accept an optional `path` prefix. Use the exact file path for
a read, or the directory path for browsing and search, so unrelated trees are not
enumerated. Without a prefix, dependency, build and cache directories (including
`node_modules`, `dist`, `build`, `target`, `.cache` and `.next`) are listed but not
descended into. To search one, request a new observation with that directory as
`path`; a search glob alone does not enable traversal. Explicit blob reads and
directory listings resolve the requested path directly with the usual path and
symlink checks.

An ignored observation returns `truncated: true` when its bounded walk reaches a
limit, with the collected entries still available. Narrow `path` to obtain fuller
coverage. Tree and search pages based on a truncated observation set `incomplete`
and explain the omission. Default observations keep their existing behavior and
omit `truncated`. Scoped ignored observations contain no repository-wide status;
use a default observation for status and change details.

For explicitly requested ignored source, obtain an observation with
`repository.v1.observe({ worktree_id, include_ignored: true })`, then pass its
`revision` to `repository.v1.tree` (with the directory `path`) or
`repository.v1.blob` (with the file `path`). This includes ignored empty
directories. Alternatively, for a person opening an explicit file path (including
a debugger source location), pass `include_ignored: true` to
`repository.v1.blob` with the current working revision. This reads the ignored
file without widening the observation's tree listing. Without either opt-in,
an ordinary observation still hides ignored paths, even when addressed directly.
The blob flag has no effect on commit revisions. Missing working paths return
`not_found`; existing excluded paths still return `unsafe_path`.
Clients implementing `node_ls`/`node_read` must opt in when accessing ignored
source. Ignore rules control visibility, not authority: folder grants, read/edit
levels, `.git` exclusions, traversal checks and symlink fences still apply.

Searches without `path_glob` skip directories named `node_modules`, `dist`,
`build`, `out`, `coverage`, `.next`, `.nuxt`, `.output`, and `target` at any depth
before consuming the scan budget, including with an ignored-file observation.
Other ignored source, such as generated code, remains searchable. Supply an
explicit `path_glob` to search dependency or build directories intentionally.
Unborn observations can be browsed, read, searched, and blamed without inventing
HEAD or history; endpoint comparisons still require a selected real commit base.

`compare` defaults to **endpoint** base-to-head, not merge base. `merge-base`
is explicitly labelled and returns the actual frozen base used. `staged` and
`unstaged` modes require a working head; a path changed in both index and working
tree retains both status columns. Endpoint/unstaged comparisons include bounded
untracked additions. Gitlinks are metadata-only; dirty submodule contents are
not inspected by Git diffs. Per-file patches already captured stay fixed even
when the working tree changes. Uncaptured working patches then require retry;
there is no claim that lazily captured patches form an atomic repository image.
Blame uses retained captured contents, marks new/modified lines uncommitted,
and gives untracked files no historical attribution. Working blame continuations
recheck the source path and ancestor ignore dependencies before serving cached
lines and again before publication; frozen commit blame remains independent of
working-file changes.

Content identities are SHA-256 of exact retained bytes and are scoped to the
worktree identity. Content survives daemon restart/external edits subject to
retention and authorization. Expired/evicted contents return `content_expired`,
never reread a mutable file under an old identity. Observations, comparison
manifests and cursors are bounded in-memory leases and explicitly expire on
restart; persist content/diff identities, not just ephemeral observation IDs,
for exact-byte citations. Monitor baselines borrow the accounted snapshot stamp
maps, rather than copying every path/stamp. Eviction detaches those references or
reattaches a surviving visibility variant; failed/rejected captures and shutdown
release them too. Filesystem hints never refill a detached per-file baseline.

## Durable editing adapter

Use `client.repository.editingStatus({ worktree_id })` to check effective editing
permission. For an external identity, an owner explicitly calls
`client.repository.editing({ worktree_id, enabled: true })` once before saving.
The approval is durable across reconnect/restart; replacing/removing a target or
project, or disabling project external access, does not transfer/preserve that
approval for a replacement. It is a node-wide owner setting, not a chat grant.

`client.repository.write({ worktree_id, path, expected_content_id, text }, operationId?)`
and `restore({ worktree_id, path, expected_content_id, recovery_path }, operationId?)`
persist the exact request/operation in the existing device-local outbox, including
offline. They return `{ operation_id }`, **not** proof of saving. Poll
`client.repository.mutationResult(operation_id)` for a pending (`undefined`) or
terminal receipt:

```ts
{
  operation_id, worktree_id, path,
  state: 'saved' | 'conflict' | 'outcome_unknown',
  expected_content_id, content_id, predecessor_content_id, recovery_path
}
```

The nullable precondition means exclusive new-file creation, not overwrite-anything.
Existing files require the SHA-256 identity of exact current bytes. A retained
historical blob does not authorize changing a historical version: these methods
accept **no revision/ref** and always operate on the current working file, subject
to that precondition. Drafts remain client-owned. Never retry an uncertain save
with a new operation ID. `readRecovery({ worktree_id, recovery_path, offset?, length? })`
pages the predecessor; restore requires a fresh current-content precondition and
its own operation ID.

The adapter shares the editor's serialized coordinator, pinned in-place writes,
durable intents, private recovery copies (32 / 16 MiB per target), conflict checks,
restart reconciliation and Unicode/text limits. External targets stay outside the
workspace/provider tables. Git membership/common-directory binding, target identity,
project opt-in and approval are rechecked at queue execution; permission/identity
are checked again immediately before effects and publication. Symlink, `.git` and
submodule traversal are rejected. See [editing](editing.md) for uncertainty and
portable same-user filesystem race limits.

These are **owner APIs**, never directly registered model tools. Agent editing must
retain a separate chat edit permission and owner approval of the exact target,
path, expected content identity and proposed text. Changed proposals need new
approval; read grants and human-opened tabs do not confer it. That trusted chat/UI
gate belongs to the plugin integration; no model-supplied approval flag or provider
admission was added here. Human Save is an explicit owner action.

## Bounds and incomplete coverage

| Resource                                  | v1 bound                                                                                                                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary result pages                     | 32 KiB serialized, with envelope headroom                                                                                                                                                                                                                                                                                                                                                                   |
| Trees, refs, catalogue, changes/status    | 256 entries/page, also byte-bounded                                                                                                                                                                                                                                                                                                                                                                         |
| Catalogue enumeration                     | 512 KiB Git output, at most 1,024 worktree records; at most 64 dirty checks per catalogue read, remaining dirty states unknown                                                                                                                                                                                                                                                                              |
| Tree/status/path enumeration              | 64 MiB Git stdout plus stderr; tracked/untracked paths consumed as NUL-delimited records; at most 250,000 working paths; limit errors are explicit                                                                                                                                                                                                                                                          |
| Ref enumeration                           | 512 KiB Git output                                                                                                                                                                                                                                                                                                                                                                                          |
| Working index cache                       | At most 8 monitored worktrees, 32 MiB estimated serialized snapshot footprint including indexes retained by leases; each shared index charged once, ten-minute idle expiry; eviction explicitly stales associated old observations/cursors                                                                                                                                                                  |
| Blob display                              | 1 MiB automatic, explicit larger load through 16 MiB                                                                                                                                                                                                                                                                                                                                                        |
| Content transport                         | 128 KiB bytes/chunk in a channel record below 256 KiB                                                                                                                                                                                                                                                                                                                                                       |
| Per-file patches                          | 8 MiB capture ceiling; untracked additions at most 1 MiB, binary additions explicitly unsupported                                                                                                                                                                                                                                                                                                           |
| History                                   | 100 commits/page (default 50), 30 KiB maximum individual serialized metadata; a single multi-command read deadline                                                                                                                                                                                                                                                                                          |
| Blame                                     | 400 lines default, at most 1,500/request, 1 MiB input, 5-second execution budget; byte-bounded continuations for the selected window                                                                                                                                                                                                                                                                        |
| Search                                    | 100 matches/page, at most 1,000 retained matches per scan segment, 750 ms cooperative scan budget / 32 MiB scanned bytes per segment, skip content over 1 MiB and binary content; 1-second hard worker/Git segment budget, 5-second aggregate request budget                                                                                                                                                |
| Search regex worker                       | Terminable worker, 32 MiB V8 old-generation heap / 2 MiB stack; terminated on deadline and shutdown                                                                                                                                                                                                                                                                                                         |
| Concurrent repository jobs                | 4 total, including watcher reconciliation; excess requests get `resource_busy`                                                                                                                                                                                                                                                                                                                              |
| Other Git-backed reads                    | 15-second aggregate multi-command execution budget, bounded subprocess stdout plus stderr                                                                                                                                                                                                                                                                                                                   |
| Observations/cursors/comparison manifests | Each collection below 128 entries and 8 MiB lease-owned serialized state (shared working arrays charged to the separate index budget), ten-minute leases; oversized admissions fail explicitly before returning an ID                                                                                                                                                                                       |
| Retained content                          | 64 MiB global byte-bounded LRU store, at most 16 MiB/item, independent of legacy workspace contents                                                                                                                                                                                                                                                                                                         |
| Immutable Git object cache                | 16 MiB / 512 entries byte-bounded memory LRU, at most 1 MiB per item; trees, blob sizes and displayed blobs only                                                                                                                                                                                                                                                                                            |
| Watchers                                  | 16 notification leases, at most three handles per lease, 100 ms coalescing, two-second metadata reconciliation, 60-second expiry; working indexes also use up to three recursive watch roots per monitored worktree (OS implementations may use multiple native handles); change streams: one per watched worktree, at most 32, idle ones dropped after ten minutes, batches of at most 1024 rows / 192 KiB |

Search runs on the node, never downloads repository archives. Regular expressions
are ECMAScript, line-oriented and case-configurable; invalid syntax returns
`unsupported_search_syntax`. Path globs support `*`, `**`, and `?`. Filename mode
does not download contents. Changed scope uses observed status or the selected
commit's first-parent changes (all files for a root commit). Oversized lines in
search results are truncated to 4,096 characters with an omission notice;
retained bytes still identify the exact original file.

`incomplete` and `omissions` distinguish skipped binary/large files, truncated
match text, scan/match ceilings and execution deadlines. Cursors first page retained
hits, then resume uncovered files under a fresh segment budget, including empty
pages with remaining coverage. Keep following the cursor with the same query,
target and revision; a changed working observation explicitly stales the scan.
Truncated matches within one file and skipped binary/oversized files still require
refinement; a cursor is not a promise of unlimited per-file matches. Enumeration
beyond hard input/scan bounds returns an explicit limit error rather than an
apparently complete prefix. No schema fields were added for continuation scans;
existing v1 clients can use the existing cursor/incomplete/omissions contract.
See [repository read measurements](repository-performance.md) for disposable
large-repository benchmarks.

## Refresh, safety and verification

Subscribe to `catalog`, call `watch`, and handle `repository.invalidated` by
refreshing mutable views. Renew before lease expiry (repeated watch replaces the
same owner's previous target lease); reconnect always requires refresh and a new
lease. Recursive working-index watchers cover nested edits; periodic cheap
reconciliation covers index/HEAD/refs and worktree records without rebuilding the
whole working tree. Overflow forces invalidation;
missing/moved targets invalidate before their lease stops. Every invalidation is a
**refresh-all-mutable-state** hint for that target and its project catalogue (including
editing permission), not a patch or an atomic snapshot:

```ts
{ project_id, worktree_id, reason: 'filesystem' | 'reconciliation' | 'reconnect' | 'overflow', generation }
```

Overflow/change hints arriving during an in-flight check or a full job budget remain
pending. Rapid hints coalesce; item metadata checks additionally detect requested
path changes before filesystem delivery. Watch errors/overflow invalidate cached
state rather than trusting it; refresh/re-observe after a filesystem event gap. On reconnect or any event-stream gap, refresh all mutable state and
renew leases; do not rely on replayed old hints. Revocation immediately releases the
owner's watcher handles; opt-out releases external leases. Queued external hints
are fenced at transport publication. On reconnect replay, an unauthorized obsolete
hint is replaced by a `stream.redacted` event at the same stream sequence, with
node actor, a fresh publication timestamp and only `{ refresh_required: true }`
in its data. No original event type, actor, timestamp, target ID or payload is
included. The existing client commits/acknowledges this contiguous marker normally,
so later events still arrive and reconnect does not replay the same gap forever.
Consumers should treat `stream.redacted` as a refresh-all/resubscribe-watch hint for
authorized mutable views, never as permission to recover the redacted content. Reconciliation/jobs
are drained and workers terminated on shutdown. Frozen commits and retained
bytes never automatically follow invalidations. Client presentation must preserve
drafts/selections and decide when to refresh; the plugin integration is separate.

### Change stream

A client of a node advertising `repository_changes_v1` can keep its own copy of a
working tree and patch it instead of rereading. It asks for this by passing
`changes` to `watch`: `null` the first time, then the cursor it holds when it
renews the lease. Old clients omit the field and keep the invalidation contract
above unchanged; the node never sends them batches.

```ts
// request
{ worktree_id, changes: null | { stream_id, revision } }
// result
{ subscription_id, expires_at, refresh_required: boolean, changes: { stream_id, revision } }
```

Each worktree has one numbered stream per node run, shared by every change
watcher of it. `refresh_required: false` means the cursor sent continues the
stream: nothing was missed. Otherwise the client rereads the tree and status once
and then applies batches whose `revision` is greater than the returned one (a
batch may arrive before the `watch` result; keep it until then). A change watcher
gets no `repository.invalidated` for filesystem edits or its own lease; it still
gets them for editing-permission changes and its own saves, and should reread only
for reasons other than `filesystem`.

Batches arrive on `catalog` as `repository.changed`:

```ts
{
  project_id, worktree_id, stream_id, revision,   // revision counts up by one
  complete: true,
  entries: (
    | { change: 'added' | 'modified', entry: RepositoryTreeEntry }
    | { change: 'renamed', from: path, entry: RepositoryTreeEntry }
    | { change: 'deleted', path, kind }
  )[],
  git: null | {
    head, branch, detached,                       // branch is the full ref, as in `worktrees`
    status: { path, entry: StatusEntry | null }[] // null: the path is clean again
  },
}
// or, when the node cannot describe what happened:
{ project_id, worktree_id, stream_id, revision, complete: false,
  reason: 'overflow' | 'limit' | 'unavailable' }
```

Entries are applied in order. A rename keeps the inode under a new name; a
renamed folder carries everything under it, and `from` names where the client
holds the row at that point of the batch. A deleted folder stands for its
contents. An added folder lists none of its contents: read them when the folder
is opened, through a fresh observation. Applying an entry the client already has
(an add it saw in its reread) is a no-op, so rereading and then applying a batch
that overlaps it is safe. `git` is present only when HEAD, the branch or a status
row changed; a staged edit shows up both as a `modified` entry (its index object
changed) and as a status row.

Batches are not a replay of filesystem hints. The node diffs the working state
against the state the previous batch described, so a delayed or merged hint
delays a change but never loses it; rapid edits coalesce into one batch within
about 100 ms. The client rereads once when it sees `complete: false`, a revision
that is not exactly one more than the last it applied, a different `stream_id`
(the node restarted, or the stream was idle for ten minutes and dropped), or a
`stream.redacted` marker. A renewal from a cursor behind the stream still returns
`refresh_required: false` when every batch after that cursor was already sent to
the same client; it keeps its own cursor and applies them as they arrive. A batch
made while that client held no lease (another client kept the stream moving)
makes the renewal ask for a reread. `overflow` follows a watcher error; `limit` replaces a
batch over 1024 rows or 192 KiB (a branch switch touching many files);
`unavailable` follows a moved or unreadable worktree. After an incomplete batch
later revisions continue from the state captured when it was sent. Batches carry
path names, so they are fenced at publication like invalidations: opting out of
external reading stops their delivery and redacts queued ones.

A plain folder (a project without a repository) has the same stream behind
`workspace_changes_v1`: `workspace.watch` takes `changes` the same way and answers
with the same lease, and batches arrive on `catalog` as `workspace.files_changed`
with `workspace_id` instead of `project_id`/`worktree_id` and no `git` part. Rows
are described from a walk of the folder (skipping `.git`), renames by inode;
`oid` is always null. A folder over the 10,000-entry watch limit gets an
incomplete batch and its lease ends, as its invalidation did.

Immutable cache keys include the validated common-directory repository identity,
registration fingerprint, authority generation and Git object/query identity. Linked
worktrees can share those immutable bytes, but each hit still requires current
resource authorization and publication checks. Removal, opt-out, revocation and
shutdown clear the cache; a read pending across invalidation cannot repopulate the
old generation. Working files, refs, status, HEAD and index are never cached there.
Observation/content identities and retained comparisons remain bounded, explicit
versions; expiry never silently follows a mutable pathname.

Reads use hardened typed Git, disabled executable customizations, literal
pathspecs and no optional index writes. Hooks, fsmonitor, filters (including those
configured through conditional includes), textconv, external diffs and signature
verifiers are disabled; built-in commands cannot be replaced by repository aliases.
Git transports are denied independently of repository `protocol.*.allow` settings.
`GIT_NO_LAZY_FETCH` is also set: older supported Git versions that ignore that pin
still cannot contact a promisor remote or execute its transport helper when a
local object is missing. Reads fail rather than retrieve missing objects. Explicit
`--ignore-submodules=all` on status/diff reads prevents repository or `.gitmodules`
ignore settings from triggering nested submodule inspection. Absolute/traversal/`.git`
paths and symlink traversal are refused, including historical trees. Internal
shared metadata access is permitted only for validated Git binding, not file
browsing. Portable pathname/inode checks detect observed replacements; they
**do not** promise atomic containment against a same-user parent-folder swap.
That documented boundary is accepted; no native `openat` adapter was added.

`tests/repository-view.test.ts`, `tests/repository-boundaries.test.ts`, and
`tests/repository-client.test.ts` use disposable repositories/linked worktrees
and the real node-client/daemon boundary without real providers. They exercise
opt-in, discovery lifecycle, replacement/removal, unborn/bare records, divergent
refs/default selection, status, frozen history/patches/content, bounds, blame,
regex termination, path attacks, executable customization, revocation/publication,
retention expiry/eviction, watcher overflow/missing targets and reconnect.
`tests/repository-stage5.test.ts`, `tests/repository-cache.test.ts` and
`tests/repository-edit-client.test.ts` additionally cover coalescing, in-flight
overflow, index/HEAD/ref/catalogue changes, subscription-setup revocation, obsolete
notification fencing, immutable cache reuse/isolation/bounds, external owner approval,
conflict, unknown outcomes, restart recovery and offline durable save replay.
`tests/repository-security.test.ts` and `tests/repository-security-pending.test.ts`
add adversarial fixtures for absolute/traversal/metadata paths across read/write
methods, literal leading-dash filenames and ref/revision option injection,
inward/outward/metadata symlinks at working and historical revisions, real nested
repositories, linked metadata isolation, malicious conditional configuration,
index-write suppression, legacy-Git promisor transports, binary/large inputs,
oversized trees, search byte/time/match ceilings, cache/publication isolation,
pending-read/catalogue/watch-setup opt-out/reapproval, mid-write authority/approval revocation and terminal
unknown client receipts. Executable traps have sensitivity controls, and deadline
coverage remains separate from deterministic byte/time-budget fixtures. All tests
use invented disposable repositories, not personal projects or providers.

Plugin rendering, navigation/pins, markdown safety, chat-scoped per-edit approvals, remote
image/credential isolation and desktop/phone UI acceptance are later plugin-side
verification, not evidence supplied by these node fixtures.
