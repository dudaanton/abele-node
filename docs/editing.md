# Workspace file editing (stage 4B)

The authenticated client API supports bounded UTF-8 file saves, exclusive new-file
creation and explicit restore. This is daemon functionality; the plugin's editing
UI depends on its version. Git staging, commit, merge, rename/delete and a binary
editor are not implemented by this API.

## Client contract

Use workspace-relative paths and the content identity returned by `readFile`:

```ts
const file = await client.readFile(workspaceId, 'sample.txt')
const save = await client.writeFile({
  workspace_id: workspaceId,
  path: file.path,
  expected_content_id: file.content_id,
  text: 'Updated text\n',
})
// writeFile returns a durable operation ID, not proof that the file was saved.
const result = await client.fileMutationResult(save.operation_id)
```

`writeFile` retains the exact operation/body in the device-local outbox before
sending, including offline. `fileMutationResult` is `undefined` while pending;
otherwise its state is `saved`, `conflict` or `outcome_unknown`. Terminal channel
errors remain available through `operationResult`. Reconnect retries the same
operation ID, not a newly allocated save. If local outbox admission itself fails,
retain the intended operation ID and pass it as `writeFile(params, operationId)`
when retrying; changed parameters must use a new identity.

- Existing files require an exact SHA-256 `expected_content_id`. A changed base
  returns `conflict` without overwriting it. Read again and reconcile explicitly.
- `expected_content_id: null` requires a new file, created exclusively. An existing
  file is a conflict; parent directories must already exist.
- Text is limited to **32,768 UTF-16 code units**, with valid Unicode and no NUL.
  Binary editing is refused. Predecessors over **16 MiB** cannot be recovered and
  are refused. This is not a large-file editor.
- Symlinks, traversal and `.git` path components are refused. Ordinary dotfiles
  are supported. Writable registered root workspaces can be edited too; this is
  not limited to managed worktrees. Choose the workspace deliberately.
- `workspace.changed` catalog events are bounded refresh hints, not file content
  or confirmation of what an external editor currently sees.

## In-place writes and uncertainty

Existing files are opened with a pinned writable descriptor, without truncation.
The current bytes are fsynced into private node-state recovery storage, then a
durable mutation intent commits. Immediately before truncating, the node rechecks
content, path and inode. It truncates/writes/fsyncs the **same inode** and verifies
read-back before reporting `saved`; it does not replace the inode with a temporary
file. Existing mode, ownership, ACLs and xattrs are therefore not replaced/copied.
Read-only files fail before the destructive effect. New files use ordinary creation
mode `0644`, subject to the daemon's umask.

There is **no atomic filesystem compare-and-swap or lock on external writers**.
An editor holding a descriptor still addresses the live inode; concurrent writes
can interleave, and a crash/write error can leave partial bytes. Such effects settle
as `outcome_unknown`, with a retained pre-write copy for existing files. Restart
settles durable unfinished intents as unknown, never infers success from matching
bytes and never repeats the effect automatically. Do not silently retry an
uncertain save as a new operation. The API is not an OS sandbox; see
[security](security.md#file-browsing-editing-and-review).

## Recovery and restore

Recovery bytes live under **`STATE_DIR/file-recovery/<workspace_id>/`**, not beside
source files, so backups of ignored source cannot accidentally enter `git add .`.
Directories are `0700`, files `0600`. Each workspace retains at most **32 copies /
16 MiB**; oldest copies are evicted before allocating another. Receipts do not
expire, but their recovery references can expire (`recovery_expired`). Immutable
browse snapshots have a separate, currently unbounded retention policy.

```ts
if (result?.recovery_path) {
  const chunk = await client.readRecovery(workspaceId, result.recovery_path)
  // chunk.base64 contains bounded original bytes; page using offset/length.
  const current = await client.readFile(workspaceId, result.path)
  const restore = await client.restoreFile({
    workspace_id: workspaceId,
    path: result.path,
    expected_content_id: current.content_id,
    recovery_path: result.recovery_path,
  })
  // Inspect fileMutationResult(restore.operation_id), just as for a save.
}
```

A recovery reference is authorized for its workspace and original path. Restore
uses a fresh current-content precondition, its own operation identity and its own
pre-write copy. It does not claim success for or replay the original uncertain
save. Startup removes unreferenced recovery files but preserves indexed copies.

Schema migration 9 refuses startup if legacy recovery rows or old-style unfinished
mutation intents require manual inspection. It does not import/delete that evidence.
Preserve the stopped database, recovery files and affected workspace files before
inspection; do not drop migration markers to force an upgrade.

## Offline verification

```sh
npm run acceptance:stage4b
```

This exercises the real CLI/channel with fake providers: save, lost local receipt
commit, restart/retry without overwriting a later edit, version conflict, retained
bytes, explicit restore and new-file creation. Fault tests additionally cover
truncate/write interruption, recovery quotas, permission preservation and external
descriptor interleaving. No model inference is needed.
