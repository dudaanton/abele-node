# Delegating work to node sessions

Delegation is a controller API for a plugin agent to assign a bounded task to a
normal node session. The node owns the workspace, queue, transcript, human
prompts and a separate durable mailbox. Disconnecting the parent does not stop
the child. This is not a scheduler, a task board or a filesystem sandbox.

## Owner approval and the trusted controller

An owner must explicitly approve a `DelegationGrant` through an owner UI before
exposing delegation tools to a model. Current enrolled installations have owner
authority; enrollment alone does **not** create a delegation grant.

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

Credentials stay in the connection/secret adapter. The trusted controller selects
the approved grant and adds `grant_id` to requests; the model receives task and
child references, not credentials or owner APIs. Grants restrict the delegation
API, not the installation's other owner APIs. Do not expose generic requests,
ordinary session control, grant approval or credential storage as model tools.
Provider authentication stays in the installed provider's local runtime.

Execution permissions and extension questions requiring human answers still use
normal node prompts. A worker mailbox question is informational: it neither
approves a tool nor answers a prompt. `pending_human_prompts` in status lets the
controller direct a human to the child session.

## Client API for a plugin integration

```ts
// Owner UI only; persist the grant selection in installation-local controller storage.
const grant = await client.approveDelegationGrant({
  parent_id: parentChatId,
  project_ids: [projectId],
  providers: ['claude', 'pi'],
})

// Model-facing create tool: the trusted controller supplies grant_id and a stable key.
const child = await client.createDelegation({
  grant_id: grant.grant_id,
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
`failed`, `cancelled` or `unknown`. `session_head_seq` supplies an observed child
revision for send without subscribing to every child tool event. Send returns
an input receipt (`input_id`, `accepted_seq`). Followups are serialized, not
steering. A terminal delegation cannot be sent more controller inputs; a human
can continue the retained child as an ordinary session without reopening its
mailbox lifecycle.

## Mailbox and reporting

`mailbox_stream_id` identifies a separate journal with its own sequence starting
at 1. Use the existing `stream.subscribe/read/ack` methods and `ClientStore`
transactional cursor/event persistence. `subscribeDelegation` is a convenience
wrapper. Do not use the child's session cursor as a mailbox cursor.

Mailbox events are `delegation.created`, `delegation.progress`,
`delegation.question`, `delegation.result` and `delegation.terminal`. They contain
bounded structured summaries, not every provider/tool event. A successful
completion commits exactly one result followed by a terminal status. Proposed
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

The built-in Claude and pi adapters are supported without registering an extra
native MCP/SDK tool: the node adds a credential-free instruction and accepts
standalone final assistant messages in this format:

````text
```abele-worker-report
{"report_id":"summary-1","kind":"result","text":"Implemented and tested the parser change."}
```
````

Partial text, user/tool messages and nested Claude child text do not become
mailbox reports. Ordinary final assistant text provides a bounded fallback
summary when no explicit result was reported. If no summary is available, the
result links the human to the child transcript rather than inventing content.
Native tool registration is an embedding seam, not a claim about live provider
compatibility; no live runs are part of this increment.

## Storage and verification

Database schema 11 adds grants, durable delegation links, unique creation keys
and run/report deduplication. Mailboxes reuse the existing event/stream journal;
no new transcript or credential store exists. Preserve node state and
provider-native resume state with the normal backup process. Complete child
history remains available via normal session streams and authorized artifacts.
The plugin should store parent/task keys, grant selection and mailbox cursors in
its installation-local transactional store, not vault Markdown or transferable
settings. No vault storage changes are needed on the node side.

Run `npm run acceptance:delegation` for fake-provider acceptance and boundary
tests. They cover offline completion, client/daemon restart, one durable result,
creation retries, mailbox isolation, human transcript access, human approval,
report fencing, grant revocation and provisioning ordering/failure. Real CLI/SDK
model behavior and plugin UI/tool-registry integration require separate testing.
