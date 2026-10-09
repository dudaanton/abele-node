# Repository reads and worktree discovery (v1)

The node advertises `repository_read_v1` and `repository_notifications_v1` in
`node.describe` and the channel welcome. Requests use `repository.v1.*`; protocol
schemas live in `@abele/node-protocol`, and `NodeClient.repository` validates both
requests and results. No repository endpoint takes shell text or arbitrary Git
arguments. No new Git mutations, provider execution, or external-file editing
are authorized by this feature.

## Owner opt-in and identities

`NodeClient.setRepositorySettings({ project_id, external_read, default_branch? })`
is a durable, operation-ID-backed owner mutation (`project.repository_settings`).
External discovery/access defaults to **off** per registered project. Omitting
`default_branch` preserves the setting; `null` clears it. There is no fetch and
no assumption that the default is `main` or `master`: an owner setting wins;
otherwise exactly one distinct local `refs/remotes/*/HEAD` target is required.
If neither exists, clients must ask the owner to select a branch.

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

Root/common-directory and target inode identities are pinned. Registration
removal retires target IDs; replacing a directory or Git metadata creates a new
identity, never retargets the old ID. Reads revalidate registration, canonical
root, worktree-list membership, common directory, and current opt-in. Opt-out
stops external watchers and invalidates external observations, comparisons,
cursors, and retained bytes. Old results cannot be resumed by opting in again.
Legacy registrations are pinned at their first repository-v1 access. Bare entries
are catalogue metadata only. Plain folders retain the existing workspace-file
API but return `git_required` from repository-v1 discovery.

Confirmed installations have **node-wide owner authority**. Project opt-in
exposes browsing to all those owners; it is not a project ACL against a stolen
owner credential. A future plugin/chat read grant must be separate from both
node delegation and human-opened tabs. Delivered bytes may remain in chat or
client history and cannot be recalled. External editing needs a later explicit
per-worktree approval and mutation adapter; read targets are intentionally
separate from managed workspace lifecycle/provider admission.

## APIs

All methods below are also available on `client.repository` with the same name
without the `repository.v1.` prefix and an object argument.

| Method      | Inputs / result                                                                                                                                   |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `worktrees` | Project; paged worktree catalogue                                                                                                                 |
| `refs`      | Worktree; branches/tags/local remote refs, resolved commit when applicable, symbolic target, default branch                                       |
| `resolve`   | Worktree and a validated ref or object ID; frozen `{ kind: 'commit', commit }`                                                                    |
| `observe`   | Worktree, optional `include_ignored`; captured working revision and `atomic: false`                                                               |
| `status`    | Working revision; paged porcelain status with independent index/worktree columns, including renames and untracked files                           |
| `tree`      | Revision and relative directory (empty string for root); lazy directory pages, symlink/gitlink metadata only                                      |
| `blob`      | Revision/path; retained content identity, size/binary flags; explicit `larger: true` for larger display                                           |
| `content`   | Worktree/content identity, byte offset/length; bounded base64 chunks                                                                              |
| `history`   | Revision, optional file path; paged author/email/date/subject/message/parents anchored to the selected commit                                     |
| `commit`    | Revision; selected commit metadata (working revisions use captured HEAD, or return `unborn_head` when absent)                                     |
| `compare`   | Frozen commit base and commit/working head; paged changes and a comparison identity                                                               |
| `patch`     | Comparison identity and changed path; lazily retained per-file patch                                                                              |
| `blame`     | Revision/path, starting line and count; content identity and paged attribution                                                                    |
| `search`    | Explicit revision, query, literal/regex/filename mode, case sensitivity, path glob, repository/changed scope; retained match identities and pages |
| `watch`     | Worktree; renewable 60-second invalidation lease, immediate refresh requirement                                                                   |
| `unwatch`   | Worktree/subscription identity; releases the lease                                                                                                |

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
HEAD/index metadata are checked before/after observation and around mutable
reads. Changed observations return `stale_revision`; refresh intentionally to
get another revision. Ignored files are excluded unless an observation explicitly
requests `include_ignored: true`. Submodule contents and symlinks are never read.
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
and gives untracked files no historical attribution.

Content identities are SHA-256 of exact retained bytes and are scoped to the
worktree identity. Content survives daemon restart/external edits subject to
retention and authorization. Expired/evicted contents return `content_expired`,
never reread a mutable file under an old identity. Observations, comparison
manifests and cursors are bounded in-memory leases and explicitly expire on
restart; persist content/diff identities, not just ephemeral observation IDs,
for exact-byte citations.

## Bounds and incomplete coverage

| Resource                                  | v1 bound                                                                                                                                                                    |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ordinary result pages                     | 32 KiB serialized, with envelope headroom                                                                                                                                   |
| Trees, refs, catalogue, changes/status    | 256 entries/page, also byte-bounded                                                                                                                                         |
| Catalogue enumeration                     | 512 KiB Git output, at most 1,024 worktree records; at most 64 dirty checks per catalogue read, remaining dirty states unknown                                              |
| Tree/ref/status/path enumeration          | 512 KiB Git output; working observations at most 10,000 paths; limit errors are explicit                                                                                    |
| Blob display                              | 1 MiB automatic, explicit larger load through 16 MiB                                                                                                                        |
| Content transport                         | 128 KiB bytes/chunk in a channel record below 256 KiB                                                                                                                       |
| Per-file patches                          | 8 MiB capture ceiling; untracked additions at most 1 MiB, binary additions explicitly unsupported                                                                           |
| History                                   | 100 commits/page (default 50), 30 KiB maximum individual serialized metadata; a single multi-command read deadline                                                          |
| Blame                                     | 400 lines default, at most 1,500/request, 1 MiB input, 5-second execution budget; byte-bounded continuations for the selected window                                        |
| Search                                    | 100 matches/page, at most 1,000 retained matches, 2,048 scanned regular files / 32 MiB scanned bytes, skip content over 1 MiB and binary content, 5-second execution budget |
| Search regex worker                       | Terminable worker, 32 MiB V8 old-generation heap / 2 MiB stack; terminated on deadline and shutdown                                                                         |
| Concurrent repository jobs                | 4 total, including watcher reconciliation; excess requests get `resource_busy`                                                                                              |
| Other Git-backed reads                    | 15-second aggregate multi-command execution budget, bounded subprocess stdout plus stderr                                                                                   |
| Observations/cursors/comparison manifests | Each below 128 entries and 8 MiB serialized state, ten-minute leases, oldest-first eviction                                                                                 |
| Retained content                          | 64 MiB global byte-bounded LRU store, at most 16 MiB/item, independent of legacy workspace contents                                                                         |
| Watchers                                  | 16 leases, at most three filesystem handles per lease, 100 ms coalescing, two-second reconciliation, 60-second expiry                                                       |

Search runs on the node, never downloads repository archives. Regular expressions
are ECMAScript, line-oriented and case-configurable; invalid syntax returns
`unsupported_search_syntax`. Path globs support `*`, `**`, and `?`. Filename mode
does not download contents. Changed scope uses observed status or the selected
commit's first-parent changes (all files for a root commit). Oversized lines in
search results are truncated to 4,096 characters with an omission notice;
retained bytes still identify the exact original file.

`incomplete` and `omissions` distinguish skipped binary/large files, truncated
match text, scan/match ceilings and execution deadlines. Cursors page retained
hits; they do not resume uncovered scan ranges. Refine the path/query to cover
omitted ranges. Enumeration beyond hard input/scan bounds returns an explicit
limit error rather than an apparently complete prefix. Fixture limits are
initial values, not representative large-monorepo benchmark results.

## Refresh, safety and verification

Subscribe to `catalog`, call `watch`, and handle `repository.invalidated` by
refreshing mutable views. Renew before lease expiry (repeated watch replaces the
same owner's previous target lease); reconnect always requires refresh and a new
lease. Watchers cover workspace/common metadata and periodic reconciliation covers
nested edits, index/HEAD/refs and worktree records. Overflow forces invalidation;
missing/moved targets invalidate before their lease stops. Reconciliation/jobs
are drained and workers terminated on shutdown. Frozen commits and retained
bytes never automatically follow invalidations. Client presentation must preserve
drafts/selections and decide when to refresh; the plugin integration is separate.

Reads use hardened typed Git, disabled executable customizations, literal
pathspecs, no optional index writes and no lazy fetch. Absolute/traversal/`.git`
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
Plugin rendering, navigation/pins, markdown safety, editing approvals, remote
image/credential isolation and desktop/phone UI acceptance are later plugin-side
verification, not evidence supplied by these node fixtures.
