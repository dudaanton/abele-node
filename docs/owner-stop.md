# Owner Stop (session.owner-stop.v1)

The node advertises `session.owner-stop.v1` in discovery and capabilities. Enforcement
fences controller execution on every connection, including clients that have not
enabled the extended wire representation. It never prevents an owner from restarting
the chat with an ordinary message. Bypass does not override the controller fence.

An authenticated owner's `input.cancel`, `session.interrupt`, or `session.stop`
persists session execution intent in the same transaction as the request receipt.
The node increments `stop_generation`, marks `owner_stopped: true`, and exposes
`stop_reason: "stopped_by_owner"`. The fence is stored separately from session
metadata, provider processes, inputs, and delegation outcomes. It survives restart,
lost replies, late provider events, metadata updates, and cleanup failures.
Invalid/stale requests roll back without creating a stop generation. An exact
operation retry returns its existing receipt without incrementing the generation.

Stop cancels all queued inputs in that session, invalidates pending approvals, and
interrupts active execution. A live interrupt keeps its process, with its existing
cancelled/interrupted turn outcome; a hard Stop ends the process. Automatic turns
starting while fenced are interrupted, and pending compaction continuations are
discarded. Controller cancellation, deadlines, crashes, daemon shutdown,
and resource eviction do not create an owner fence. Cleanup can remain quarantined;
the fence and stopped delegation status do not depend on its success.

`delegation.send` and controller/model tool admissions refuse execution before
accepting an input or reopening a delegation. Internal automatic admissions and
final provider dispatch checks enforce the same fence. Compaction continuation
cannot queue new work while stopped. A dispatch
interrupted across an asynchronous checkpoint cannot requeue the old input. No
queued pre-Stop controller work is replayed after restart.

An ordinary owner `session.send` atomically releases the current fence and admits
the new input, from any enrolled device and any client version. An explicit owner
`session.compact` likewise counts as fresh owner input. No capability opt-in,
generation field, new permission, or new error code is required on these owner
paths. A message after hard Stop uses the existing queue and process-resume flow;
an interrupted idle process can accept the next owner turn without restarting.
Admission validation or target refusal leaves the fence intact. Receipt replay
does not clear it: retrying an already completed pre-Stop operation only returns
that operation's old receipt.

The distinction is a trusted call boundary, not installation identity or message
labels. `NodeCore.request` checks authority and validates the method/parameters,
then its durable operation transaction admits direct owner `session.send` and
`session.compact` with owner intent. Owner review submissions and chat retry/edit
services use `acceptOwnerInput` inside their checked operation transactions.
`DelegationService` and the run-scoped session-message tool use `acceptInput`,
which never releases a fence, even when their retained authority belongs to the
same enrolled installation. Automatic continuation is also fenced. Tool adapters
must not proxy model-supplied owner RPC methods or call `acceptOwnerInput`.
Client-supplied sender/source labels and `owner: true` are never used to classify
intent. All direct authenticated channel clients are trusted owners in the current
authority model; a credential-holding client can exercise owner operations.

## Plugin wire integration

On each connection, call `session.owner-stop.v1.enable` with `{}` after discovering
the capability. The reply is `{ "enabled": true }`. This enables optional
`stop_generation`, `owner_stopped`, and `stop_reason` fields on sessions and live
state, and stop metadata on delegations and terminal mailbox events. Older strict
clients receive their existing resource shapes. Unknown optional journal events
remain replayable on both representations.
Legacy delegation records omit `reason: "stopped_by_owner"`, which their strict
reason enum cannot decode; replayable `session.owner_stop` events retain that reason.

With the capability enabled, a stopped controller send returns this durable refusal receipt:

```json
{
  "code": "owner_restart_required",
  "session_id": "child-session",
  "reason": "stopped_by_owner",
  "stop_generation": 2
}
```

No input, provider dispatch, state reset, or additional mailbox recovery notice is
created. New operation IDs produce the same refusal while stopped. Legacy
connections receive a channel error with code `owner_restart_required` and the
same identity/reason/generation in `details`, instead of an unfamiliar result union.

Clients that support it may instead use the explicit owner-only
`session.owner_restart`, carrying the generation that UI displayed:

```json
{
  "session_id": "child-session",
  "stop_generation": 2,
  "text": "Continue with my new instructions",
  "observed_seq": 123
}
```

Use an operation ID and the normal durable outbox. `expected_target` is optional
and has the same meaning as on `session.send`. There is no permission checkbox or
new delegation grant. The node atomically clears the matching fence and admits
exactly one fresh owner input, returning `{ "input_id": "...", "accepted_seq": 124 }`.
Admission errors roll back the clear. A mismatched generation or an already cleared
fence returns `stale_revision`. Unfinished provider cleanup returns `resource_busy`
and retains the fence; the owner can retry after cleanup. An idle interrupted live
process can be reused. A target refusal also retains it. Legacy ordinary owner
messages continue to use their existing queue behavior, without this explicit
operation's cleanup/generation preconditions.

The node client exposes this as `restartSessionByOwner(params, operationId)`;
`compactSession` also returns the extended turn-admission union when opted in.

`session.owner_restart` is an owner request operation, like approving a delegation
grant. It requires authenticated owner authority (local token or paired device),
and is deliberately absent from every node model/controller tool adapter. Those
adapters may admit controller inputs but must never expose a generic owner RPC proxy
or forward model-supplied restart methods. The ordinary owner-send path described
above remains supported for released clients.

`session.owner_stop` journal events contain `session_id`, `stop_generation`,
`owner_stopped`, and `reason` (`stopped_by_owner` on Stop, `null` on restart).
Delegation Stop publishes `delegation.terminal` with `state: "stopped"`,
`reason: "stopped_by_owner"`, and the generation; restart publishes
`session.owner_stop` in its mailbox too. Keep the plugin's local marker until the
matching restart receipt is accepted, and reconcile it against replay/current state.
A successful old restart receipt can be replayed after a newer Stop, but cannot
clear that newer generation. Never use that receipt alone to clear a newer local
marker. Reading status, reconnecting, settings changes, stale approval answers, and
daemon restart do not release the fence.

Refresh the plugin's vendored protocol schemas with the worker maintaining provider
modes: delegation reasons are bounded strings, and admission results include the
owner refusal. Clients without this capability retain their existing resource
shapes and can restart simply by sending an ordinary owner message. Their stopped
chat appears stopped/idle as before; the extended fields are opt-in.
