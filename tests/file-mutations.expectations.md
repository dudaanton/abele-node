# In-place editing regression expectations

The mutation tests retain the user-visible guarantees. These mechanism-dependent expectations changed when replacing displacement/publication with in-place editing:

| Test scenario                                | Previous expectation                                                       | Current expectation and reason                                                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Final-check external edit                    | Hook before displacement; restore displaced bytes                          | Hook before the final base check; conflict leaves external bytes untouched. No pathname displacement exists.                                                                         |
| External pathname replacement during writing | A recreated target survives exclusive publication                          | An external rename/replacement survives because the pinned writer still addresses its original inode. Verification returns unknown and the original recovery bytes remain available. |
| Restart boundaries                           | Crash after displacement/publication; workspace siblings exist             | Crash after truncation/write; the file path remains present and recovery is in node state. Same-ID retry never repeats the effect.                                                   |
| Same-process uncertain retry                 | Receipt predecessor is the externally edited displaced inode               | Receipt predecessor is the pre-write snapshot, while competing bytes remain in the live file. Both versions are available without moving either workspace pathname.                  |
| Late descriptor write during save            | Late bytes live in the displaced recovery inode; new target stays proposed | Late bytes live in the actual workspace file. Verification reports unknown; node-state recovery retains the pre-write bytes.                                                         |
| Descriptor held after confirmed save         | Retain displaced inode indefinitely if it changes later                    | Descriptor continues writing the live file. Node recovery is an immutable independent copy and is bounded by count and byte quota.                                                   |
| Recovery count                               | Up to 32 unchanged copies plus unlimited protected copies in the workspace | At most 32 copies and 16 MiB per workspace in node state, including unknown outcomes. Oldest copies expire under the explicit quota. No recovery files can enter Git staging.        |
| ACL/xattr files                              | Reject without dropping metadata                                           | Save successfully on the same inode and compare preserved metadata. In-place writes remove the need for a metadata-copy policy.                                                      |

New coverage also checks clean refusal of 0444 files, ordinary macOS attributes, ignored-source staging safety, byte quota, exclusive creation, explicit preconditioned restore, and refusal of legacy state for manual inspection. Existing lost-response, receipt mismatch, concurrent API serialization, path rejection and mode/owner/group checks remain.

## Forward migration and on-disk durability

- The schema-7 recovery test no longer expects automatic import/removal. Migration 9 must refuse startup with row/path details and leave both SQLite evidence and workspace bytes untouched. Stage 4B was not released; applied migration 8 remains unchanged.
- Empty legacy state advances to schema 9 and drops only the empty legacy table; ordinary in-place intents/copies remain supported.
- Count and size quota assertions now enumerate files on disk independently of SQLite rows. Startup must remove unregistered full/partial copies and keep referenced copies.
- Creation tests require the node-state and recovery-root parent directories to be fsynced once, before intent acceptance and truncation, rather than only syncing the final workspace directory.
- The parent-directory substitution race receives documentation only: concurrent same-user directory swaps remain outside the existing threat model, without adding a new mechanism.
- The plugin's save/check completion regressions now explicitly require Promise rejection with the conflict message. A fulfilled operation can no longer pass solely because a later edit is rejected by CAS; the production guarantee is unchanged.
