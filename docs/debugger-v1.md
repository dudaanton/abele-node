# Debugger v1 infrastructure (B1–B5)

Evaluate receipts expose optional `message` (up to 256 characters) for a confirmed
adapter rejection: `outcome: failed`, `dispatch: dispatched`,
`code: adapter_rejected`. Clients can display this text for failed watches;
`commandResult` retains it for receipt lookup. The failed history entry also
contains `requested_data: { code, message }`. Transport loss remains
`outcome_unknown` with `dispatch_uncertain`; see the
[control guide](debugger-control.md) for receipt and retry rules.

This is **gated infrastructure, not a usable debugger**. B3 exposes only explicitly
enabled, authorized coordinator RPCs. B5 adds gated agent tools, cursor waits and
current-state delivery; target startup and plugin UI remain unavailable. See
[agent tools and timers](debugger-agent-tools.md) and
[shared control and authorization](debugger-control.md). B2 added
an internal bounded transport/driver and a native JS/TS profile, which runs programs
once the owner-approved js-debug pin is explicitly installed. See
[Native JS/TS infrastructure](debugger-js-profile.md) for the audit and host profile.
`docs/debug-probe.md` describes separate experimental feasibility work; its adapter
pins and experimental opt-in are not production dependencies.

## Contracts and availability

Breakpoint requests and snapshot breakpoints accept optional `hit_condition: string`
(1–8192 characters) and `enabled: boolean` (omitted means enabled). Both survive
patches, approval normalization and recovery. Disabled points remain durable intent
and are omitted from DAP `setBreakpoints`; hit counts use DAP `hitCondition` and
require the session capability `supportsHitConditionalBreakpoints`. Node advertises
`debugger_v1.breakpoint_hit_condition: true` and `debugger_v1.breakpoint_enabled: true`.
Hit conditions on enabled points require exact approval like conditions and logpoints.

After evaluation, old handles expire. A successful, fenced stack probe confirms that
the evaluated thread remains stopped; clients can request fresh stack/scopes handles
and step again. A newer execution event takes precedence over that probe.

With `debugger_v1.evaluate_watch`, clients may send `context:"watch"` to
`debugger.v1.evaluate`. This uses the adapter's frame-bound watch evaluation and
keeps the physical stop, its revision and existing handles. It does not fabricate
an execution intent or a replacement stop. Real stop/continue/invalidation events
still expire handles and reject an overtaken result. Expressions retain the same
approval requirements and can execute getters or other code; this mode is not a
side-effect-free evaluator. Omitted context preserves the existing REPL behavior.

Nodes advertising `debugger_v1.launch_preflight` reject missing entry programs
with `debugger_program_not_found` before starting an adapter or program. Other
filesystem access failures use `debugger_program_unavailable`. These are known
launch failures; clients should keep the current session and show the failure
without reconnecting or claiming an unknown launch outcome.

Stack items also return optional `path`, the adapter's mapped source path bounded
to 4096 UTF-8 bytes. It is retained for callers outside the admitted source set,
whose `source_id` stays null. Real internal paths retain their `node:` prefix.

`addSources` distinguishes `debugger_source_test` and `debugger_source_generated`
from `debugger_source_no_map`. Test/spec paths and generated/build output paths are
classified separately (the program's own entry script remains admissible). Source
identity uses retained digests, source-map content, and bounded read-only V8 source
evidence at attach. Timestamp checks remain a fallback when content evidence is
unavailable. Identical rebuilds and restored bytes retain their source identity.
`sourceStatus` and `breakpointLocations` recheck retained content evidence on
each query, including already admitted sources. Changed files fail with
`debugger_source_changed`; touching a file without changing its bytes is allowed.
A repeated attach to the same live process in the same folder returns its existing
session, including concurrent requests with different operation IDs.

With `debugger_v1.persisted_sources`, the owner can read
`debugger.v1.sources({debug_session_id})` to obtain `{sources:[{source_id,path}]}`.
Paths are relative to the registered folder, retained for each adapter session and
updated by admission. They remain available after detach and node recovery, without
opening files or obtaining a stack. An empty legacy mapping is unknown evidence;
clients must not derive filenames from opaque source IDs. This inventory describes
retained identity, not proof that the current bytes are loaded or executable.

With `debugger_v1.source_runtime_admission`, use `require_loaded:true` on
`debugger.v1.addSources` for executable margins. In addition to content/build
checks, the node requires the current adapter to list the canonical source as
loaded and return an executable position in lines 1–1000. Refusals distinguish
`debugger_source_not_loaded`, `debugger_source_not_executable` (no position in that
bounded window), and `debugger_source_unverified` (adapter lacks the evidence).
A project source map alone does not satisfy this mode. Omitted `require_loaded`
retains the existing source-identity admission contract.

`debugger_v1.session_started_at` already advertises
`debugger.v1.sessionInfo({debug_session_id}) -> {started_at}`. This immutable retained
timestamp is the debugger session's creation time, not process boot time or
`observed_at`; it is suitable for session-list start metadata.

With `debugger_v1.session_exit_reconciliation`, listing sessions reconciles retained
external attachments against recorded process-exit evidence or an OS `ESRCH`
probe. Proven dead targets become `terminated` in both inventory and status.
Permission failures and unavailable OS evidence leave the retained state intact;
detaching or losing the adapter alone never proves that a process died. Exit
events received during detach are retained and take precedence over `detached`.

Inspection responses retain structured `data.items` and their snapshot even when
recording state grows. Snapshot metadata is bounded separately from the inspection
page; page truncation removes trailing items and sets `truncated`, never substitutes
a preview object for a typed page.

`packages/node-protocol/src/debugger.ts` declares strict, versioned Zod contracts
for debugger requests, session snapshots, replay cursors, receipts and history.
Debugger session IDs are distinct from provider/chat and adapter connection IDs.
Target metadata identifies the node, project, optional managed workspace, worktree,
conversation, launch configuration and adapter identity. An external worktree is
not implicitly made into a managed workspace.

The internal `NodeCore` constructor option `debuggerEnabled` defaults to false.
Only an explicitly enabled core advertises `debugger_v1`, whose evidence states
that this is bounded-state/DAP/shared-control infrastructure with a pinned JS
profile. `profiles()` returns an empty list until the pinned adapter is installed.
The native profile also requires its separate explicit switch. There is no daemon
flag enabling real profiles. B3's `--debugger` flag enables authorized infrastructure
only. Declarations are deliberately **not** merged into ordinary routable/offline
`MethodSchemas`: B3 routes its separately validated subset through authorization,
and old clients retain their existing methods and negotiation behavior.

`DebuggerService` and `DebuggerAdapterSink` are trusted internal seams, not access
control boundaries. Do not wire them directly to RPC or tools. B3's coordinator
authorizes reads, control and publication; a handle never grants permission. It
adds shared human/agent control, scoped grants with exactly ask/allow-all agent
modes, exact ask-mode approvals and durable receipts, not an exclusive controller.
Allow-all includes expressions and state changes without prompts; it does not
remove authorization, stale-state or audit fences. Migration 15 maps all legacy
auto-class grants/settings to ask. The later UI plan uses these same two modes,
including an owner-only live grant switch; there is no action-class auto-approval
selector. Human expression approval behavior is unchanged.

## State, cursors and references

- `event_seq` orders every observation, including output and superseded replies.
- `state_revision` fences execution observations/intents independently of output.
- `breakpoint_revision` fences identity-addressed breakpoint edits independently.
- `thread_inventory_revision` fences `threads` replies against inventory changes
  since request dispatch; the normalized reply must carry that captured revision.
- `incarnation` fences adapter/target identity across replacement and node restart.
- `stop_epoch` fences frame/object references on execution changes, invalidation,
  effectful expression intent, target replacement and restart.

Snapshots retain per-thread running/stopped/unknown states and stop metadata.
Aggregate state is conservative until a complete thread inventory or an explicit
all-thread observation is available. One partial stop does not prove global
consistency. Thread discovery/exit invalidates inventory completeness; stale
inventory replies are ignored without removing current threads. A fresh accepted
inventory reply also fences older in-flight replies. Ambiguous stop/continue events
without a thread ID or an explicit all-thread flag clear execution certainty and
stop metadata; unknown threads cannot receive new handles. Target replacement
clears adapter capabilities until the new adapter reports them.

An accepted execution intent marks state unknown, not running:
acceptance/dispatch is not proof of a target effect. Requested breakpoint locations
remain separate from verified/relocated/rejected/pending adapter results. A reply
for an older breakpoint revision cannot overwrite newer intent.

A snapshot and its replay cursor come from the same stored row. State and its
replay event commit in one synchronous SQLite transaction. Replay checks the
incarnation and every retained sequence: overflow, missing metadata or an internal
gap returns `fresh_snapshot_required` with a fresh snapshot/cursor. Output can be
truncated without invalidating controls; truncated state metadata requires resync.
B5 adds synchronous committed-state listeners and cursor-based waits, without a
background value/event queue. Clients subscribe from the returned cursor,
reconcile gaps and label disconnected state last-known.

Frame/object handles are random non-numeric tokens bound to a session, incarnation,
stop epoch, kind and stopped thread. Invalid or expired references return an explicit
error with the current snapshot. Handles are process-local and never restored.

## Persistence and bounds

Database migration 13 adds independent debugger session, replay and history tables
without reinterpreting chat/provider sessions or changing existing receipts.
Startup retains metadata, breakpoint intent and requested history, rotates each
incarnation, clears current stop/selection state and marks formerly live sessions
`connection-lost`/unknown. Detached, terminated and failed lifecycle labels remain.
No adapter reconnect, process relaunch or effect redispatch is attempted.

Current infrastructure limits are provisional, per session, and exported as
`DEBUGGER_LIMITS` (not a final sensitive-data retention policy):

| Resource                     | Bound                          |
| ---------------------------- | ------------------------------ |
| Threads / breakpoint intents | 256 each                       |
| Retained replay events       | 128                            |
| Serialized replay record     | 64 KiB                         |
| Output text per observation  | 4 KiB, UTF-8-safe preview      |
| History metadata entries     | 128                            |
| Requested-data payloads      | Latest 16 payloads, 8 KiB each |
| Live frame/object handles    | 1,024                          |

History journals trusted actor, operation, outcome, observation time, event/stop
identity and explicitly requested data. Oversized data becomes an inert, explicitly
truncated JSON preview. Payload eviction retains metadata with `expired`; metadata
eviction reports `truncated_before`. No variables, memory or raw adapter traffic
are captured automatically. History is retained evidence, not a live object browser,
full recording, deterministic replay or time travel. B3 keeps deduplication receipts separate from these evictable tables and adds
publication/revocation checks.

All writes use the existing audit-storage transaction fence. A failed write rolls
back both snapshot and replay evidence; subsequent mutation attempts fail closed.
B1 itself starts no processes. B2's internal process supervisor/driver keeps cleanup
independent of failed audit writes; it is not connected to public control admission.

## Tests and next stage

`tests/debugger/` retains B1's test-only framed adapter cases for fragmented UTF-8,
malformed/oversized frames, out-of-order breakpoint replies, partial stops, output
floods, isolation, expired handles, storage rollback, restart and migration
compatibility. B2 additionally tests the actual node-owned bounded transport and
session driver with fake streams, request lifetimes/cancellation, reverse denial,
separate root/child reducers, bounded inspection, PID reuse, owned cleanup and
safe detach. The opt-in pinned-adapter test is skipped while no clean pin exists.

B2's real adapter distribution/compatibility gate remains blocked by upstream
advisories; it is not a certified JS/TS or Obsidian debugger release. B3 adds shared
coordination, grants/approvals, durable receipts and read/publication authorization
before its gated control subset is routed. B5 supplies gated tools, wait/sleep and client reconciliation. Obsidian renderer
attachment and the plugin UI remain separate stages. See
[the B2 audit and driver limitations](debugger-js-profile.md).
