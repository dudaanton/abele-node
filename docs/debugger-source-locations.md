# Executable source locations and session metadata

These APIs are owner-authorized reads under `debugger_v1`. Existing snapshot and
source-admission response schemas remain unchanged. The typed debugger client exposes
helpers with the same method names.

## Source eligibility and executable lines

`addSources` proves folder confinement and source/build identity. It does not prove that
every line is executable or that a module has loaded. Declaration files (`.d.ts`, `.d.mts`,
`.d.cts`) are refused with `debugger_source_declaration`.

Detect `debugger_v1.source_breakable_lines` and call
`debugger.v1.sourceStatus({debug_session_id, source_id, line, end_line})`. The source must
already be admitted. The inclusive range spans at most 1001 lines.

Wire replies retain the existing inspection envelope `{data, truncated, snapshot}`. The typed
client helpers unwrap `data`, the location page described below:

- `loaded`: true/false from the adapter's loaded-source inventory, or null when unavailable.
- `known`: whether the executable-location result is known for this range.
- `items`: adapter-reported `{line, column?, end_line?, end_column?}` locations.
- `truncated`: true when the bounded page does not include all locations.
- `snapshot`: the fenced session observation for this result.

An unloaded source returns `loaded:false`, `known:true`, and no executable locations.
An adapter without location/inventory support returns unknown information rather than
invented margin positions. An interface-only source may be admitted for mapping but have
no executable locations. Refresh after module loading; neither an empty unknown page nor a
truncated page proves the remaining lines non-executable. Pages contain at most 256 locations
and retain the existing inspection byte limit.

## Inline breakpoints

Detect `debugger_v1.breakpoint_locations`, then call
`debugger.v1.breakpointLocations({debug_session_id, source_id, line, end_line, column?, end_column?})`.
It returns the same location page without `loaded` and `known`. The adapter must advertise
`supportsBreakpointLocationsRequest`; otherwise the operation is unsupported. Choose only
reported inline columns and submit them through the existing breakpoint-patch API. An omitted
column is a line location, not evidence for an invented inline column.

## Pause reasons and start time

`debugger_v1.step_stop_reason` indicates that a step completion and its new stop epoch carry
the new `step` reason and description together. Exception stops and reported breakpoint hits
keep their actual reasons; they are not overwritten merely because a step was pending.

Detect `debugger_v1.session_started_at`, then call
`debugger.v1.sessionInfo({debug_session_id})`. It returns `{started_at: ISO timestamp | null}`.
The timestamp is created once with the debug session and retained across node restarts.
Old sessions without retained creation metadata return null; `observed_at` is never used as
a substitute start time. The existing strict snapshot schema is unchanged.
