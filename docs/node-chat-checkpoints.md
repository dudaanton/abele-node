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
input, the node stores an immutable native conversation copy and a file snapshot.
Steering inputs belong to the running turn; there is no independent mid-turn restore.
`chat.checkpoint` carries `checkpoint_id`, `input_id`, `before_seq`, and `exclude_input_ids`
(inputs already accepted but not yet part of the native context). Capture failure
writes `chat.checkpoint.unavailable` with a reason, and does not prevent the chat.
Older turns without checkpoints cannot be restored by this API.

Files are tracked and non-ignored untracked regular files, including binary content and
permission bits. Limits: 4,096 files, 32 MiB of encoded file data, 32 MiB native log,
and five seconds for Git enumeration. Git metadata, ignored dependencies/build output,
symlinks, and empty directories are not snapshotted. A visible symlink or exceeded
limit makes the checkpoint unavailable rather than silently incomplete. Parent directories
are created when needed during restoration; empty directories are left behind.

Methods are exported through node-protocol and `NodeClient.chat`:

- `chat.checkpoints {session_id}` → `[{checkpoint_id,input_id,before_seq,exclude_input_ids}]`.
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
