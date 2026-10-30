# Node discovery and chat lifecycle

`node.describe` exposes release-discovery fields at the top level of its result.
The channel `welcome` (local and paired) exposes the same fields **inside its
existing `capabilities` map**:

- `node_version`: the node's own release from its installed release manifest. This
  is independent of the channel `version` and every `provider_version`.
- `supported_capabilities`: an explicit array of supported node capability names.
  Absence of a name is not evidence of support. Older nodes may omit these fields;
  clients may ignore them and continue using existing methods.

The capability report retains evidence and unsupported/unverified statuses. Its
supported entries are also listed in `supported_capabilities`. In particular:

- `expected_target`: atomic expected-target admission on `session.send`,
  `delegation.send`, and `review.submit` (implemented in 0.4.2).
- `session.rename`: journaled display-title changes.
- `session.delete`: journaled idle-chat deletion.
- `obsidian.tools.v1`: ordinary Obsidian tool schemas, durable exact approvals,
  same-vault executor selection and invocation reconciliation. See the
  [Obsidian tools contract](obsidian-tools.md) for request shapes and plugin duties.

Do not infer feature support from the release version. Discover the capability
name before enabling a feature. Readers accept discovery fields as optional for
compatibility with older nodes. The node always supplies them at the locations
above.

The 0.4.2 welcome and pairing-claim schemas reject unknown top-level keys. The
node therefore adds no unnegotiated keys to either envelope and keeps the claim
payload unchanged. New pairing discovers release/features after owner approval,
through `welcome.capabilities` or `node.describe`. The 0.4.2 response envelope
accepts arbitrary results, so describe additions are safe for existing clients.
Updated welcome and claim readers retain future optional response fields while
still validating known identity fields; authority-bearing requests stay strict.

## Process termination

If a live provider exits during a turn, `turn.completed` keeps the compatible
`outcome: interrupted` and `subtype: process_exited`. Its existing `terminal_reason`
field now carries the actual cause: `stopped_by_owner` for an owner Stop, a provider
or node error for an unexpected exit, or `process_lost` / `node_restart` for recovery.
Clients should show "Stopped by you" only for explicit owner intent; an interrupted
outcome by itself does not identify who stopped the turn. For older records with a
null reason, consult the matching run's `session.process` exit reason or show a
neutral interrupted status.

`session.process.reason` still reports `process_cleanup_unconfirmed` when cleanup
cannot be proved, preserving quarantine semantics. The original cause survives in
the terminal turn event and the accompanying `session.error` message. No new event
fields or outcome values are required by this change.

## Rename

`session.rename` takes `{ session_id, title }` and requires an `operation_id`.
The title has the same limit as session creation (256 characters, including an
empty title). The result is the updated session. This changes only the display
name, not its ID, provider-native ID/file, workspace, execution target or history.
A running chat can be renamed. A `session.updated` event is appended to both the
chat stream and the catalog.

The client helper is `renameSession(session_id, title, operation_id?)`.

## Delete

`session.delete` takes `{ session_id }` and requires an `operation_id`. Its result
is `{ session_id, deleted: true }`. It refuses with `resource_busy` while inputs
are accepted, queued or running, while a delegation is active, or while provider
cleanup/execution-target leases are outstanding. It does not interrupt a turn.

Deletion removes the chat from `session.list`; `session.get` and fresh chat
mutations subsequently return `not_found`. It releases idle workspace/target
bindings but does not delete workspace files, Git worktrees or provider-native
files. The database retains a tombstone and historical rows, including the chat
stream, artifacts, delegation mailbox and operation receipts. Stream replay
remains available. This is catalog deletion, not secure erasure.

A `session.deleted` event with the deletion result is appended to both the chat
stream and the catalog. State, events and receipt commit in one transaction.
Retries with the same operation ID and parameters return the original result,
even after restart; reusing an operation ID with a different method/body returns
`idempotency_mismatch`. This also applies to rename receipts after deletion.
A fresh delete operation against a deleted/nonexistent chat returns `not_found`.

The client helper is `deleteSession(session_id, operation_id?)`.

Schema migration 16 adds the tombstones without changing existing sessions,
streams or receipts. Downgrading to older node releases is not supported.
