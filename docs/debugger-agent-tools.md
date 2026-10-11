# Debugger agent tools and current-state delivery (B5)

B5 is **opt-in infrastructure**, not the completed debugger release. `--debugger`
(or the trusted core option) must be enabled. Real profiles remain audit-blocked;
there is no target startup, renderer attachment, arbitrary DAP, source export or
plugin debugger UI here. See [shared authorization](debugger-control.md),
[state contracts](debugger-v1.md) and [the native profile gate](debugger-js-profile.md).

## Tool surface and trust

Claude receives an `abele_debugger` stdio MCP server through its existing private,
per-run socket/configuration mechanism. Pi registers thin SDK tools over its
supervised worker IPC. Both call the same node coordinator, during the active
turn, not through queued follow-up chat input. The provider-contract
`bindDebuggerTools(trustedBridge)` helper is also the thin plugin-agent embedding
API; installing it into the separate plugin repository is not part of this stage.
An embedding must supply a trusted run-bound bridge, **not** an owner's general
RPC client or a model-created principal.

Implemented tools:

| Group                        | Tools                                                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Observation / reconciliation | `debug_status`, `debug_commandResult`, `debug_history`, `debug_replay`                                                                        |
| Explicit inspection          | `debug_threads`, `debug_stack`, `debug_scopes`, `debug_variables`                                                                             |
| Shared controls              | `debug_pause`, `debug_continue`, `debug_step`, `debug_breakpoints_patch`, `debug_exceptionBreakpoints_set`, `debug_detach`, `debug_terminate` |
| Explicit expressions         | `debug_evaluate`, `debug_setVariable` (and variable inspection / expression breakpoints)                                                      |
| Passive waits                | `debug_wait`, `debug_sleep`, `debug_cancelWait`                                                                                               |

Owner grants/policy/approvals, launch/attach/create/restart and source export are
not model tools. Unsupported backend capabilities remain explicit rejections.
The tool schemas are strict and bounded. Effectful tool arguments omit
`operation_id`; the trusted node bridge generates it once for the admitted call.
Run, task, installation, grant and target authority come from the actual scheduler
and owner-issued grant, never model labels. Receipt lookup takes an operation ID
as a **reference**, not permission to dispatch it. The bridge retains that ID outside
the call: admission failures are rejected; failures after possible dispatch return
`outcome_unknown` with the ID for reconciliation, even when audit writes or
publication fail. Suppressing values never changes a dispatched outcome into a
non-dispatch claim. A provider-native MCP allow rule
cannot bypass the debugger grant or ask-mode exact approval. The owner selects
exactly `ask` (each agent command approved) or `allow-all` (all authorized commands,
including expressions, execute without prompts) per grant. Reads that already
needed only scope authorization remain so. Human expression approvals are unchanged.
See [live mode switching and migration](debugger-control.md).

The scheduler supplies the actual conversation/workspace/run and resolves grants
only inside that scope. It re-resolves the newest unrevoked, unexpired grant for
the current incarnation before calls/publication, authorizing it before caching.
Superseded binding cleanup does not revoke a replacement task grant. Historical
payloads cannot cross an incarnation change during grant refresh.
Calls/publication require an active input. Interrupt,
settlement, failed startup and orphan reconciliation revoke that run's task grants,
including unused grants. Interrupt revocation commits atomically with the input
and interrupt receipt, before returning; queued proposals and every physical
admission also recheck trusted run activity. Provider cleanup closes the bridge before settling the
run; cleanup of timers/subscriptions precedes any potentially failing audit write.
A fixed trusted `DebuggerAgentBinding` is available for host embeddings that own
their own run lifecycle and call `close()` on settlement.

## Observations, not live awareness

Every result carries a completion-time `snapshot` and `observation`, or
`snapshot: null` / `observation: unknown` when fresh authorized state is unavailable.
Snapshots include incarnation, execution revision, stop epoch, breakpoint intent
identity/status, hit breakpoint IDs, per-thread stops and aggregate
running/stopped/mixed/unknown. An adapter success is not execution proof.

Bindings subscribe independently of the chat queue and refresh before each tool
admission and at provider delivery. They do **not** upgrade model-supplied stale
preconditions to a newer revision. A human action during inference/approval can
therefore reject an old proposal with current state. There is no automatic effect
retry, offline outbox dispatch or exclusive controller.

Pi's supported `context` hook refreshes copies of existing debugger tool results
at the next already-scheduled provider request. It adds `current_observation`
without presenting historical requested values as current. Revocation/expired
scope redacts those values from that outgoing context. A current grant must also
cover the original result's session and incarnation; current-target access alone
cannot authorize prior-target data, and missing original scope fails closed.
The persisted transcript is
not rewritten, no new message is appended, and no continuation is requested.
Claude's CLI exposes no equivalent verified live-context hook here: it receives
fresh state at tool boundaries, not inside an inference already in flight.
Previously delivered provider data cannot be recalled. Local extensions and agent
shell access remain outside the debugger permission boundary; this is not an OS
sandbox or a guarantee about provider-owned transcript storage/replay.

`NodeClient.debugger` supplies typed human-channel status/replay/control/wait/sleep
and a cancellable cursor watch. It is not agent authority. Watches do not start
turns. Disconnect marks cached observations last-known; a late response from an
older connection generation cannot restore a cached stop as current. Active watch
callbacks receive last-known state with `reason: connection_lost` before the watch
settles; ordinary caller cancellation does not emit a loss notification. Controls
refresh first but retain the submitted preconditions and never automatically resend.

## Objects and requested data

Select a stopped thread with `debug_stack`, a frame with `debug_scopes`, then an
opaque object handle with `debug_variables`. References do not grant read access.
Variable inspection is conservatively effectful. In ask mode it returns a pending
exact approval receipt; in allow-all it executes without a prompt. After dispatch,
`debug_commandResult` returns current control state plus the bounded, scoped
requested-data citation if still retained. History
is the source of those bytes, not an unbounded receipt cache; eviction remains
explicit in history. No unrelated values are automatically fetched/exported.

Variables accept `start`, `count` (1–100), `depth` (0–3) and `max_bytes` (1–8192).
Depth is an **upper bound**, not permission for extra getter/formatter execution.
The current conservative backend returns one explicit flat page:
`expansion_depth: 0`, requested `depth_limit`, `start`, `count`, `next` and
`truncated`. It never recursively reads children or returns new live child handles
after the effectful intent invalidates the old stop. A byte-limited first item can
leave `next` at the same offset; callers must change the explicit budget, not loop
blindly. Byte limits bound returned item data; small envelope/paging metadata and
the current snapshot are separate. One stopped thread does not prove globally
consistent memory. Historical data includes observation/stop identity and is not
labelled fresh object state.

## Wait and sleep

- `debug_wait(session, after_event_seq, kinds, timeout_ms)` subscribes synchronously
  **before** replaying the cursor. Already-matching retained events settle it
  immediately. An optional incarnation fences an old target. A gap, overflow,
  future cursor or changed incarnation returns `fresh_snapshot_required` plus the
  current snapshot instead of silently waiting across missing evidence.
- `debug_sleep(session, duration_ms, wake_on?)` uses a node timer only. Omitted
  `wake_on` uses owner policy; an empty array is a pure timer.
- An optional caller-scoped `wait_id` names either wait so a parallel
  `debug_cancelWait` can cancel it. It is a cancellation reference, not an effect
  operation ID or grant. Abort signals, MCP cancellation, IPC/socket loss and run
  settlement also remove timers/listeners. A different principal cannot cancel it.

Owner-only persisted policy defaults:

| Setting             | Default / restriction                                                                                                                                      |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sleep_max_ms`      | 60,000; configurable from 0 to 60,000                                                                                                                      |
| `sleep_wake_on`     | Debugger state observations; excludes output                                                                                                               |
| Default wake events | Stops/continues, thread inventory, invalidation, lifecycle/target/capabilities, execution intent, breakpoint intent/results and pending controls/approvals |

Durations over the owner ceiling reject; they are not silently shortened.
Termination, detach/failure, revocation/expiry and disconnect settle even a pure
timer. Results include `reason: elapsed | event | cancelled | connection_lost`,
`elapsed_ms`, a wait ID, optional event/gap code, and fresh or unknown state.
Target connection loss returns the reducer's unknown snapshot; node/bridge loss
can return null. No timer pauses the target, occupies the coordinator FIFO, polls
the adapter/model, sends a chat message or starts a model turn. Channel admission
also stays available for control/cancellation/heartbeat frames while waits run.

Admission is bounded (128 waiting calls per node/channel, 64 worker requests,
8 protected Claude socket connections). Provider/tool responses have an explicit
256 KiB ceiling; oversized state returns a size rejection with unknown observation,
not a silently shortened stop or a disconnected provider. B3 history retention
bounds and all grant/publication fences continue to apply.

## Verification and remaining gates

Fake clocks/adapters/providers cover scripted investigation, exact object approvals,
human interleavings, stale rejection, already-observed cursor events/gaps, pure
and event-woken timers, expiry/revocation/termination/disconnect, caller-scoped
cancellation, channel next-input admission, scheduler run settlement, protected
MCP and supervised pi IPC, safe context refresh/redaction, paging/depth/byte bounds,
default-off admission and late client responses. No live model is needed or used.

An audited adapter, reviewed renderer/target/build identity and independent control
host remain separate release gates. The plugin debugger view, real-provider
compatibility acceptance and integrated B7 recovery/security/release checks remain
later work. That plan uses only ask/allow-all permission controls and an owner-only
live grant switch, not selected auto classes or an always-separate agent-expression
approval. Fake fixtures do not certify an application or provider version.
