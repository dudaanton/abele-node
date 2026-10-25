# Node pi chat contract

## Transcript and model settings

An accepted input is permanent journal evidence. `input.accepted` keeps its `input_id`
and text and now has `mapped: true`; the adjacent `session.update/user_message` uses
that input ID as its message ID. `sessionUpdatesOf` maps older, unmapped accepted
inputs and ignores new mapped records. Do not render both representations.

Group work by `turn_id` (or `turn.started`/`turn.completed` boundaries in older
journals), never by `run_id`: one live process handles many turns under one run.
Every accepted input remains visible, including steering, denied revisions and
interrupted work. `turn.completed.input_ids` associates consumed inputs with a turn.
Message IDs include the node run consistently in live mapping and legacy replay.

The worker emits `pi.model.catalog` after resolving user settings and on model changes.
Its mapped `config_option_update` includes the active model, available models in that
provider's local authenticated SDK snapshot, and account `default` labelled
`pi · <provider>`. This is the node's inherited credential context, not a claim that
the owner has a subscription. Other providers' models are not offered because model
switching stays within the resolved provider. No credentials or endpoints are exported.
`default` still selects the node's configured initial model. Model IDs may contain `/`
and `:`; adapters retain their own validation. An unavailable model is refused by pi.

`pi.extension.error` carries `extension`, `event`, and bounded `error` strings from
the SDK's ExtensionError. Arbitrary Error objects and stacks are not exported.

## Checkpoints

Version 1 supports long-lived **pi** chats. Before dispatching an idle chat's next
input, the node stores an immutable native conversation prefix and a file snapshot.
Steering inputs belong to the running turn; there is no independent mid-turn restore.
`chat.checkpoint` carries `checkpoint_id`, `input_id`, `before_seq`, and `exclude_input_ids`
(inputs already accepted but not yet part of the native context). Capture failure
writes `chat.checkpoint.unavailable` with a reason, and does not prevent the chat.
Older turns without checkpoints cannot be restored by this API.

Files are tracked and non-ignored untracked regular files, including binary content and
permission bits. Limits: 4,096 files, 32 MiB of encoded file data,
and five seconds for Git enumeration. A 32 MiB native limit applies only to
legacy hosts using inline copies; upgraded hosts capture native logs of any length
without copying them. Git metadata, ignored dependencies/build output,
symlinks, and empty directories are not snapshotted. A visible symlink or exceeded
limit makes the checkpoint unavailable rather than silently incomplete. Parent directories
are created when needed during restoration; empty directories are left behind.

Methods are exported through node-protocol and `NodeClient.chat`:

- `chat.checkpoints {session_id,before_seq?,after_seq?,limit?}` →
  `[{checkpoint_id,input_id,before_seq,exclude_input_ids}]`.
  `limit` defaults to 100 and must be an integer from 1 through 100. Cursors are
  nonnegative safe integers, exclusive, and mutually exclusive. Without a cursor,
  return the latest page; `before_seq` returns the nearest older page;
  `after_seq` returns the earliest newer page. Every returned page is in ascending
  `before_seq` order. The old `{session_id}` request remains valid, now capped.
- `chat.preview {session_id,checkpoint_id}` → `{preview_id,changes,files}`.
  Each change carries `{path,current,checkpoint}`: SHA-256 of the current and target
  file content/mode states, including absence. `files` carries before/after base64
  content, modes and a `truncated` flag. Content is bounded across the response; a
  truncated preview must be labelled as such. Preview has no write side effects.
- `chat.restore {session_id,checkpoint_id,action,text?,restore_files?}` requires an
  operation ID and returns `{session_id,input?}`. Supported actions:
  `rewind` restores context before the checkpoint's input; `retry` then queues that
  original input; `edit` requires replacement text and queues it; `branch` creates
  another chat from that context and leaves the source transcript intact.

By default **all actions leave files untouched**. Branch rejects `restore_files`.
Only an explicit `restore_files: {preview_id,changes}` authorizes rollback; the client
must show the preview and send its exact complete ordered change set. A mismatched,
partial or stale set returns `stale_revision` before writing. The node compares again
after stopping the worker. UI controls must never infer file consent from `action`.

Restore requires an idle/stopped chat with no queued/delivered inputs and current
execution authority. Active work returns `resource_busy`; first Stop and await turn
completion. The source target and incarnation must match the checkpoint. A branch
requires the same explicit target execution grant as a new chat. Legacy exclusively
leased workspace chats must expose/authorize a repository target before branching;
the node does not silently grant new execution rights or transfer their workspace lease.

Conversation restoration creates a new native file and ID, retaining old files.
`chat.restored` records the action, source session, checkpoint, `before_seq`, and
explicitly restored file changes. To display the active conversation, use the source
journal prefix through `before_seq`, excluding input bubbles identified by
`exclude_input_ids`, followed by events after `chat.restored` in the
destination; retain excluded records in raw history. A branch's inherited prefix comes
from `source_session_id`. Nested restores follow these references. No journal records
or Git history are removed. A successful operation ID replays its stored receipt.
Before effects begin, a durable restore intent reserves the operation ID and retains
the pre-rollback file snapshot. An attempt without a completed receipt returns
`outcome_unknown` on replay, including after a node restart. Inspect the attempt and
current disk state before issuing a new operation with a fresh preview.

The typed client sends restore online, outside its offline outbox. File rollback is
not an atomic filesystem transaction: an I/O failure can leave a partially restored
set. After a disconnected or failed restore, inspect disk and request a fresh preview;
do not silently retry a file rollback. Crash recovery of interrupted multi-file restores
and native-copy garbage collection remain future work.

### Paging checkpoints

The SDK method is `client.chat.checkpoints(session_id, options?)`, where options is
`{before_seq?: number, after_seq?: number, limit?: number}`; it returns the same
array of checkpoint metadata as the wire method. Existing one-argument calls work.
To open a chat, fetch the latest page. To load older checkpoints, pass the first
item's `before_seq` as the next request's `before_seq`. To catch up after new
checkpoint events, pass the last known `before_seq` as `after_seq`, then advance
that cursor to the last returned item. Continue until an empty page, deduplicating
by `checkpoint_id`. Responses also stop before the channel record byte budget;
a short page alone does not establish the end. An individual metadata record
that cannot fit returns `output_limit`.

Checkpoint snapshots are retained permanently for preview/rewind/branch by ID;
paging removes no history. Listing reads a separate small metadata table using a
`(session_id,seq)` index and a SQL limit, without loading native logs or file data.
Existing databases receive an atomic, one-time backfill of metadata and its index
on first startup after upgrading. That backfill reads existing snapshots once and
can take time on large databases; subsequent opens do not repeat it.

### Related read audit

The public `session.list`, `prompt.list`, journal `stream.read`, and `job.list`
already use SQL page limits/cursors (journal and job responses also have byte
bounds). `session.state.background_tasks` retains at most 256 current tasks rather
than task history. Client letters and internal messages are replayed through the
paged session journal; the internal message queue is capped at 16.

`node_sessions` now pages its candidates and resolves sends by ID; see
[agent messaging](claude-sessions.md). Internal prompt existence/count queries
select pending rows through indexes. Historical prompt reads are capped at 100,
and invalidation/recovery iterates pending prompts in keyset batches of 100 so
it processes every active prompt without materializing completed history.
`delegation.status` reports the exact pending count with at most 100 prompt
summaries; use the paged `prompt.list` API to load additional summaries.

Restart derives session permission policies on access rather than rewriting every
session. Debugger state similarly receives its recovery incarnation on first
access, before it can expose a cached stop or accept a command. Manager commands,
provider runs, input queues, pending prompts, and debugger operation recovery use
indexed active-state queries. Missing delegation reservations have a durable repair
queue maintained with lease changes, instead of a scan through retained children.
First-upgrade index creation/backfills still read history once; normal restart cost
depends on outstanding work, not completed sessions/turns. Actual pending operations
must still be reconciled. Orphan recovery cleanup inspects at most 128 directory
entries at startup and per normal node tick, uses indexed point lookups, and closes
its directory cursors on shutdown. Referenced file recovery retains its existing
32-copy quota per workspace. Obsidian revision backfill also runs only once.

### Native prefix capture

Trusted state and repository roots are pinned to physical paths before use, so
macOS temporary-directory ancestor aliases such as `/var` are supported. Native
files still require a regular final component opened with `O_NOFOLLOW`; substituted
session/archive directories and later replacement of pinned roots are refused.

The upgraded pi host appends native JSONL normally and atomically replaces its file
on SDK rewrites. Checkpoints retain one hard link per source inode in the private
state directory and record its byte boundary. Later appends cannot enter an older
restore, and later rewrites cannot change its retained inode. Capturing reads only
the writer marker and final byte, fsyncs newly written data, and stores a small
reference; it never reads or serializes the conversation. Hard links require the
managed session and archive directories to remain on the same filesystem.
Capture work is independent of historical length; flushing new turn data still
depends on that turn's new bytes. File snapshots retain their fixed bounds above.

Restore/branch creates a new log from exactly the selected prefix, rewrites its
header, and streams the rest with a 128 KiB buffer. Restore intentionally costs
O(selected history), while routine capture does not. Existing inline checkpoints
remain restorable. Old running hosts without the append-only writer marker retain
bounded inline capture until restarted; oversized logs report
`pi_checkpoint_writer_upgrade_required` instead of recording an unsafe reference.
The atomic rewrite adapter is checked against pinned pi SDK 0.87.0; an unknown
writer implementation fails host startup rather than risking historical snapshots.
Native archive garbage collection and the provider SDK's own history loading on
process start remain outside this capture optimization.

## LSP failure boundary

The LSP transport already limits each request to 15 seconds. Previously a bridge
exception (including untrusted-folder or startup failures) was swallowed in live pi;
no result reached the worker, so its tool could wait indefinitely. Both pi bridges now
reply with readable failure results, and the worker cancels unanswered LSP calls after
30 seconds. Historical LSP/session results are no longer replaced by debugger-refresh
placeholders. Missing project dependencies can still make a server unavailable, but
were not established as the cause of the acceptance run's hang. Project trust remains
the existing node policy; a managed worktree inherits its registered project's trust.

No live model or owner configuration was used to verify this contract. The plugin
must adopt the shared user-message mapping, turn grouping and checkpoint controls;
cross-worker/plugin acceptance is still required.
