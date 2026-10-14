# Recorded runs (trace v1)

A **record point** is a debugger breakpoint plus a list of what to take there. When the program
stops on record points only, the node takes each value whole, writes a step to the run and lets
the program go on. A stop on any ordinary breakpoint stays a stop. There is no separate record
switch: a debugger session records a run whenever it has a record point.

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
file, masking of headers, suggested links between steps, canvas, comparing runs and HTTP-client
launches on the same timeline are later stages.
