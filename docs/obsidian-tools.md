# Obsidian tools for node agents

## Feature detection and configuration

The node advertises `obsidian.tools.v1` in its capability map and all methods below
in the authenticated welcome. Request schemas are exported as
`ObsidianToolsMethodSchemas` from `@abele/node-protocol`. Older clients need not
implement the feature. Use `NodeClient.request(method, params)` for this extension;
these methods have invocation-specific idempotency, not the generic mutation outbox.

Every method below has prefix `obsidian.tools.v1.`. These are owner/executor RPCs,
not model tools. Identity comes from the authenticated installation and the
node's trusted session/run closure. All paired/local owners retain today's node
authority; this adds no grants.

| Method          | Parameters and response                                                                                                   |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `configure`     | `{session_id, vault_id, agent_id, revision, tools, expected_revision?}` → saved configuration                             |
| `configuration` | `{session_id}` → `{configuration, clients}` for that vault                                                                |
| `advertise`     | `{client_id, vault_id, platform: 'desktop' \| 'mobile', revisions: {[agent_id]: revision}, label?}` → `{advertised:true}` |
| `poll`          | `{client_id}` → up to 128 invocation envelopes with an advisory `action`                                                  |
| `get`           | `{invocation_id}` → current envelope; also resolves any journaled approval decision                                       |
| `prepare`       | `{invocation_id, client_id, revision, preview, needs_approval?}` → envelope                                               |
| `claim`         | `{invocation_id, client_id, revision}` → `{execute, invocation, bypass?}`                                                 |
| `complete`      | `{invocation_id, client_id, revision, state, result}` → envelope                                                          |
| `cancel`        | `{invocation_id}` → envelope                                                                                              |

`tools` contains the ordinary registry's `{name, description, inputSchema, mode}`,
where mode is `off | ask | auto`. Export effective ordinary permissions, including
the core tool/read/write rules, rather than interpreting a missing feature-mode
entry as permission for a core read tool. There is no node-owned copy of tool
schemas. Configure before starting the provider process. Tools are exposed as
`obsidian_<ordinary name>` to avoid native filesystem tool collisions. Disabled
tools are omitted and also rejected on invocation and claim.

Revisions identify the whole effective schema/permission snapshot. Generate a
fresh revision for every change; do not reuse a revision. First configure omits
`expected_revision`; updates must name the current revision. Identical repeated
configuration is idempotent. Different contents at the same revision return
`revision_conflict`; an obsolete settings writer returns `stale_revision` and must
read `configuration` before attempting another update. Configure is per node
session; the plugin owns propagation from the shared agent settings to its chats.

`delegation.create` atomically copies the configured parent's current snapshot to
the newly allocated child **before accepting its first input**. The source is the
authorized delegation parent's `parent_id` (the grant's parent for legacy grants),
when it identifies a configured parent node session. For an ordinary plugin-only
chat with no node session, the owner/plugin includes optional `obsidian_tools` in
`delegation.create`: `{vault_id, agent_id, revision, tools}` from that chat's trusted
effective configuration. This is an owner RPC field, not a model tool argument or
a permission grant; never forward model-supplied modes. The exported
`ObsidianToolsSnapshotSchema` validates it. When both a configured parent and an
inline snapshot exist, they must match exactly or creation returns `stale_revision`
without allocating a child. The copy preserves the
vault, agent, revision, schemas and modes; only `session_id` changes. It also seeds
the child's revision history and journals `obsidian.tools.configured` before
`input.accepted`, so the first provider turn installs the inherited bridge without
a reserve/configure/start round trip. Failed creation rolls the copy back with the
child and input. Creation retries return the existing child without recopying a
newer parent snapshot. This is a snapshot, not a live link: later settings changes
still require explicit child synchronization using its current revision. A parent
without configuration or an inline snapshot produces an unconfigured child,
preserving existing behavior. Persist the inline snapshot with the original create
request: retries must preserve the exact body even if parent settings later change.

Advertisement is connection-scoped, not a durable declaration of availability.
Use a stable `client_id` for the same installation/vault executor across reconnects,
and advertise again on every authenticated connection. Concurrent connections
cannot claim the same installation/client identity. Schemas are installed through
`configure`; advertisement acknowledges the revisions the client can execute.
`label` is display-only. The configuration response lists connected same-vault
clients for the approved execution-device line; no connected eligible client is
the waiting state, not permission to choose another vault.

Names are 1–64 ASCII letters/digits/underscores, starting with a letter. At most
256 advertised tools are accepted. Arguments, schemas, preview and result objects
have a 65,536 UTF-16-unit bound; transport record limits apply as well. Keep full
note/diff presentation within these limits or return a useful size error. This
version does not define an artifact-reference extension for oversized results.

## Invocation and execution

An envelope persists `invocation_id`, `session_id`, trusted `run_id`/`call_id`,
initiating `installation_id`, `vault_id`, `agent_id`, snapshot `revision`, ordinary
`tool_name`, `arguments`, `state`, nullable `executor`, and `created_at` before any
client can see it. Executor is `{installation_id, client_id}`. Optional fields are
`preview`, `prompt_id`, `result`, `cancel_requested`, and preparation policy flags.
The session journal publishes `obsidian.tools.configured` and
`obsidian.tools.updated`; existing cursor replay provides visible waiting,
approval, execution, cancellation and final status without starting a model turn.

```text
awaiting_client → preparing → awaiting_approval → ready → executing
                      └───────────────────────────┘         │
                                  succeeded / failed / outcome_unknown
before claim: cancelled / denied
```

1. Poll selects one same-vault client with the acknowledged revision: desktop
   first, otherwise mobile, with a stable identity tie-breaker. `prepare` and
   `waiting_approval` actions do not authorize a mutation.
2. The selected plugin reuses the ordinary registry, context resolution, read
   guards, handler argument validation and approval evaluator. Prepare the actual
   note text/diff and submit it in `preview`; set `needs_approval` for outside-folder
   access and other ordinary per-action guards, even when the tool's mode is auto.
3. The node creates an ordinary exact `Prompt` when mode is ask or the plugin
   requests an ask. `input` binds invocation, tool, arguments, preview, vault and
   revision. Render it through `AiToolApproval`, adapting the preview to the usual
   path/text/diff presentation. Answer using the existing `prompt.answer` with
   session, prompt, run, revision and action digest. Prompt `run_id` is the reserved
   `obsidian:<invocation_id>`, not the provider run ID. No owner deadline expires
   this prompt; node boot preserves it.
4. Before executing, recheck the ordinary policy, target contents and prerequisites.
   A changed preview goes through `prepare` again, invalidating the old approval.
   Changed snapshot revision fails closed with `stale_revision`; cancel that old
   invocation and synchronize settings rather than substituting a new revision.
5. Execute **only** the response to the first `claim` with `execute:true`. The node
   commits `executing` before returning it. A duplicate claim returns false.
   `bypass` comes from the node session's current `bypassPermissions` setting;
   enabled tools skip asks, including outside-folder asks. Disabled tools remain
   disabled. Leaving bypass between prepare and claim forces preparation again.
6. Persist a plugin execution receipt keyed by invocation ID before the first
   handler effect. Then run the ordinary handler once and durably store its
   structured result. Complete with `succeeded | failed | outcome_unknown` and
   `result`. Identical completion repeats are idempotent; contradictory completions
   return `operation_conflict`. Result data preserves the ordinary handler format.

If a preparer disconnects **before claim**, another eligible client may prepare
the invocation; its predecessor's exact preview approval is invalidated. After
claim the executor is immutable, even if the claim response was lost. Reconnect
polls return `reconcile`, never another execution authorization. The original
executor consults its durable receipt, resends a known result, or reports
`outcome_unknown`. Missing receipts after claim do **not** authorize execution.
A crash between a mutation and saving its result needs operation-specific evidence
or an unknown outcome. Never retry the handler simply because a socket reconnected.

Cancellation before claim is terminal and invalidates an outstanding approval.
During execution, `cancel_requested:true` and poll action `cancel` tell the bound
executor to abort cooperatively; they do not assert rollback or nonexecution.
Report already-applied changes, or unknown outcome when they cannot be proved.
The approval card's Stop must call `cancel`, and may also stop the provider through
the existing chat action. A late Allow cannot execute a cancelled invocation.
With no client the invocation remains visibly `awaiting_client` and cancellable.

## Conversation tools: questions

Discover `obsidian.tools.questions.v1` in addition to the base capability. After
ordinary preparation/approval and the invocation's first execution claim, the
plugin handles `questions` with:

```ts
const prompt = await client.request('obsidian.tools.v1.questions.open', {
  invocation_id,
  client_id,
  revision,
})
```

The node takes the questionnaire from the persisted invocation arguments, not new
executor-supplied arguments. It creates exactly one nonexpiring `Prompt` with
`kind: 'questionnaire'`, `questions`, and `input: {invocation_id, vault_id}`. The
action digest binds the exact questions and invocation. Repeat `questions.open`
returns that same prompt, including its terminal answer. It requires the bound
executor and the original revision; a new opening also checks current permissions.

Each question is `{question, options?, type?, allow_custom?}`. `type` is `input`,
`single`, or `multi`; when omitted, nonempty options mean single select and empty
options mean text input. Omitted options default to `[]`. Custom answers are
allowed unless `allow_custom:false`; input always accepts text. An answer is one
nonempty string for input/single, or an array of distinct nonempty strings for
multi. Answer the entire questionnaire in question order. There are at most 20
questions, 50 options per question and 4,096 characters per string. Questions and
answers each have a 16,384 UTF-16-unit aggregate JSON bound so both the prompt and
the ordinary result fit the node transport without truncation.

The node publishes `prompt.opened` on the session and
`obsidian.tools.questionnaire` on **catalog** when opened or settled. Every owner
device should subscribe to catalog, display its questionnaire UI, and reconcile
on reconnect using `client.pendingQuestionnaires(vault_id, after_id?)`. The matching
raw method is `obsidian.tools.v1.questions.pending`, returning a prompt array,
ordered by prompt ID, at most 128 entries and 200 KiB per page. Continue with the
last prompt ID until an empty page. This spans every session of the same vault;
showing the questionnaire does not make another device its executor.
Subscribe before scanning to cover questionnaire openings/answers during pagination.

Answer through `client.answerQuestionnaire(prompt, answers)`; pass `null` to abort.
The raw durable-outbox request is the existing `prompt.answer`:

```ts
{ session_id, prompt_id, run_id, revision, action_digest,
  choice: 'allow', answers: ['text', 'option', ['option A', 'option B']] }
// Or choice:'deny', with no answers/value, to abort the questionnaire.
```

Any authenticated owner can answer, regardless of executor. The first valid answer
or abort wins atomically; later answers return the recorded decision. Invalid
answers leave it pending. A questionnaire cannot be answered with the native
permission prompt's scalar `value`, and structured `answers` are rejected on
other prompt kinds. Native permission/select/input semantics remain unchanged.

The node commits the prompt resolution, delivered flag, catalog notification and
invocation result in the same transaction. It completes the waiting provider call
directly with ordinary `{content:[{type:'text',text:'Q: ...\nA: ...'}], answers}`;
multi answers are joined by `, ` in the text. Owner abort returns the ordinary
`User aborted the questionnaire.` text. `cancel`/session Stop invalidates the
questionnaire and settles its invocation as cancelled with that same text; a late
Allow cannot reopen it. Neither disconnect nor node restart expires a pending
questionnaire.

## Conversation tools: local delegate host

Discover `obsidian.tools.delegate-host.v1`. Local `delegate` uses a minimal durable
node conversation host, **not** native `delegation.create`. Targets come from the
ordinary agent registry, using their own model/instructions and the plugin's ordinary
`ChatSession` sub-run execution. The node starts no replacement provider process
and never borrows an active vault chat. Existing native node delegation is separate.

The plugin must include these optional fields in the parent's configured snapshot
(and in inline `obsidian_tools` when it creates a native delegated child):

- `max_delegate_depth`: the ordinary agent's effective limit, clamped to 0–3.
  Missing means zero delegation depth, never an implicit expansion.
- `conversation`: the serialized ordinary parent context needed by
  `boundRunToParent`: scope entries/full-vault flag, effective permission mode,
  offered skill ceiling, open tool sections and GitHub connection ceiling. The
  node stores this owner-supplied JSON unchanged; the plugin owns its serialization
  and scope evaluation. Revision changes must cover this context as well as tools.

The plugin adapter resolves the requested agent with the ordinary registry,
including utility agents. Unknown targets return the ordinary missing-agent error,
before starting any provider. After the outer invocation is prepared/claimed, call
`obsidian.tools.v1.delegate.begin` with:

```ts
{ invocation_id, client_id, revision,
  call_id,                  // stable ordinary tool-call ID, persisted before retry
  agent_name,               // resolved target's ordinary display name
  target: {vault_id, agent_id, revision, tools, max_delegate_depth, conversation},
  parent_branch_id?,        // nested ordinary delegate calls only
  arguments? }              // nested {agent, task, items?, batch_size?} only
```

For the top-level call the node uses persisted invocation arguments. For nested
calls the adapter supplies that actual sub-run tool call's arguments and its
persisted `parent_branch_id`; the host derives root and depth from that branch.
The branch must already be running and belong to this outer invocation. The target
name/ID must match `arguments.agent` (names use the ordinary trimmed,
case-insensitive registry comparison; IDs stay exact); its vault must match the invocation's vault.
These are trusted executor RPC fields, never new permission choices exposed to the
model. Only the selected executor can admit/start/record work.

`begin` reserves every branch synchronously in one transaction before any await:
hard depth 3, at most 20 items per call, and a shared lifetime budget of 50 branches
per root node chat, across concurrent calls and restart. Aborted/failed reservations
are not refunded, matching ordinary delegate. Effective depth is bounded by every
ancestor and each parent agent's `max_delegate_depth`. A target with limit zero
cannot delegate further. A nested ordinary sub-run also needs effective delegate
mode `auto`: `off` is `tool_disabled`, and `ask` is `delegate_approval_required`,
matching an ordinary noninteractive sub-run's inability to ask for tool permission.
Empty items means one branch with task as its input;
otherwise each fresh context gets `task + '\n\n' + item`. Batch size is normalized
exactly as ordinary delegate: default 5, floor/clamp to 1–10.

The response contains `run_id`, `root_id`, `depth`, `depth_limit`, `batch_size`,
`used_runs`, `status`, task/fan-out metadata, shared `configuration`,
`parent_context`, and branch metadata (`branch_id`, item, state, depth, last_seq).
Shared context/schema bytes are returned once, not repeated per fan-out item.
The node intersects target tool modes with the parent (missing means off), and
assigns a derived snapshot revision. The plugin must also apply ordinary
`boundRunToParent` semantics to scope, permission mode, skills, sections and GitHub
connections, further intersecting current target policy. A saved node host is a
ceiling, never permission to widen current policy. Rehydrate a private parent/run
context from this metadata; do not resolve it through the active vault chat.

The adapter uses the returned reservations in its ordinary branch loop, instead of
independently incrementing a new local root counter. Create each actual sub-run
with `kind:'run'`, returned depth/limit and the shared root identity. Replace nested
delegate admission with another `begin` against that branch. Retain the ordinary
batch barrier, agent instructions, fresh message context and stricter scope policy.
The node is the authority for the shared root budget even when execution resumes.

Before **each physical sub-run start**, call `obsidian.tools.v1.delegate.claim`:
`{invocation_id, client_id, revision, branch_id}`. Execute only its first
`execute:true` response, which includes that branch's full task. A duplicate/lost
claim returns false; it never authorizes another provider start. The host also caps
running branches at that run's admitted batch size. Persist/reconcile provider
receipts outside the call: if a claimed sub-run cannot be reattached or its outcome
proved, record `outcome_unknown` instead of running it again.

Persist ordinary conversation history using `obsidian.tools.v1.delegate.record`:

```ts
{ invocation_id, client_id, revision, branch_id,
  record_id,                // stable ID for this exact immutable append/final batch
  messages?: [/* ordinary message/history JSON records */],
  state?: 'running' | 'done' | 'error' | 'aborted' | 'outcome_unknown',
  result?: string, error?: string }
```

It appends immutable history rows and/or settles the branch atomically. Up to 32
JSON records and 65,536 UTF-16 units are accepted per append. Represent streaming
updates with message IDs/versions, or chunk large messages into explicit history
records; the plugin folds them into the ordinary transcript. Repeating a record
ID/body returns its original receipt without duplicate messages; changing that
body is `operation_conflict`. A parent cannot finish while nested children are
running. A queued branch can be aborted without a start claim. Terminal branch
outcomes and full retained histories are never overwritten.

Any owner can read these invocation-bound views:

- `delegate.get({invocation_id})`: root budget/cancellation and run summaries.
  Add `run_id` for one run's context, schemas and branch metadata.
- `delegate.branch({invocation_id,branch_id})`: one branch's task while unfinished,
  and its recorded result/error. Read the run view for item/shared context.
- `delegate.history({invocation_id,branch_id,after_seq?,limit?})`: immutable entries
  `{seq,message}`, branch metadata, `next_seq`, `has_more`; default 64, max 128,
  with a 200 KiB byte ceiling. Follow the cursor without truncating history.

All methods above retain the `obsidian.tools.v1.` prefix. Executor mutations also
carry the original revision and client ID. Responses exceeding the transport
budget fail with `result_too_large` before committing new admission/claims. Store
large transcripts through history batches rather than duplicating them in results.

When all branches, including nested work, are terminal, the node directly completes
the outer tool with the ordinary single-result or batch summary and a `delegate`
reference containing root/run/branch IDs. History is available from any owner
device via these IDs and the journal's `obsidian.tools.delegate`/
`obsidian.tools.delegate.progress` events. A schema-valid initial `delegate.begin`
rejected after authenticating the bound executor leaves the invocation terminal
`failed`, with `result.isError: true` and text `Delegate admission failed: <reason>`.
The RPC still returns its original error. Admission reservations roll back before
this failure is saved; inspect `get` rather than retrying work. This includes stale
permission revisions. Unbound executors cannot settle the call. Rejection of a
later/nested admission preserves already admitted work. Cancellation between generic
claim and first admission settles immediately as `cancelled`, even if `begin` was
never sent (or its envelope was invalid). These terminal outcomes survive restart;
replaying `begin` cannot reserve or launch work, and repeated cancellation is inert.
Cancellation prevents all new admission,
aborts queued branches and signals the executor to abort running sub-runs. Running
outcomes must still be reconciled/recorded; there is no rollback or blind replay.
An oversized summary becomes an explicit transport-limit notice with the same run
references; complete recorded results/errors remain available from branch/history
views. Never repeat a sub-run merely to retrieve its output.

For both conversation tools, the invocation has `hosted:'questions'|'delegate'`
and poll action `hosted` after its node host is installed. The plugin must not send
generic `complete` for hosted calls (`hosted_invocation` is returned). On reconnect,
handle these special tool names before generic receipt reconciliation, even if a
crash occurred between the outer claim and installing its host: `questions.open`
and stable-ID `delegate.begin` are safe to repeat, while branch claims are never
replayed as execution. The node, not an absent local handler promise, delivers the
final provider tool result.

## Provider and recovery responsibilities

Claude uses its existing protected stdio MCP socket, pi its supervised worker IPC,
and Codex experimental app-server dynamic tools (`item/tool/call`). All three call
the same run-bound coordinator. Obsidian calls have no bridge owner-wait deadline;
socket/process loss and explicit cancellation still release local waiters. Pi IPC
and Codex native call identities deduplicate reconnect deliveries. Claude assigns
a stable call key within an MCP process; a newly issued model call is a new action,
not an automatic semantic retry. A completed provider result is
`{invocation_id, state, result, cancel_requested}`; the full execution/approval
envelope stays in the node journal for the owner UI.

Both live owner sessions and bounded delegated turns install this bridge. Bounded
workers suspend their active-work budget while an Obsidian call waits, then resume
the remaining budget; concurrent calls share one suspension. This is separate from
their existing native permission/approval path.

Node detach preserves durable pending invocations; explicit run close cancels
them. Provider reattachment with the same run/call key waits on the original
invocation. Node restart preserves approvals even when the native provider cannot
reattach its outstanding call: the journal and `get` still reconcile its outcome.
There is no fabricated native tool success or automatic model continuation.

Codex registers dynamic schemas at `thread/start`. The pinned protocol has no
dynamic-tool update field on `thread/resume`; previously registered schemas belong
to that native thread. Adding tools to an older thread without those schemas needs
a new native thread/session. Do not silently discard its history.

## Verification

Related tests cover durable waiting/restart, exact prompt answers, duplicate claims
and completions, stale settings writers and revisions, desktop/mobile selection,
disconnect before/after claim, cancellation, changed previews, bypass changes,
provider-call reattachment and cleanup. Provider tests use fake interfaces and a
real stdio MCP bridge with a scaled clock; no model CLI is invoked. A fake Codex
app-server smoke test is included for the Linux gate; local process supervision
cannot run where `/bin/ps` is forbidden.
