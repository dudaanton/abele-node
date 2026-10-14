# Native JS/TS debugger infrastructure (B2)

This document records B2's driver/profile gates. B3 subsequently added the
[authorized shared coordinator](debugger-control.md) and an explicit infrastructure
RPC switch; it did **not** enable this profile or any target startup RPC. B5 adds
[gated agent tools and timers](debugger-agent-tools.md) over that coordinator,
without relaxing the profile audit/startup gate. References
below to unavailable control RPC describe B2's original boundary, not a profile
availability promise.

B2 adds an internal node-owned DAP transport and driver. The real JS/TS profile
works only under `--debugger` and once the pinned adapter below is installed. B3 must add shared coordination and
read/control authorization before any driver operation is routed to clients.

## Adapter decision and advisory check

Checked on **2026-10-10** using the official
[`microsoft/vscode-js-debug` releases API](https://api.github.com/repos/microsoft/vscode-js-debug/releases?per_page=10)
and its `releases/latest` endpoint. Both identify **1.140.0** as the newest
published release. The standalone artifact `js-debug-dap-v1.140.0.tar.gz` has SHA-256
`27dab92937ec1ab35821ae955aac867544fe06a1b6307229049f2d789af10968` and is MIT-licensed.

Audit the official release's `package.json` and `package-lock.json` using
`npm audit --omit=dev --json`. This check reported **five affected production
packages: four high and one critical**. Advisory records included:

| Package                | Advisories / reason                                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shell-quote`          | Critical command injection, [GHSA-pqg4-j6r4-53mv](https://github.com/advisories/GHSA-pqg4-j6r4-53mv)                                                                                                                         |
| `braces`               | High stack exhaustion, [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)                                                                                                                              |
| `micromatch`           | High via the affected `braces` dependency                                                                                                                                                                                    |
| `http-cache-semantics` | High cached-response disclosure, [GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)                                                                                                                    |
| `brace-expansion`      | [GHSA-q2hr-2g5m-vwhr](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr), [GHSA-qhr7-859c-m2p7](https://github.com/advisories/GHSA-qhr7-859c-m2p7), [GHSA-6j4f-fj2g-mc7p](https://github.com/advisories/GHSA-6j4f-fj2g-mc7p) |

An upstream lockfile finding does not establish exactly which vulnerable code is
reachable in a standalone bundle. On **2026-10-14** the owner accepted 1.140.0 with
these findings: the node starts the adapter with an empty environment, attaches to it
over loopback with a fixed configuration, and refuses terminal launches and any
reverse request other than the adapter's own child session, so the affected paths are
not expected to be reachable. It is the same adapter VS Code ships.

`JS_DEBUG_PIN` in `packages/node-core/src/debugger/js-install.ts` holds that exact
version, URL and SHA-256. A newer release is a new decision with its own audit, never a
substituted version number. Explicit installation is the only distribution path:

```sh
abele-node debugger install js
```

It downloads the pinned archive, refuses it unless the checksum matches, and installs
it under the node's state. Nothing is bundled, silently downloaded on use, or taken from
a user-supplied version or source. Until it is installed the profile lists nothing and
`debugger.v1.start` answers `debugger_profile_unavailable`.

The installer primitive is exercised only with synthetic archives. It bounds
compressed/unpacked bytes, verifies the checksum before extraction, rejects
links/traversal/device records/unsupported tar extensions, stages installation,
and records version, license, archive checksum and per-file hashes. Startup
rechecks installed bytes against the retained, checksum-verified archive rather
than trusting editable manifest hashes. A pinned official archive's layout and
notices must still pass review; synthetic tar tests do not establish compatibility.

## Host profile and configuration

The intended host matrix is native AbeleNode on **macOS and Linux**, using the
host's Node.js runtime. Adapters and targets execute on that host, never inside
Obsidian. Windows, Docker-to-host application debugging, browser debugging and
Electron/Obsidian attachment are not enabled by B2.

`JsDebugProfile` is a trusted internal seam, like B1's `DebuggerService`, not an
authority boundary. It requires all of:

1. An enabled `debugger_v1` core (`debuggerEnabled`, false by default).
2. The profile's separate `enabled: true` configuration switch, false by default.
3. The reviewed source pin and its verified explicit installation.

The owner's `debugger.v1.start` reaches it under `--debugger` (see
[recorded runs](trace.md#starting-a-program)); it refuses until the adapter is installed. Existing
clients remain compatible, and all `debugger.v1.*` RPC methods remain unsupported.

Launch configurations use typed executable/program paths, argv and an explicit
string environment, with no shell, inherited environment, preparation commands,
VS Code tasks or package-manager downloads. The runtime is the native node's own
Node executable. Entry programs and explicit source paths are confined to the
selected workspace, including symlink resolution. Programs may be compiled JS
with TS source maps, or Node-hosted test-runner entry scripts. This does **not**
certify all test-runner/worker configurations or executing-build/source-map identity.
`NODE_OPTIONS` and arbitrary inspector/runtime switches are rejected. Native Node
test workers still need a separately reviewed child plan.

Native launch spawns the target with a loopback ephemeral inspector endpoint, then
uses DAP attach. Node ownership is not inferred from adapter-reported PIDs. Ownership
evidence (directly spawned PID, OS start identity, random ownership ID, executable
hash) is retained in target metadata. The supervisor checks direct-child exit state
and OS start identity before each TERM/KILL signal and requires observed exit; a
PID mismatch fails closed. It never signals a process group or adopts adapter-created
children. This is not an OS sandbox or a general process-tree supervisor.

External attach requires an explicitly selected loopback endpoint and PID. OS
liveness is checked, but endpoint-to-PID and loaded-build identity are **unknown**:
B2 does not pretend that an adapter response proves either. Attached processes are
never eligible for owned termination. Reviewed target discovery/build identity
belongs to later gates, including B4's separate Electron profile.

## Driver behavior and bounds

`DapTransport` accepts node-owned streams. It decodes fragmented UTF-8 using strict
Content-Length framing, correlates responses by request sequence and command, and
supports concurrent out-of-order replies. Unknown/mismatched replies, invalid JSON,
invalid UTF-8, invalid headers and oversized frames fail the connection closed.

| Resource                                              | Default bound                         |
| ----------------------------------------------------- | ------------------------------------- |
| Frame / header                                        | 1 MiB / 8 KiB                         |
| Concurrent outbound / reverse requests                | 64 / 16                               |
| Waiting request-slot admissions                       | 64, bounded FIFO; cancellable         |
| Breakpoint batch workers                              | At most 4, capped by connection limit |
| Request, reverse request, partial-frame lifetime      | 10 seconds each                       |
| Initialized-event barrier                             | 10 seconds; cancellable               |
| Outstanding stream write bytes                        | 1 MiB; overflow closes the connection |
| Retired-response / reverse-request duplicate evidence | 128 entries each                      |
| Covered child sessions                                | At most 8, one level                  |
| Stack / variable requested page                       | At most 100 items                     |
| Returned stack / scope / variable page data           | At most 8 KiB                         |

Timeout/cancellation settles a request and removes its timer/listener. Explicit
cancellation sends DAP `cancel` only when negotiated; it never guarantees that an
already-dispatched target effect was prevented. A bounded retired-response window
absorbs late replies; older uncorrelated replies require connection recovery. EOF,
stream errors and framing failure settle all pending work. No blind request replay
is attempted. No unbounded output/event subscription queue or raw traffic capture
is introduced. Active reverse-request sequences are tracked independently of the
bounded completed history and cannot be evicted by a completion flood. Slot waits
include their waiting time in the request deadline and settle on cancellation/EOF.

`DapSession` waits for the adapter's `initialized` event before configuration;
initialize/start replies alone do not release that bounded barrier. It feeds B1's reducer with per-session capabilities, thread inventories,
stops/continues, output, invalidation and lifecycle observations. Threads replies
carry dispatch-time inventory revisions. Resume/step intent expires handles and
marks execution unknown before sending the effect; success is not execution proof.
Inspection replies are fenced against their dispatch-time stop state. Frame/object
handles remain opaque and session/epoch scoped; unknown sources are not returned
as arbitrary filesystem paths. Sourceless native/internal frames may retain DAP's
zero line/column values. Paging and byte truncation are explicit; variable requests
always include bounded `start`/`count` because variable paging is a client capability,
not an adapter capability. Inspection
is **explicit-only**, not universally read-only: getters/formatters remain a later
approval concern. There is no evaluation-based fallback or recursive value capture.

Breakpoint synchronization translates the complete node-owned intent for each
source into `setBreakpoints`, including an empty set after the last removal. Replies
and later breakpoint events carry the intent revision; old replies cannot overwrite
new intent. Source batches use bounded worker concurrency and shared transport-slot
admission, including when launch/attach remains pending. Admission rechecks audit
storage immediately before dispatch. Exception filters, pause, continue and step
over/in/out use typed methods. Every normal driver dispatch, including inspection,
checks the core-wide audit-storage fence: one session's storage failure blocks effects
in other sessions too. Cleanup deliberately bypasses that fence. B3 still has to
serialize conflicting commands and journal durable receipts.

Root and covered child connections own separate reducer sessions and handle spaces.
A `startDebugging` request is accepted with a bounded pending-target ID and either an
exact copy of the covered configuration or js-debug's own child form: the parent's
`type` and a display `name` of at most 128 characters, nothing else. Uncovered
children, grandchildren, `runInTerminal` and unknown reverse requests are denied.
js-debug runs a Node program in that child, numbers its only thread and its first
breakpoint `0`, and reports a column for every breakpoint; none of these is an error
or a moved breakpoint. As `debugger.v1` counts threads from 1, the adapter's thread 0
travels as `Number.MAX_SAFE_INTEGER`, an id no adapter may use itself. Terminating a run detaches the children first, as js-debug
answers the root's disconnect only once they are gone.
Root connection loss closes child transports; child loss does not corrupt root state.

Detach always requests `terminateDebuggee: false` and leaves attached targets alive.
Termination never asks an adapter to choose which process to kill: only the node's
owned supervisor may signal its directly spawned target. Disconnect failure and
audit-storage failure cannot suppress owned cleanup. Native run shutdown closes
transports and bounds process cleanup independently of journal writes. An uncertain
detach never falls back to killing and still releases/unrefs the living target. All
concurrent run-close callers await one shared cleanup completion or failure.
Profile/run cleanup is an internal host lifecycle
responsibility; B3 must integrate it with authorized service admission.

## Verification and remaining release gates

`tests/debugger/` covers the transport with fake streams, complete-set breakpoints,
all step variants, exceptions, stale inspection replies, paged/byte-bounded data,
isolated child sessions, reverse denial, early failures, audit failures, PID reuse,
owned shutdown and detached-target survival. Ownership tests spawn only disposable
synthetic Node programs, never an application or a model.

The real-adapter checks are opt-in. Install explicitly into their disposable test state:

```sh
abele-node debugger install js --state-dir .scratch/debugger-integration/state
ABELE_DEBUGGER_LOCAL_TEST=1 npx vitest run tests/debugger/local-js.test.ts tests/trace/local-run.test.ts
```

They stop, inspect and step a synthetic program, and record values at a record point of
a JavaScript program and of a TypeScript program through its source map.

The test never installs anything itself; ordinary CI skips it when the adapter is
absent. It checks a tiny node-owned synthetic JS program, inspection, stepping and
expired handles, then cleans up. A real smoke check, audited adapter distribution,
actual TS location/build checks, broader reviewed child/test-runner coverage and
Electron compatibility are **not established by B2's fake tests**.

B3 now adds the shared coordinator, scoped grants, ask-mode exact approvals
(or prompt-free allow-all, including expressions), durable principal-scoped
receipts, authorization for reads, uncertain-dispatch
handling and bounded history/publication controls. Its implemented infrastructure
RPC subset is explicitly gated; native profile startup is still unavailable. B5 adds gated provider tools and wait/sleep; plugin UI and Obsidian renderer support
remain separate stages.
