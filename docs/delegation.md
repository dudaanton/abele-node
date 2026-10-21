# Delegating work to node sessions

For approval-backed commands/tests and fast-forward branch integration from a
manager session, see [Manager APIs](manager-apis.md).

Delegation is a controller API for a plugin agent to assign a bounded task to a
normal node session. The node owns the workspace, queue, transcript, human
prompts and a separate durable mailbox. Disconnecting the parent does not stop
the child. This is not a scheduler, a task board or a filesystem sandbox.

## Installation authority and the trusted controller

Discovery advertises `capabilities.delegation_without_grant.status: "supported"`.
When present, local and paired owner installations can omit `grant_id` from
`delegation.create` and supply `parent_id`, a stable opaque chat identifier.
The plugin selects projects from the chat's owner-configured node scope. The node
applies the installation's ordinary authority, trusted-folder rules, provider
availability and workspace confinement. Current installations have owner authority;
the plugin enforces chat scope. No separate grant approval is needed.

Defaults are all delegation actions (`create`, `send`, `status`, `cancel`, `read`)
and ordinary session providers (`claude`, `pi`, `codex`, plus non-executing `fake`
fixtures with `allow_fake: true`, as for ordinary fake sessions). Real providers
must be available and require a trusted project. The node automatically stores a
binding for the requested project, calling installation and parent using existing
grant storage. The returned `grant_id` identifies this internal binding; plugins
need not supply or store it. Exact installation authority is retained, including
the paired device key. Revocation or replacement fences retries, mailbox access
and execution and cancels active children. Other installations cannot drive or
read the child's mailbox. Permission prompts still require the owner.

The following explicit grant flow remains supported unchanged for older clients:

For legacy clients using explicit grants, an owner approves a `DelegationGrant`
through an owner UI before exposing delegation tools to a model.

`approveDelegationGrant` and `revokeDelegationGrant` are **owner actions, not model
tools**. A grant binds a controller installation, an opaque stable `parent_id`,
allowed projects, providers and actions (`create`, `send`, `status`, `cancel`,
`read`). Fake children also require explicit `allow_fake: true` and are
non-executing fixtures. There are no wildcard projects or permission-answer
rights. The approving and controller installations must remain authorized.
Grants retain the exact approval/controller authentication profile and, for paired
identities, the public device key. Device revocation or replacement invalidates
that authority even when the installation itself remains active; re-enrollment
does not revive old grants. Legacy grants without recorded authority remain
usable only for installations with no paired-device history; ambiguous paired
grants require a new explicit owner approval.
Revocation cancels active delegations and prevents subsequent controller access.

Credentials stay in the connection/secret adapter. In the legacy flow, the trusted
controller selects the approved grant and adds `grant_id` to requests; the model receives task and
child references, not credentials or owner APIs. Grants restrict the delegation
API, not the installation's other owner APIs. Do not expose generic requests,
ordinary session control, grant approval or credential storage as model tools.
Provider authentication stays in the installed provider's local runtime.

Execution permissions and extension questions requiring human answers still use
normal node prompts. A worker mailbox question is informational: it neither
approves a tool nor answers a prompt. `pending_human_prompts` in status lets the
controller direct a human to the child session. Status also returns
`pending_prompts: [{ prompt_id, run_id, expires_at }]`. A newly opened child
prompt posts a durable `delegation.question` with `report_id: "prompt:<id>"`
and a child-session link in its text. This does not grant the controller
permission-answer authority. Delegated prompts wait for the owner until the run
ends; their `expires_at` is `Number.MAX_SAFE_INTEGER`. Ending the run invalidates
unanswered prompts. A refused or expired pi tool approval blocks that tool call
and lets the agent continue with another approach.

## Client API for a plugin integration

```ts
// Check delegation_without_grant before omitting grant_id.
// The trusted controller supplies the parent and selects an allowed project.
const child = await client.createDelegation({
  parent_id: parentChatId,
  delegation_key: stableTaskKey,
  project_id: projectId,
  provider: 'pi', // or 'claude'
  title: 'Review the parser',
  text: 'Review and improve the parser; summarize the changes.',
  // base_ref defaults to HEAD
})
await client.subscribeDelegation(child)

const status = await client.delegationStatus(child.delegation_id)
await client.sendDelegation(
  child.delegation_id,
  'Also consider empty input.',
  status.session_head_seq
)
// await client.cancelDelegation(child.delegation_id)
```

Public record methods are `delegation.create`, `delegation.send`,
`delegation.status`, `delegation.cancel`, `delegation.grant.create` and
`delegation.grant.revoke`. Mutations use the existing durable client outbox and
operation receipts. The convenience mutation methods require a connection;
accepted requests already in the outbox survive disconnection and retry on
reconnect. A lost response is an uncertain outcome, not permission to allocate a
new task key.

Creation returns `node_id`, `session_id`, `delegation_id`, `mailbox_stream_id`,
`workspace_id`, `job_id`, the durable parent/grant link and the initial state.
`(installation_id, delegation_key)` is unique even when the retry uses a new
operation ID. Preserve the **same key and body** on retry; changed bodies return
`idempotency_mismatch`. Repeated creation returns the original creation receipt;
use status for current state. Keys should be namespaced by parent/task, stable
across plugin restart, and no longer than 128 characters.

A real child reserves its own managed branch/workspace and provisioning job in
the same transaction as its session, link, mailbox, initial queued input and
receipt. Followups accepted during provisioning stay behind the initial input.
The child exclusively reserves the workspace lease in the creation transaction,
before provisioning starts, and retains it even if delegation is cancelled.
No provider starts before provisioning succeeds. Session sends and every dispatch
boundary verify that the lease still belongs to the exact child. Startup repairs
legacy missing reservations without stealing an existing lease; conflicting
children are fenced without pausing unrelated execution. Provisioning failure becomes a durable failed delegation, not an
attempt to run in an unready workspace. Cancellation does not automatically
remove workspaces, branches or valuable files. Process termination uses the
existing asynchronous supervised cleanup; a cancellation receipt is not proof
that every process has already exited.

Status includes `session_head_seq`, `mailbox_head_seq`,
`pending_human_prompts` and a state: `provisioning`, `running`, `completed`,
`failed`, `cancelled`, `stopped` or `unknown`. A deadline produces `stopped` with
`reason: "time_limit"` in status and `delegation.terminal`; display this as
"Stopped: time limit". Work and native session context are retained.
`session_head_seq` supplies an observed child
revision for send without subscribing to every child tool event. Send returns
an input receipt (`input_id`, `accepted_seq`). Followups are serialized, not
steering. `delegation.send` can continue a completed, stopped, failed, cancelled,
or unknown child. It revalidates the grant and execution target, queues a new
input in the same session/worktree, and returns the ordinary input receipt.
The state returns to `running`; the previous time-limit reason and cached report
are cleared. Cleanup of a previous process must finish before dispatch. Deleted
sessions, revoked grants, changed targets and unavailable workspaces still
refuse execution. Retries with the same operation ID return the same receipt.
After the outstanding queue settles, the latest turn publishes a fresh terminal
event and, on success, a fresh result with a distinct report ID. Refresh status
after a successful send to display `running`. Earlier failed/unknown inputs do not determine
the new turn's outcome or get replayed. Subscribe to the existing mailbox across
all follow-ups; a terminal event ends a turn, not the controller relationship.

## Mailbox and reporting

`mailbox_stream_id` identifies a separate journal with its own sequence starting
at 1. Use the existing `stream.subscribe/read/ack` methods and `ClientStore`
transactional cursor/event persistence. `subscribeDelegation` is a convenience
wrapper. Do not use the child's session cursor as a mailbox cursor.

Mailbox events are `delegation.created`, `delegation.progress`,
`delegation.question`, `delegation.result` and `delegation.terminal`. They contain
bounded structured summaries, not every provider/tool event. A successful
completion commits its result (in ordered parts when necessary) followed by a terminal status. Proposed
worker results cannot declare success before the provider settles. Failures,
cancellation and uncertain delivery publish terminal status without pretending
to have a successful result. Each mailbox is readable only by its granted
controller installation; other owner installations can still open the normal
child transcript. Every replay event and successful resource response (including
queued `stream.read` pages) rechecks current grant and resource authority
immediately before transport publication. Revocation fences records still waiting
to be sent; bytes already handed to a transport cannot be retracted.

`WorkerReporter` is a run-bound reporting adapter. Provider embeddings may use
its `abele_worker_report` tool or the optional provider event sink `report`
callback. Authority/session/run identity comes from the closure, never tool
arguments. Reports have `{ report_id, kind, text }`, with `kind` equal to
`progress`, `question` or `result`; duplicate report IDs with identical bodies
are harmless, changed bodies fail. A stale run cannot write a report.

Pi children receive a native `node_worker_report` tool over authenticated node-tool IPC.
It takes the same report object and binds the session/run in the node, never model input.
It needs no filesystem execution approval. Other children and pi also support
the credential-free instruction that accepts
standalone final assistant messages in this format:

````text
```abele-worker-report
{"report_id":"summary-1","kind":"result","text":"Implemented and tested the parser change."}
```
````

Partial text, user/tool messages and nested Claude child text do not become
mailbox reports. Ordinary final assistant text is retained in full when no explicit result was reported.
Long results are split into consecutive `delegation.result` events of at most 32768
UTF-16 code units, each with a distinct report ID; concatenate their text in journal
sequence order until `delegation.terminal`. Read every replay page. The delta fallback
also includes the whole run, rather than its last 32 deltas. If no summary is available, the
result links the human to the child transcript rather than inventing content.
Headless pi display-only APIs (widgets, headers, footers and editor decorations)
produce `pi.extension.warning` and do not fail extension hooks. Interactive custom
components and non-UI extension failures still fail explicitly. No live provider
runs were used for verification.

## Storage and verification

Database schema 11 adds grants, durable delegation links, unique creation keys
and run/report deduplication. Mailboxes reuse the existing event/stream journal;
no new transcript or credential store exists. Preserve node state and
provider-native resume state with the normal backup process. Complete child
history remains available via normal session streams and authorized artifacts.
The plugin should store parent/task keys, optional legacy grant selection and mailbox cursors in
its installation-local transactional store, not vault Markdown or transferable
settings. No vault storage changes are needed on the node side.

Run `npm run acceptance:delegation` for fake-provider acceptance and boundary
tests. They cover offline completion, client/daemon restart, one durable result,
creation retries, mailbox isolation, human transcript access, human approval,
report fencing, grant revocation and provisioning ordering/failure. Real CLI/SDK
model behavior and plugin UI/tool-registry integration require separate testing.

The node advertises Codex in both discovery provider lists. The plugin must allow
`codex` in its delegatable-provider filter as well as its chat picker. After a
successful final pi answer, `agent_end` and `session_shutdown` hook failures emit
`pi.extension.warning` with `extension`, `event`, and bounded `error` fields;
they do not fail the run or suppress its mailbox result. Extension-command
failures without a successful answer remain failures.

An inactive delegated child's retained workspace reservation does not block a
different node chat from acquiring the execution lease. Active child work and
all execution leases remain exclusive. The child is explicitly told that its
dedicated worktree already exists. Workspace and repository worktree lists
reconcile managed entries against a successful Git worktree observation;
externally removed entries become `removed` without deleting any files.

The controller-read regression issues two `workspace.diff` calls and one
`workspace.files` call concurrently. All three succeed on this tip. There is no
per-principal request rate limiter in this checkout to adjust; existing bounded
Git execution, output, page and transport budgets remain in force. Investigating
acceptance M9 further requires the failing raw RPC error code and the plugin or
proxy trace. Worktree-location instructions are advisory; shell approval display
and enforcement of writes outside the worktree remain separate concerns.

## Manager acceptance lifecycle

Bounded pi, Claude and Codex turns default to 30 minutes of active time. Pi defaults
to 32768 output tokens (subject to the selected model maximum). Approval waits
stop the run clock, including overlapping waits. A delegated child prompt has no
expiry, including turns typed directly by the owner after a pause. Claude approval
IPC also waits durably instead of closing at its old permission TTL. Cancellation,
revocation, lost provider connections and node restarts retain their existing
fail-closed behavior. A genuine active-time deadline settles as `stopped` with
`reason: "time_limit"` and publishes `delegation.terminal`; a pending owner decision
is not discarded just because wall-clock time passed.

Subscribe to each mailbox using `subscribeDelegation` / `stream.subscribe`:
`delegation.question` announces owner approval and worker questions;
`delegation.progress` announces progress; `delegation.result` carries reports;
`delegation.terminal` announces completion, failure, cancellation, unknown outcomes
or a time-limit pause. Persist the mailbox sequence and replay after reconnect.
These are durable facts a parent can use to schedule a notice or model turn; the
node does not itself start the parent model or spend its budget.

`delegation.status` returns `worktree_id` once the managed workspace is ready,
otherwise null. Use this catalogue ID for command/integrate calls; `workspace_id`
is a different identity. Status retains the child session and mailbox IDs.

`delegation.delete({ delegation_id })` is an idempotent mutation for deleting an
idle child chat when its parent chat is deleted, including a parent stored only in
the plugin. It uses the controller grant's cancel authority and normal session
checks. Cancel active children first and retry deletion after effects are reaped;
`resource_busy` protects active execution. It tombstones the child and releases idle
bindings, retaining delegation audit/mailbox history and worktree files. The client
exposes `deleteDelegation`. Parent UI code must call it for the parent's delegations.

Token connections pin `target.expected_node_id` to the authenticated welcome, so
parent approval cards and child chats use the same verified node identity.

Service upgrades retain every argument from the authenticated previous service,
including owner limits and flags unknown to the installer, replacing only the
runtime executable/path. Explicit installer provider, debugger and pairing choices
override just those arguments. Unsupported service command formats fail instead
of silently dropping flags. Existing configured limits remain unchanged on update;
the larger defaults apply when the service did not set explicit limits.
