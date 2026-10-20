# Folder journeys: cross-session recording contract (R24)

Status: design contract for the plugin and a future node aggregate API. The aggregate RPC below
is **not implemented or advertised**. Existing single-run APIs remain supported. Merging only
the first pages of several live runs would silently lose events and join unrelated `n1`/`t0001`
identifiers. A reliable aggregate needs a shared snapshot, qualified identities, and explicit
evidence for cross-process links; it is larger than the R17/R22 recorder corrections.

## Product behavior and data ownership

One folder journey displays selected runs from the project's configured runs folder as parallel
session lanes and one chronological list. It is a read-only view, not a new recording or a merge
of files. Runs retain independent lifetimes, deletion, marks, and original session IDs. The user
selects runs and optionally a time window or an order value. Do not automatically include every
historical run that happens to share the folder. Never move the sink's traffic into the server's
run to construct this view.

A row's identity is `{run_id, step_id}`; its lane is `{run_id, debug_session_id}`. `chain` is local
to its run: its qualified identity is `{run_id, chain}`. Two processes can both produce `n1`,
`t0001`, or the same breakpoint name. All selection, expansion, marks, value reads and links must
keep the run ID. Resolve a value with the existing `trace.v1.value` using its original run and
step; do not synthesize a value handle under a journey ID.

Incoming and outgoing program HTTP rows retain `direction`. Saved-request summaries retain
`sent: true` and are shown as client observations, not as another process. Such a summary is
recorded only after this session's captured incoming traffic confirms its destination. A saved
summary and an incoming row may describe the same exchange; the UI may fold them into one group,
but must keep their separate identities and evidence.

## Ordering and correlation

Sort on each step's absolute `ts`, then `run_id`, then numeric `tNNNN` sequence. Never compare
`at` across runs: their starts differ. Keep each row's original `at` for its lane. A time window
is `[from_ts, to_ts)` and is applied before pagination. Include lane/start/end metadata even for
lanes with no matching rows. Recordings currently use wall clocks without remote clock-skew
measurement; expose `clock_uncertainty_ms: null` and do not present ordering as causal proof.

Extract evidence from bounded `request` JSON headers and `http` JSON response headers of program
HTTP steps. Header names are case-insensitive. Do not parse response bodies looking for header
names. Do not use masked values (`••••`), failed values, truncated identifiers, or invalid headers
as correlation evidence. Never read an unbounded blob merely to extract an identifier. Each link
has qualified endpoints and one of these reasons:

| Reason        | Meaning                                                                                                                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chain`       | A probe belongs under an HTTP row in the same run, using existing `chain`/`by_time`. Preserve the temporal qualification.                                                                                                                   |
| `traceparent` | A valid W3C traceparent shares a nonzero 32-hex trace ID. Group the journey by trace ID; an outgoing/incoming pair with the same nonzero 16-hex parent/span ID is a candidate for the same exchange, not automatically a parent-child edge. |
| `request_id`  | Exact matching `x-request-id` or `x-correlation-id` values on opposite HTTP directions, or an `x-abele-step` matching a saved-send chain ID. Reused IDs can produce multiple candidates.                                                    |
| `time`        | Time proximity alone suggests a candidate exchange. Always mark this as heuristic; never silently merge rows or propagate causal ownership.                                                                                                 |
| `value`       | The same selected order value occurs in recorded values. This is a data-flow occurrence, not an HTTP or causality claim.                                                                                                                    |

For an exchange candidate, require an outgoing row in one session and an incoming row in another,
the same method and matching destination authority/path/query, and compatible intervals within
the selected time tolerance (default 1000 ms; configurable 0–30000 ms). URL normalization removes
fragments and normalizes standard scheme/default-port spelling, but must not equate different
ports, query values, or arbitrary hostnames. The user may explicitly supply endpoint aliases for
localhost/container/proxy addresses; preserve those aliases in the snapshot's query metadata.
Explicit trace/request IDs may group rows outside the time tolerance, but do not fabricate a
transport edge where the endpoint or method disagrees. Missing identifiers must stay missing;
do not inject traceparent into the program's requests as part of viewing recordings.

Return **all** bounded candidates when matching is ambiguous, with `ambiguous: true`; do not
choose the newest request across processes as if proven. A common trace ID groups server → worker
→ sink without requiring one request ID across every hop. Do not infer a worker queue handoff
from timestamps alone. Without propagated headers, an order value can still connect its observed
occurrences across the three lanes.

## Existing RPC integration available now

For small, completed selections the plugin can build a journey without a new screen-specific
node API:

1. Get `trace.v1.runs`, select IDs in this project, and read **all** pages of each selected run
   with `trace.v1.run`; carry `run_id` alongside every returned step. Use the response's `next`
   cursor/offset, not the last step number. Keep `kind: ["http"]` as a display filter after the
   complete event inventory has established code-step associations.
2. Merge by absolute timestamp and qualify all chain IDs. Read the bounded request/HTTP metadata
   through `trace.v1.value` only when needed for the correlation rules above.
3. For “follow this order across the folder”, call `trace.v1.follow` (or `find`) on every selected
   run with the same selected value. Qualify each returned stop/hit with its source run before
   merging; keep `path`, `name` and any lost-after indication local to the original run.
4. Label this mode a completed-run view. For live runs, refresh the complete selection and retain
   rows by qualified ID; say that newly finished HTTP responses may change time links and sorting.
   Separate reads cannot promise an atomic folder-wide snapshot.

## Proposed node snapshot API

The plugin/node follow-up can adopt this precise contract rather than implement unbounded scans:

`trace.v1.journey.open` input:

```json
{
  "project_id": "p",
  "run_ids": ["server-run", "worker-run", "sink-run"],
  "from_ts": "2026-10-20T09:00:00.000Z",
  "to_ts": "2026-10-20T09:10:00.000Z",
  "time_tolerance_ms": 1000
}
```

Only `project_id` and `run_ids` are required. Accept 1–32 unique IDs from that project's current
runs folder. Validate timestamps, increasing window, and tolerance. Freeze the event inventory
and derived links at open time with a per-run last complete timeline line/high-water sequence.
Skip a crash-cut JSONL tail, as the single-run reader does. The initial response is:

```json
{
  "snapshot_id": "opaque",
  "expires_at": "...",
  "clock_uncertainty_ms": null,
  "runs": [
    {
      "run_id": "server-run",
      "debug_session_id": "session-server",
      "high_water_step": "t0042",
      "state": "recording"
    }
  ],
  "entries": [],
  "links": [],
  "next": "opaque-page-cursor"
}
```

An entry is `{run_id, debug_session_id, step: TraceStep}`. A link is
`{from:{run_id,step_id}, to:{run_id,step_id}, reason, by_time, ambiguous}`; a trace group is
`{trace_id, members:[{run_id,step_id}]}`. Return trace groups separately as `groups`, bounded by
the same response ceiling. `by_time` is true for temporal/ambiguous guesses; evidence reasons do
not imply causality beyond their definitions. Page links/groups separately if they cannot fit
with entries; never silently drop them.

`trace.v1.journey.page` accepts `{project_id, snapshot_id, cursor, limit?}`; limit is 1–500,
default 200. Replies stay under the existing 192 KiB page ceiling. Cursors are opaque and scoped
to the snapshot, query and owner. Snapshot lifetime is 60 seconds. A refresh opens a new snapshot;
old cursors must not jump into the new ordering. Cap a snapshot at 20000 entries/16 MiB and the
cache at 4 snapshots/32 MiB per node. Refuse over-budget opens with `trace_journey_too_large`,
request a narrower selection/window, and never silently truncate a journey. Missing selected
runs fail the open as `trace_run_not_found`; expired/evicted snapshots return
`trace_journey_expired`. A deleted run's later value read may return `trace_run_not_found` even
if its immutable snapshot row is still visible.

A future snapshot-wide find/follow must use this same snapshot and return qualified stops,
paged under the same ceilings. Do not advertise the aggregate capability until these methods,
schemas, client parsing and bounded storage are implemented together.

## Acceptance gates for the aggregate implementation

Before implementation, add failing tests for interleaved server/worker/sink times with different
run starts; colliding `t0001`/`n1` IDs; equal-time stable ordering; propagated traceparent across
hops; repeated request IDs producing ambiguous candidates; unrelated sink sends; masked or
malformed IDs; destination/port mismatches; one order found in three original runs; live append
and late HTTP completion during pagination; expiry/deletion; oversized selection and page bounds.
Use fake/debuggee-local traffic and recorded fixtures, never real provider CLIs or test devices.
