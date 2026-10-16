# Shared debugger control infrastructure (B3)

B3 adds the authorization boundary and shared coordinator. It is **gated
infrastructure**: target startup arrived later as the owner's `debugger.v1.start`
(see [recorded runs](trace.md#starting-a-program)); renderer attachment is not enabled. B5 subsequently adds
[gated provider tools, current-state delivery and timers](debugger-agent-tools.md).

## Availability and RPC boundary

`abele-node start --debugger` (or the daemon's explicit `debuggerOptions.enabled`)
enables the infrastructure capability; it defaults to **off**. It does not enable
or install a real profile. `profiles` remains empty while the JS audit is blocked.
The owner's `start`, `programs` and `attachProgram` are routed (see
[recorded runs](trace.md#starting-a-program)); create, restart, source export and arbitrary DAP
are not.
B5 extends the gated subset with wait/sleep and caller-scoped cancellation. There is no automatic target creation or adapter reconnect.

`DebuggerControlMethodSchemas` is the implemented RPC subset; the full
`DebuggerMethodSchemas` remains a declaration of v1, not an availability promise.
The subset includes snapshots, sessions, bounded replay/history, principal-scoped
receipt lookup, owner grant/policy/approval operations and typed controls/inspection
against a trusted host-registered backend. Without a backend, driver RPCs remain
unsupported. Older ordinary methods and offline mutation schemas are unchanged.
The authenticated channel supplies the human principal, never request arguments.

`DebuggerService`, `DapSession`, backend registration and the native profile remain
**trusted internal seams**. Do not expose them to a model or client. A trusted
agent bridge must use `DebuggerCoordinator` with a closure-supplied run/task/grant
context, then recheck `checkPublication` at the actual tool delivery boundary. B5
supplies that bridge and actual run/task-lifecycle integration; the B3 coordinator
remains the shared authority/dispatch boundary.
The channel scheduler already rechecks debugger responses immediately before send.
Handles, cursors, retained payload IDs and operation IDs are references, not grants.

## Shared control, proposals and exact approvals

One bounded FIFO serializes conflicting controls and inspection per session;
independent sessions proceed concurrently. There is no exclusive human/agent
controller. Human clicks and granted agent actions enter the same coordinator.
Adapter observations and output continue independently of the command queue.

An ask-mode agent proposal (or a human expression proposal) returns a durable
pending receipt immediately. It does
not wait on an owner while holding the coordinator lock or an RPC connection.
`approvals` returns exact proposals in 64 KiB pages, with `truncated` and `next`;
pass `next` as `after` to retrieve the next page. A proposal is never silently
shortened into a different approvable command. Approval supplies its principal
key, operation ID, exact proposal hash and approve/deny decision. Concurrent
approvals and duplicate commands join the same in-flight operation.

The hash binds normalized method/arguments, trusted actor, target identity and stop
state. Execution/incarnation/stop, breakpoint revision, live references and current
permissions are rechecked in the queue immediately before dispatch. A human step
while an agent proposal awaits approval causes `stale_state`, not a second step.
Output alone does not stale a proposal. Physical transport-slot admission rechecks
permissions and state too. The trusted driver may advance that fence synchronously
only for its own durable execution/breakpoint intent, never after a slot wait.

Agent grants have exactly two permission modes: **`ask`** and **`allow-all`**.
In `ask`, every agent command needs exact owner approval, including evaluate,
setVariable, variables, conditional breakpoints and expression logpoints. In
`allow-all`, every authorized agent command executes without a prompt, including
all those expressions and state changes. There are no selected auto-approval
classes or expression exceptions to allow-all. Modes govern approval, not target
scope, allowed actions, capability checks or read/publication authorization.
Human expression proposals still require separate exact approval; the agent mode
does not change human-channel behavior.

Breakpoint approval hashes and proposal pages include `effective_breakpoints`:
the complete resulting requested set, not merely `upsert`. In ask mode, an
expression inherited from stored intent is covered by this operation's fresh exact
approval, including an empty/basic patch. In allow-all, no exact approval is
required, but expression permission is still checked for the entire resulting set.
A basic-only grant remains denied until the expression is removed or expression
authority is granted. Unknown/effectful variable inspection
is conservatively treated as an expression: capture the selected reference, expire
handles and execution certainty before sending, then retain only the explicitly
requested inert bounded values, not new live object handles. Stack and scopes use
bounded typed inspection, not evaluate fallbacks. No automatic recursion/getter,
formatter invocation or variable export is added. Inspection is not claimed to be
universally read-only; reviewed profiles must establish their classification.

Line-based breakpoint patches additionally require matched build identity and
known sources in the typed backend. Conditional/logpoint and setVariable adapter
capabilities are checked. The node retains identity-addressed intent and sends
complete source sets. B4 must establish real source/build/renderer evidence;
setting metadata in a synthetic fixture is not that verification.

## Separate agent grants and provisional owner-only defaults

Enrollment authenticates an owner. Delegation grants authorize delegated chat
work. Debugger grants are a **separate** durable authority table and contract.
Every current enrolled installation is an owner under the existing authority
model; an agent does not become a human owner by inheriting its installation ID.

A debugger grant binds installation and retained controller/approving authority,
run, task, conversation, workspace (including explicit null), selected session,
incarnation, target, allowed actions and absolute expiry. It does not turn an
external worktree into a managed workspace. A revoked paired key cannot revive a
grant even if subsequently enrolled again. Reads and retained history/replay are
authorized against the current scope as well as controls. History additionally
checks each row's session, target and incarnation against the agent grant before
paging; rows from a replaced target or prior incarnation are excluded. An
incarnation fixes all target metadata, including workspace/conversation. Enrolled
human owners retain the existing global-resource policy for historical reads.
Device revocation and node-key rotation also atomically tombstone pending exact
approvals authored by that paired registration, independently of who issued the
agent grant. Queue and physical admission consult that durable marker. Re-enrolling
the same installation/key cannot restore an old approval; a new proposal and
explicit approval are required.

Owner-only `policy.get` / `policy.set` persist these provisional defaults:

| Setting                | Default / restriction                                |
| ---------------------- | ---------------------------------------------------- |
| Agent mode             | `ask`; exactly `ask` or `allow-all`                  |
| Grant lifetime ceiling | 1 hour; owner-configurable from 1 ms to 24 hours     |
| Grant expiry           | Owner supplies an absolute expiry within the ceiling |

The policy mode is a default for new grants, not a change to existing authority.
Owner-only `debugger.v1.grant.setMode({ grant_id, mode })` changes a live grant
without extending its expiry or changing its scope/actions. Revoked or expired
grants cannot be revived by switching modes. Switching to `ask` puts queued
commands without exact owner approval back into durable pending approval; a prior
allow-all admission is not an exact approval. Already exactly approved commands
retain that approval and all its fences. The physical dispatch guard also checks
mode after slot waits. Beyond the durable `possible` marker, a denied guard
returns `outcome_unknown` / `approval_required`, never false non-dispatch certainty.
Switching to `allow-all` admits existing unapproved pending commands to the FIFO,
where stale-state and all other checks still apply. Neither switch retries terminal
receipts or can undo an effect already sent.

Approval-free execution exists only inside a bounded task grant. Revocation or trusted task
settlement invalidates pending proposals and queued commands; permissions/expiry
are checked again on dispatch and publication. Grant expiry cannot allow a stale
pending proposal to dispatch. Permission changes do not promise to undo an effect
already dispatched. The trusted `settleTask(task, run)` hook must be called by B5's
actual run/task lifecycle, not by a model-supplied task label. B5 also adds owner-only
`sleep_max_ms` and `sleep_wake_on` settings to the same persisted policy.

## Durability, recovery and data bounds

Migration 14 adds debugger grants, owner settings and principal/run-scoped operation
receipts, independently of ordinary operation receipts and evictable history.
Migration 15 replaces stored `auto` modes / `auto_actions` with `ask` and removes
those class lists from grants and policy. Even a legacy grant containing every
auto class migrates to ask, never allow-all. New RPC inputs reject `auto` and
`auto_actions`; the new allow-all mode requires explicit owner selection.
Durable intent precedes external effects. A `possible` dispatch marker is committed
before calling a backend; acceptance and adapter success are not process proof.
Same principal/operation ID and normalized method/body return the existing receipt;
a changed body returns `idempotency_mismatch`. A queued duplicate joins the same
promise. Lost results, backend exceptions and restart after pending intent become
`outcome_unknown`, never a replayable target effect. Even pending asks are settled
conservatively on restart, including when the capability is now disabled.

Startup rotates target incarnations, expires live references and marks live state
unknown/connection-lost. It restores metadata/settings/history only, not drivers,
processes or timers. Completed receipts survive history/payload eviction. Ordinary
client outbox admission and flush reject **all** debugger entries with
`debugger_online_only`; receipt lookup may be retried online, but control intent
is never automatically resent by reconnect.

The bounded history journals actor-labelled proposal, approval/denial, dispatch
intent, outcome and explicitly requested returned data. Proposal arguments and
approval hashes are requested evidence, not automatic raw adapter traffic or
memory capture. Selected values may reach a provider only through a later explicit
bridge; there is no automatic provider export or telemetry. Receipt lookup returns
control evidence and a current snapshot; returned values live in bounded history,
not an unbounded receipt payload cache. Pending intents keep exact arguments only
until settlement; terminal dedup records discard them and retain hashes/outcomes.
Stored receipts also omit old snapshots, rehydrating current state on delivery, so
old expression/breakpoint/stop data cannot bypass history payload eviction.

B1 history budgets remain 128 metadata entries and the latest 16 requested payloads
of 8 KiB each, with explicit preview/expiry/truncation evidence. Additional B3
provisional admission bounds are 128 pending operations/queue slots per session,
16 KiB normalized command bodies, 64 KiB cumulative breakpoint intent, and 10,000
durable receipts / grants per node. Receipt/quota exhaustion denies admission;
it does not evict deduplication evidence. Proposal pages are byte-bounded; other
oversized RPC responses explicitly return `debugger_response_too_large` rather
than disconnecting or silently dropping evidence. Later client reconciliation and
larger snapshot/history paging remain later limit work. B5 bounds provider results
and labels unavailable/oversized observations unknown.

Every audit write and physical dispatch uses the core-wide storage fence. Failed
intent storage sends nothing; failure after possible dispatch leaves reconciliation
evidence uncertain. Storage failure blocks subsequent effects across sessions.
Host-owned adapter/process cleanup remains independent of journal writes and is
not exposed as a permission bypass or blind replay API.

## Verification and later gates

Fake tests cover both permission modes (including framed DAP expressions,
setVariable, variables and conditional/logpoint sets), live mode switches at FIFO
and transport-slot admission, exact approval during a switched queue, safe legacy
migration, human/agent interleavings, exact approvals and changes, output-only
observations, slot waits, revocation during queue/publication, scope/expiry/task
settlement, paired re-enrollment, stolen handles, inspection-entrypoint bypass,
principal-scoped duplicate/mismatched bodies, intent/dispatch/result crash boundaries,
disabled restart, history eviction, storage failure and proposal/command bounds.
Fake framed DAP tests exercise approved step/evaluate/setVariable/variables and
complete conditional/logpoint sets. Authenticated daemon tests exercise the default
off and explicit-on gate plus offline outbox denial, without adapters or models.

B4 remains responsible for reviewed Obsidian/Electron bootstrap, target/build and
source-map verification, and independent control-host evidence. B5 adds trusted
provider bridges, run settlement, typed client reconciliation and wait/sleep (see
[the B5 contract](debugger-agent-tools.md)); B6
adds the actual approval/control UI. The implementation plan for B6/B7 is to expose
exactly ask and allow-all per grant, an owner-only live mode switch and exact
proposal controls in ask; no action-class auto-approval selector or mandatory
agent-expression prompt in allow-all is planned. A real JS pin, audited distribution and explicit
no-model application smoke checks are still release blockers, not passed by these
synthetic tests. See [native JS audit](debugger-js-profile.md) and
[base debugger state contracts](debugger-v1.md).
