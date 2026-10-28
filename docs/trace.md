# Recorded runs (trace v1)

A **record point** is a debugger breakpoint plus a list of what to take there. When the program
stops on record points only, the node takes each value whole, writes a step to the run and lets
the program go on. A stop on any ordinary breakpoint stays a stop. There is no separate record
switch: a debugger session records a run whenever it has a record point.

Large timelines are indexed incrementally in an isolated reader thread. Page, value,
find and follow requests over those timelines do not parse the complete recording on
the node's main event loop. Recording uses asynchronous blob compression and writes;
closing a run drains accepted values and steps before writing its final metadata.
The on-disk run, JSONL and blob formats remain version 1.

Changing record-point configuration updates the active run's `run.json` points in
place, retaining its identity and earlier steps. Newly installed breakpoint ids
are correlated before their hits are published; unchanged source sets retain
their confirmed adapter ids. Unknown or mixed adapter hits stay ordinary stops.
Captures and automatic continuation are fenced by the stop, breakpoint revision,
and record-point configuration: a mutation cancels stale work and leaves the stop
available for explicit control.

This sits on the [gated debugger infrastructure](debugger-v1.md) and needs `--debugger`. While no
audited JS adapter pin exists (see [the JS profile](debugger-js-profile.md)), `debugger.v1.start`
refuses with `debugger_profile_unavailable`; the launch path and the recorder are exercised with a
scripted DAP adapter in `tests/trace/`.

## Starting a program

`debugger.v1.start({ operation_id, conversation_id, program, argv?, sources? })` is the owner's
act: it starts `program`, a path inside the chat's folder, with the node's own Node, the given
arguments, an empty environment and no shell. The folder must be one the node may run code in, the
same trust and execution grant a chat's agent needs. The program waits on its first line under the
debugger, so record points and breakpoints can be set before it goes on.

`sources` names further files of the folder that take breakpoints; the program is always one.
The answer gives the session the program's code runs in and a source id for each file (`s1` is
the program). js-debug attaches to the program in a child of the session it was asked for, so the
answer waits for that child and names it, not the parent. A line of a `.js`, `.mjs` or `.cjs` file
is the line Node runs. Any other source, TypeScript for instance, is taken only when a source map
under the program's own folder lists it and either carries its exact text (`sourcesContent`) or
was written no earlier than the source last changed; the adapter then maps its lines onto the
built JavaScript. A source without such a map is left out of the answer and takes no breakpoints;
the rest of the session is unaffected. Every session the adapter starts for the program is put under the
shared coordinator and records runs while it has record points. As js-debug names only the thread
that stopped, the node reads the full thread list whenever a thread starts or goes, so the session
reads as paused. The run of a session ends with its connection: when the program exits or is
stopped. A retried operation answers with the program already started.

## Attaching to a running program

A program already running with its inspector open on loopback (`node --inspect app.js`,
`--inspect-brk`, `--inspect-wait`) is attached to instead of started.

`debugger.v1.programs({ conversation_id })` lists the Node.js programs of the node's user whose
inspector listens on `127.0.0.1`, read from the OS without a shell: `lsof` and `ps` on macOS,
`/proc` on Linux. A port counts only when it answers as Node's inspector, so a program's own
server is not listed, and an inspector bound to any other address is never listed. The node's own
processes (its adapter, programs it started) are left out. Each entry gives the PID, the port, the
command line cut to a line, the working folder, the file it runs when the command line names one,
the registered project folder it runs from, and `in_chat_folder` when that is the chat's folder.

`debugger.v1.attachProgram({ operation_id, conversation_id, pid, port, sources?, outside_folder? })`
is the owner's act, under the same folder trust and execution grant as `start`. The node reads
the listeners again and refuses (`debugger_program_not_found`) unless that process holds that
port and it answers as an inspector. A program whose file and folder are both outside the chat's
folder needs `outside_folder: true`, the owner's explicit confirmation, or the call is refused
with `debugger_attach_outside_folder`. The answer has the shape of `start`'s: the program's own
file is `s1` when it lies in the chat's folder and passes admission, and `sources` adds files of that folder by the same
rules. Its lines take breakpoints only while the file is unchanged since the process started.

The session is `external`: stopping it is refused, and detaching (`debugger.v1.detach`) lets go
of the program, which runs on and waits for a debugger again. If the node shuts down while
attached, the program is let go the same way. Record points record runs as they do for a started
program. A retried operation answers with the session already attached.

## Adding files to a live session

An owner can admit files opened after starting or attaching:

`debugger.v1.addSources({ operation_id, debug_session_id, sources: string[] })`

The response is `{ incarnation, sources: [{ source_id, path }], refused: [{ path, code }] }`.
Detect support by looking for `debugger.v1.addSources` in the advertised debugger methods.
The request accepts at most 256 folder-relative paths; a run admits at most 256 files total.
Each admitted path is canonical and folder-relative. Symlink aliases return the same existing
source id, so admitting an already known path is idempotent. A refusal affects only that path.
Use the returned ids with the usual breakpoint and record-point methods.

Admission rechecks the session folder's trust and execution grant. Resolved symlinks must stay
inside that folder. JavaScript is admitted directly; other sources need the same source-map
proof under the program's folder as at startup. Attached programs additionally require each
file to be unchanged since the process started. Refusal codes are `debugger_source_no_map`,
`debugger_source_outside_folder`, `debugger_source_changed`, `debugger_source_unavailable`
(missing, unreadable or not a file), and `debugger_source_limit`. An unknown process start time
also refuses attached files as changed because their contents cannot be proven.

The returned incarnation identifies the live session. Inactive sessions refuse the call with
`debugger_session_inactive`; sessions without a retained launch configuration refuse with
`debugger_configuration_unavailable`. Added paths are retained in the restart recipe on disk:
`debugger.v1.restart` re-admits them through the current checks, including after a node restart.
Breakpoints restored on restart follow their file paths if source ids change; a file that no
longer passes admission does not receive restored breakpoints.

## Taking a value whole

An adapter cuts long strings and opens objects a level at a time, and one DAP frame is bounded
(1 MiB). So for each take the node:

1. evaluates a small serializer in the stopped frame that keeps what JSON loses (cycles as
   `[Circular]`, `Map`, `Set`, `Buffer`, typed arrays, `Date`, `Error`, class names as `@class`,
   `undefined`, functions, bigint) and stores the text under a one-off key on `globalThis`;
2. reads it back in 128 K-character chunks as base64, which no adapter quoting can alter, never
   splitting a surrogate pair;
3. deletes the key.

The evaluation context is `clipboard` where the adapter advertises it, `repl` otherwise. A value
over 64 M characters is refused. A take that throws is recorded with its reason and the program
still goes on. The stop's state is fenced after every evaluation: if someone else moves the
session meanwhile, the take fails rather than reading another frame.

A take is a name in scope or an expression, optionally `expression as name`. Only what the record
point names is taken: with no takes the step keeps its place and stack and no values. Getters on the value run during serialization, as they
would when the value is printed.

## Who may set what

All `trace.v1.*` methods are owner methods: they are answered for the connected installation and
are not exposed to node agents. Setting a record point (`trace.v1.points.set`) is the owner's
explicit act; the takes then run on every hit without further prompts. The breakpoint itself, and
its condition, still go through `debugger.v1.breakpoints.patch` with its usual approvals.

## Runs on disk

Runs are plain files in a folder per project, by default `<project>/.abele/runs`. The node writes
a `.gitignore` holding `*` into that folder so runs never appear as changes to commit. The owner
can choose another folder (`trace.v1.folder.set`, absolute or relative to the project; empty
returns to the default).

```
<runs folder>/<run id>/
  run.json          id, name, debug session, start, length, state, record points as set
  timeline.jsonl    one step per line, in time
  blobs/<sha256>    each value whole, by the hash of its content; over 64 KiB as <sha256>.gz
  marks.jsonl       marks: step, value, path, comment, tags
```

A value of 256 bytes or less is kept in its step. The same content taken twice is one file, which
is also how a step says a value is the same as the last time. A run is `recording` while it is
written, `done` when the program ended or was detached and `cut` when the connection was lost. A
line cut by a crash at the end of the timeline is skipped; everything before it stays readable. A
run being recorded cannot be deleted.

New run IDs and default names use local calendar components. `started_at` remains an ISO
instant; existing IDs and folders are never renamed. Removing the final record point (including
converting it to a normal breakpoint) clears `trace.v1.status.recording` immediately. Queued
captures finish before closing the run. A run with no steps is discarded at that point or at
session end; nonempty runs are retained.

## HTTP from the debugged Node program

While record points are set, the recorder installs bounded instrumentation through the existing
DAP session's global `evaluate` operation. No additional inspector port, package in the program,
or `--experimental-network-inspection` restart is required. Each connected process is observed
independently. Node's diagnostics channels identify incoming HTTP/HTTPS server requests and
outgoing `http`/`https` and Undici requests. Stream taps observe application reads and writes
without putting streams into flowing mode. A bounded clone captures `fetch` responses, including
on Node versions whose bundled Undici does not publish response chunks.

The existing `trace.v1.run` filter `kind: ["http"]` includes these requests. No method or new
screen is required. Two optional fields were added to `TraceStep`: `direction` (`incoming` or
`outgoing`) and `duration_ms` (nonnegative milliseconds). Clients validating steps with an older
strict schema must refresh that schema. Existing `status`, `host`, `chain`, and `by_time` fields
keep their meaning. Program requests do not set `sent`, which is reserved for saved requests.

Selecting a debugger session for a saved request is a proposed association, not proof that the
destination belongs to that process. Before persisting its saved-send summary, the node flushes
that session's program HTTP capture and requires incoming evidence with the same method and
URL in the send interval (a unique candidate), or the matching explicit `X-Abele-Step` header.
Unconfirmed sends remain in request history, but do not create recording steps and their final
send status has no `run` association. Confirmed summaries have `sent: true, direction: "incoming"`;
the program's own incoming observation remains a separate step. No extra marker header is sent
unless the caller requested `step_header`. Unsupported capture or ambiguous/masked URL matching
may omit the saved summary; it must never claim traffic from a different process.

The probe's proposed saved-request chain is frozen when its stop is observed, before capture or
Continue can race with the response. Run views remove chains whose HTTP parent was not confirmed,
or re-associate them with observed incoming traffic by time. See the
[folder journey contract](trace-journey-contract.md) for a combined view across sessions.

Each program HTTP step contains these ordinary recorded values:

- `request`: JSON `{method, url, headers, body, truncated}`, with headers as a string dictionary.
- `response`: the observed response body as text.
- `http`: JSON `{direction, started_at, duration_ms, headers, truncated, error?}`; `headers` are
  response headers, and `error` describes a failure, timeout, or interrupted capture.

Each body is capped at 32 KiB of UTF-8, each header set at 16 KiB and 128 headers. Header names
are capped at 256 bytes and values at 4 KiB. Authorization, proxy authorization, cookies,
set-cookie, and API-key header values use the existing `••••` mask before leaving the program;
known header secrets echoed elsewhere are masked too. URL credentials are removed and sensitive
query parameters are masked. The program keeps at most 64 active captures and 128 completed
requests; excess captures are dropped. Requests exceeding 60 seconds are finalized as partial
when polled. Drains carry one request per DAP response to stay below its frame ceiling, and
recorded-value paging keeps the existing panel/channel bounds.

Handler steps link to requests whose time intervals contain the step. Incoming requests take
precedence over outgoing requests, and the newest overlapping request wins; existing saved-send
links are retained. `by_time: true` explicitly denotes temporal association, not proof of causal
ownership under concurrent traffic. Links are also derived when reading a run, so a response
that finishes after the handler step still groups that step. The raw timeline is append-only.

Hooks and polling are removed on recording end; buffered/unfinished captures are flushed before
the empty-run check. A normal debugger detach also removes hooks before disconnecting. If the
transport disappears, an unreferenced lease timer removes hooks from a surviving program after
10 seconds without a poll. A hard process exit or abrupt transport loss can lose undrained HTTP
events. Capture starts after the instrumentation evaluation completes, so earlier traffic is
not recovered. HTTP/2, WebSockets, arbitrary custom transports, unread application streams, and
multipart fetch uploads are not guaranteed complete. Binary data is a
bounded UTF-8 preview. Direct Undici chunk capture depends on the client's diagnostics support.

## Methods

| Method                                | What it answers                                                    |
| ------------------------------------- | ------------------------------------------------------------------ |
| `trace.v1.points.list` / `points.set` | record points of a debugger session                                |
| `trace.v1.status`                     | the run being recorded in a session, and the runs folder           |
| `trace.v1.folder.get` / `folder.set`  | a project's runs folder                                            |
| `trace.v1.runs`                       | the runs of a project, newest first                                |
| `trace.v1.run`                        | one run: record points with hits, steps in pages, marks            |
| `trace.v1.value`                      | a value's `shape`, a `page` of it, a `slice` by path, or `changes` |
| `trace.v1.find` / `follow`            | where a value or key occurs; the trail of one value through a run  |
| `trace.v1.mark` / `rename` / `delete` | owner edits                                                        |

Run pages stop under 192 KiB. A value view stops at 200 lines or 16 KiB (`cap: "panel"`) or at
80 lines or 6 KiB (`cap: "agent"`); the caller can ask for less, never more, and a cut page says
where to go on. Paths are `$.items[3].id`, `$.items[*].amount`, `$["odd key"]`; XML and text are
sliced by lines, `L10-L40`. Shape, diff and leaves are worked out for values up to 32 MiB and
cached by content hash. Failures are channel errors such as `trace_run_not_found`,
`trace_step_not_found`, `trace_value_not_found`, `trace_path_not_found` and `trace_run_recording`.

The capability `trace_v1` is advertised only where the debugger is enabled.

## Not here yet

Recording without stopping the program, browser requests over the DevTools protocol or from a HAR
file, canvas and comparing runs are later stages. A [saved request](http.md) can be
sent into the run being recorded: it heads the steps taken while it was out, linked by time.
