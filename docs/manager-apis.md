# Manager command and integration APIs

## Ordinary chat commands: `command_context_v1`

Clients discover `command_context_v1` in the capabilities map, then call
`command.context.v1.enable` with `{}` on **each channel connection**. Without
this opt-in, context methods return `capability_required`. Existing session APIs,
command run results, session catalogues and approval behavior remain unchanged.
Context events appear only in their own explicitly subscribed journal.

`session.create` is a provider session API, not a command-only context API.
An ordinary chat should use the following methods instead. No model, fake
provider, delegation grant, session binding or separate execution grant is needed.
The authenticated installation must have execution authority on the registered
project/target, and the project must be trusted. Existing repository access,
path containment, target identity, environment restrictions, execution leases,
revocation and audit storage checks still apply. These commands run as the node
OS user under the same policy as `command.v1.run`.

All mutations require a stable channel-envelope `operation_id`. Preserve it
through reconnects and retries; changing any parameter with that ID returns
`idempotency_mismatch`.

1. `command.context.v1.create` accepts `{ parent_chat_id, project_id }` or
   `{ parent_chat_id, worktree_id }`, exactly one target. It creates or reuses
   a context for that installation, parent chat and explicit target. It returns
   `{ context_id, parent_chat_id, stream_id, project_id? , worktree_id? }`.
   A project selects its root directory; a worktree selects that exact worktree.
   Creation starts no provider and executes no command. The context and receipt
   survive restarts. The parent ID is a stable client chat identity, not a node
   session ID. Contexts are not listed as provider sessions.
2. `command.context.v1.prepare` accepts `{ context_id, parent_chat_id,
permission_mode: "ask" | "bypass", argv? , command? , cwd? , env? ,
timeout_ms? , output_bytes? , justification? }`. Command fields and limits
   match `command.v1.run`; supply exactly one nonempty command or argv array.
   The optional justification is at most 512 characters, returned only as
   display metadata; it is never executable input or approval authority.
   The node resolves and validates the target and directory before committing
   an action. Missing resources name `context`, `project`, `worktree` or `cwd`
   in the error message and `error.details.resource`. Invalid parameters identify
   the offending fields. Legacy session command errors identify a missing
   `session` and direct ordinary clients to this capability.
3. In **Ask**, prepare returns a run in `pending_approval` with `approval`, the
   exact durable node prompt. Render `approval.input.command` verbatim or
   `approval.input.argv` as individual arguments, together with the resolved
   absolute `approval.input.cwd`. Show one owner confirmation for that exact
   card. Nothing executes before approval. Never add a preliminary confirmation
   or automatically answer an unrelated node/provider prompt.
4. The owner UI calls `command.context.v1.execute` with `{ context_id,
parent_chat_id, run_id, action_digest: approval.action_digest,
choice: "allow" | "deny" }`. This records that single decision and starts
   execution only for `allow`. A mismatched digest or obsolete approval returns
   `stale_approval`. Retry the same decision with its original operation ID.
   Do not expose this owner decision endpoint as a model tool. Do not use
   `prompt.answer` for context prompts.
5. In **bypass**, when the node's own bypass opt-in is enabled, prepare returns
   `approval: null` and immediately dispatches the validated command, with no
   owner prompt or execute call. This opt-in is the same
   `--claude-allow-bypass` / `service flags set --allow-bypass on` setting used
   by provider sessions; it is off by default and requires no provider session.
   When it is off, a client bypass request is tightened to Ask: prepare returns
   `permission_mode: "ask"`, `state: "pending_approval"`, the exact `approval`,
   and `reason: "node_bypass_disabled"`. Nothing executes until the owner approves
   that card through execute. The client should compare the effective
   `permission_mode` with its request and display the reason for tightening.
   These use existing response fields, preserving strict v1 response readers.
   The client must
   pass the owner's current mode; omission is invalid and the node never infers
   bypass from authentication, project trust, context reuse or a previous run.
   The node only tightens the requested mode: Ask stays Ask even with opt-in on.
   A prepared Ask action cannot be switched to bypass by execute or by enabling
   bypass later. Retries retain the original receipt and effective mode.
6. `command.context.v1.status` and `command.context.v1.cancel` accept
   `{ context_id, parent_chat_id, run_id }`. Cancel is a mutation. Both check
   the originating installation, parent and context/run binding. Cancel
   invalidates an unanswered approval or stops/reaps an active process group.
   Subscribe/read `stream_id` for `prompt.*`, `command.updated` and bounded
   `command.output` events so actions remain visible while running.

Prepare/status/cancel return the existing run fields plus `context_id`,
`permission_mode`, optional `justification`, and `approval` (prompt or null).
The internal `session_id` field equals the context journal ID; it is **not** a
provider session and must not be passed to session APIs. The execute result is
the resolved approval receipt. Preparation and decision receipts are immutable;
use status for current state/output. `CommandContextSchema` and
`CommandContextRunSchema` are exported by `@abele/node-protocol`.

Pending Ask approvals survive restarts and are revalidated before execution.
Interrupted execution is recorded as `outcome_unknown`, never replayed.
A crash after a durable intent but before launch can also produce that state;
clients must inspect the result rather than retrying with a fresh operation ID.
As with the existing runner, crash recovery cannot infer an interrupted command's
external effects; graceful shutdown stops and reaps active commands.

## Ordinary chat integration: `integration_context_v1`

Discover capability `integration_context_v1`, then call
`integration.context.v1.enable` with `{}` on **each connection**. This opt-in is
independent of `command.context.v1.enable`; neither enables the other.
Legacy `git.v1.integrate` remains unchanged and always asks for approval.

1. `integration.context.v1.create` takes `{ parent_chat_id, worktree_id }` or
   `{ parent_chat_id, project_id }`. It creates/reuses the same provider-independent
   context model as command contexts, returning `{ context_id, parent_chat_id,
stream_id, worktree_id? , project_id? }`. No provider or model starts.
   A worktree-bound context accepts only that destination worktree; a project-bound
   context accepts an explicitly named destination in that project. The source
   must be a different worktree in the same project. Existing command contexts
   can also be reused with this capability and the same parent identity.
2. `integration.context.v1.prepare` takes:

   ```ts
   {
     context_id, parent_chat_id,
     worktree_id, source_worktree_id,
     target_branch, source_branch,
     expected_target_head, expected_source_head,
     rebase?: boolean,
     permission_mode: 'ask' | 'bypass',
     justification?: string // at most 512 characters, display metadata only
   }
   ```

   Both IDs are node worktree IDs. No session ID is needed. The integration
   parameters are exactly those of `git.v1.integrate`; command, cwd and environment
   overrides are not accepted. The context must match the parent installation/chat
   and destination target, or admission fails. Justification is returned separately
   and is never Git input or approval authority.

3. In Ask, prepare returns `state: "pending_approval"`, effective
   `permission_mode: "ask"`, and one exact durable `approval`. Render the entire
   integration card from `approval.input`: both worktree IDs, branches, expected
   heads, optional rebase, resolved destination cwd and both target fingerprints.
   Nothing integrates before the owner approves this exact action digest.
4. The owner UI calls `integration.context.v1.execute` with
   `{ context_id, parent_chat_id, run_id, action_digest, choice: "allow" | "deny" }`.
   Its result is the durable resolved approval receipt. Wrong or obsolete decisions
   return `stale_approval`. Retrying a decision with its original operation ID
   never launches a second integration. Keep execute out of model tools; never
   automatically answer a legacy prompt or use `prompt.answer` for context approvals.
5. Bypass executes directly only when the node's `--claude-allow-bypass` /
   `service flags set --allow-bypass on` opt-in permits it. Prepare then returns
   `state: "running"`, `permission_mode: "bypass"`, `approval: null`. No approval
   card or execute call is needed. With node bypass disabled, prepare tightens the
   request to Ask and returns the exact approval plus `reason: "node_bypass_disabled"`.
   Show this reason to the owner. The node never changes Ask into bypass.
6. `integration.context.v1.status` and `integration.context.v1.cancel` take
   `{ context_id, parent_chat_id, run_id }`. Both require the original installation,
   parent and context/run kind. Cancel invalidates a pending approval. Once an
   integration is running, cancel returns `resource_busy`; interrupting Git midway
   would compromise its recovery guarantees. Keep the action visible until it settles.

Create, prepare, execute and cancel require stable envelope `operation_id` values.
Retry the exact original request with its original ID after reconnects/restarts;
changed parameters return `idempotency_mismatch`. Preparation receipts are
immutable; poll status for the current result. Prepare/status/cancel use the same
run fields as command contexts, with `method: "git.v1.integrate"` and an explicit
`stream_id` for the context journal. Subscribe/read it for `prompt.*`,
`command.updated` and integration results. The internal `session_id` is this
journal ID, not a provider session. Protocol exports `IntegrationContextSchema`,
`IntegrationContextRunSchema` and their types.

All existing integration checks remain: trusted registered worktrees, both target
identities, both execution leases, current authority, exact branch/head checks,
clean working trees, Git locks, fast-forward checks and rollback after a rebase
conflict. They are revalidated before mutation. Pending Ask approvals survive
restart; running/interrupted integrations become `outcome_unknown` and are never
replayed. A lost Git reply can leave the effect applied with an unknown receipt;
inspect status and repository state rather than submitting a new operation ID.

## Legacy session command and integration APIs

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

Command approvals additionally expose the unmodified `input.command` or
`input.argv` directly for ordinary approval-card renderers. `input.params` remains
the full compatible request. Render shell commands verbatim, preserving quoting,
whitespace and newlines; render argv as individual arguments without implying a
shell interpretation. Use this single durable prompt rather than a second client
confirmation. Closing an approval window must not send `choice: "deny"`; denial
is an explicit owner decision. Transport closure alone leaves pending prompts
available to another connection, subject to their expiry and run lifetime.

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
