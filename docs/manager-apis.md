# Manager command and integration APIs

These online controller APIs use the node's existing authenticated installation
authority and resource scope. They are advertised in the channel welcome methods
list, with capabilities `command_run_v1` and `git_integrate_v1`. They do not grant
delegation controllers permission to answer human prompts. Only expose run,
status, cancel and integrate as manager tools; keep `prompt.answer` in the owner UI.
As with other owner APIs, enrolled installations currently have owner authority;
a delegation grant is not a replacement for authenticated installation authority.

Every new run or integration requires a fresh, exact, durable owner approval,
including requests from local tokens. Trust and authentication do not auto-approve
commands. Requests in unregistered/untrusted folders are refused before a prompt
is created (`not_found` / `project_untrusted`). This is command execution as the
node's OS user, not a filesystem sandbox.

## Common lifecycle

Mutations require a retained channel-envelope `operation_id` (1–128 characters).
Retry with the same method, parameters and operation ID to recover the original
receipt; changed parameters give `idempotency_mismatch`. `session_id` is an
existing session whose journal receives the prompt and output; it need not be
bound to the requested worktree. Authentication is checked against the session,
project and worktree. Existing external-worktree read permission must be enabled
to address an external worktree. The exact per-run approval authorizes execution;
it does not enable general editing or grant future execution permission.

`command.v1.run` and `git.v1.integrate` immediately return a `ManagerRun` in
`pending_approval`. No command/git mutation has run at this point. The session's
normal `prompt.opened` contains `tool_name`, a title and `input` with the exact
`method`, `params`, resolved `cwd`, cwd identity, project ID and target/source
fingerprints. `action_digest` hashes that exact input. An owner on any authorized
device answers with the normal `prompt.answer` contract: `session_id`, `prompt_id`,
`run_id`, `revision`, `action_digest`, and `choice: "allow" | "deny"`. These prompts
do not expire while the node is running. Approval starts the effect asynchronously
after the answer commits; denial settles it as `denied`.
Handling the reply marks the prompt delivered and journals `prompt.delivered`
atomically with the run transition, so repeated answers never launch another effect.

Before execution the node revalidates the approving and requesting identities,
project trust, repository registration, worktree and cwd identities. Active effects
hold execution leases, preventing worktree removal and competing execution. Git
integration also shares the existing per-worktree git mutation locks, acquired in
stable order across both worktrees. Owner/device revocation stops active commands.

Poll `command.v1.status` with `{ session_id, run_id }` for either kind of operation.
The initial receipt is immutable; current/final status comes from this method.
`ManagerRun` (also exported with `ManagerRunSchema` from `@abele/node-protocol`):

```ts
{
  run_id: string, prompt_id: string, session_id: string,
  method: 'command.v1.run' | 'git.v1.integrate',
  state: 'pending_approval' | 'running' | 'exited' | 'denied' | 'timed_out' |
         'cancelled' | 'applied' | 'failed' | 'outcome_unknown',
  stdout: string, stderr: string,
  stdout_truncated: boolean, stderr_truncated: boolean,
  reason?: string,
  exit_code?: number | null, signal?: string | null,
  head?: string, conflicting_files?: string[]
}
```

Journal events `command.updated` contain that status, including the final state.
`command.output` carries `{ run_id, stream: "stdout" | "stderr", text }` chunks
(at most 4096 UTF-16 code units). Subscribe/replay the existing session stream for
live output; journal sequence numbers provide ordering and reconnect cursors.
The status rings are bounded; the durable journal retains the streamed output.

Disconnecting a controller does not cancel its command. Graceful node shutdown
stops and reaps commands before closing storage. An abrupt restart marks unfinished
requests `outcome_unknown`, invalidates old prompts and never replays an effect.
Inspect the worktree before creating a new operation after an unknown outcome.

## `command.v1.run`

```ts
{
  session_id: string,
  // Exactly one: registered project root, or a catalogue worktree ID.
  project_id?: string, worktree_id?: string,
  // Exactly one: executable with literal arguments, or /bin/sh -c command.
  argv?: string[], command?: string,
  cwd?: string,
  env?: Record<string, string>,
  timeout_ms?: number,
  output_bytes?: number
}
```

Project IDs address both Git roots and plain folders. `cwd` defaults to the
selected root; relative paths resolve from it and absolute paths must remain
inside it after symlink resolution. Escapes/missing paths give `unsafe_path`;
identity changes while waiting for approval give `stale_resource` (or
`unsafe_path` if the new destination escapes). Stdin is closed. `argv` has 1–256
strings; the executable must be nonempty, while subsequent arguments may be empty.
Strings/command are at most 32768 characters with no NUL. The whole
canonical request is limited to 32768 UTF-8 bytes.

The environment inherits only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TMPDIR`,
`TMP`, `TEMP`, `LANG`, `LC_*` (uppercase names), `TERM`, `COLORTERM`, `CI` and
`NO_COLOR`. `env` may override only these keys, with up to 128 values, no NULs,
and at most 32768 characters per value. Disallowed keys give `invalid_params`.
Daemon API tokens, provider secrets, `NODE_OPTIONS` and `GIT_*` do not pass through.
The exact requested overrides are visible in the approval and durable journal.

`timeout_ms` is optional: omission means no deadline. When present it is an integer
from 1 to 2147483647. `output_bytes` is the per-stream tail capacity, 1024–16384
bytes, default 16384. Dropped prefixes set the corresponding truncation flag and
prepend `[truncated]\n` to status text (the marker is additional to the capacity).
UTF-8 characters are decoded incrementally. A process exit, including a nonzero
exit, settles as `exited` with `exit_code` and `signal` (`null` when inapplicable).
Launch failures settle as `failed`. Deadline expiry settles as `timed_out`.

`command.v1.cancel` takes `{ session_id, run_id }` and an `operation_id`. It
invalidates a pending prompt or kills the active command's process group, returning
`cancelled`; poll/consume the final update for reaping and exit signal. Cancelling
a terminal run returns its existing status. Pending integrations may also be
cancelled; an integration already running refuses cancellation with `resource_busy`
so a partially completed git write is never reported as cancelled.

## `git.v1.integrate`

```ts
{
  session_id: string,
  worktree_id: string,        // target branch's worktree
  source_worktree_id: string, // developer branch's own worktree
  target_branch: string, source_branch: string,
  expected_target_head: string, expected_source_head: string,
  rebase?: boolean           // default false
}
```

Both worktrees must belong to the same registered trusted project and be distinct.
Each must have the named local branch checked out, match the caller's full 40/64
hex commit ID, and be clean (including untracked files). Ref names are validated
with git; detached HEAD, active operations, changed heads/branches, dirty trees,
unavailable/replaced worktrees and revoked permissions refuse the effect. The
checks run after approval; failures settle as `failed` with `reason` such as
`stale_revision`, `workspace_dirty`, `resource_busy` or `repository_unavailable`.

With `rebase` omitted/false, the target must be an ancestor of the developer head;
otherwise the result is `failed` / `not_fast_forward`, without changing either
branch. The target advances with `merge --ff-only` to the approved developer commit.
Success is `applied` with the resulting `head`. No remote fetch/push is involved.

With `rebase: true`, a divergent developer branch is first rebased onto the
approved target head **in the developer's own worktree**, then the target is
fast-forwarded to the new developer head. Autostash, autosquash and updating
unrelated refs are disabled. On conflicts the node records `conflicting_files`,
aborts the rebase, and verifies the original developer head and clean status:
`failed` / `rebase_conflict`. Other rebase failures are `rebase_failed` or the git
error reason. Failed restoration is explicitly `rebase_cleanup_failed` and requires
owner inspection. If rebase succeeds but a later target fence fails, the developer
branch remains rebased and the target is not advanced; inspect both heads before
retrying. Git subprocesses have a 15-second limit and use the existing owner-git
environment/configuration/hooks policy. Git failures or interruption never cause
automatic replay of the operation.
If the fast-forward loses its reply or its resulting head cannot be verified,
status is `outcome_unknown`, since the ref may already have advanced.

## Parent notifications and delegated targets

A parent can subscribe to the session supplied in `command.v1.run` or
`git.v1.integrate`. `command.updated` is durable and includes every terminal status;
use `run_id` to correlate it and the journal sequence to deduplicate reconnect
replay. `command.output` is output, not completion evidence. Scheduling a parent
notice/model turn from these events belongs to the controller.

For child lifecycle/approval/report notifications subscribe to the delegation's
`mailbox_stream_id` (see [delegation](delegation.md)). A pause is a
`delegation.terminal` with `state: "stopped", reason: "time_limit"`.

Get `worktree_id` from `delegation.status` after provisioning; pass it as the child
source or command target. `workspace_id` is not a catalogue worktree ID. Commands
require exactly one of `project_id` or `worktree_id`, and exactly one of `argv` or
`command`; validation messages name those alternatives. Integrations require both
catalogue worktree IDs and the matching branches/heads. No additional approval is
implied by resolving an ID: every effect still needs exact owner approval.
