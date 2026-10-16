# Long-lived Claude sessions

An owner chat with the Claude provider keeps **one Claude Code process for the whole
session** when the installed CLI supports streamed input (`--input-format stream-json`,
`--replay-user-messages`, `--allow-dangerously-skip-permissions`). Messages are written
into that process as they arrive, also while a turn is running. Background shell
commands, monitors, background subagents and session crons keep running between turns,
and when one of them finishes the CLI starts a turn by itself. The node streams such a
turn like any other.

Delegated work (a plugin agent driving a child session) and CLIs without streamed input
keep the bounded mode: one process per message, with the daemon's budget and deadline.
`session.state` says which mode a chat uses (`live`).

## Turns

A turn is read from the stream, not assumed from a request:

- `turn.started { run_id, turn_id, trigger }`: `trigger` is `input`, `task` (a background
  task finished), `command` (a cron or a message from another session), `compact` or
  `unknown`.
- `turn.completed { run_id, turn_id, outcome, input_ids, subtype, num_turns, duration_ms,
total_cost_usd, terminal_reason }`: `outcome` is `success`, `failed` or `interrupted`.
  `input_ids` are the inputs this turn consumed; it can be empty (a turn started by a
  background task) or hold several (a message written during a turn is taken at the next
  tool boundary, so one turn may answer both).

Inputs move `queued` → `dispatching` (written into the process) → `delivered` (the CLI
echoed it back as it took it) → `completed`, `failed` or `interrupted` with the turn that
consumed them. If the process ends with an input in flight, that input becomes
`delivery_unknown`; it is not replayed.

The process itself is reported as `session.process { run_id, state: starting | running |
exited, resumed?, native_session_id?, reason?, exit_code?, lost_tasks? }`. `run_id` names
one process; it is the value `session.interrupt` takes. Long-lived chats do not emit
`run.started`/`run.completed`.

Other events journaled as they arrive: the usual `claude.message.final`, `claude.tool.*`,
`claude.block.*` records; `claude.task` (task started, updated, progress, notification);
`claude.status` (including permission mode changes); `claude.rate_limit`.

## State and background work

`session.state { session_id }` returns `{ live, process: none | starting | idle | running |
stopping, run_id, turn, background_tasks, context, compacting, settings, process_settings,
restart_pending, watchers, idle_since }`. `session.tasks { run_id, tasks }` is appended
whenever the list of background tasks changes.

## Stopping

- `session.interrupt { session_id, run_id }` stops the current turn and keeps the process
  (a control request to the CLI). Pending permission questions of that process are
  invalidated. The turn ends with `outcome: interrupted`.
- `session.stop { session_id }` ends the process and everything it started. Queued
  messages are cancelled first so nothing restarts it. The next message starts a new
  process that resumes the same Claude session (`--resume`), with the same MCP
  configuration.

Both are always available, from any paired device.

A running process holds its chat's execution target. `session.detach` refuses while it
runs; stop the session first. A target switch waits until the process is idle with nothing
running, then the node ends it and the next message starts in the new target.

## Settings

`session.create` accepts `settings`, and `session.configure { session_id, settings }`
changes them later:

| Setting                     | Values                                                                                                    | Applied                                                                                           |
| --------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `model`                     | a Claude model name or alias                                                                              | at once, in the running process                                                                   |
| `permission_mode`           | `manual`, `acceptEdits`, `auto`, `plan`, `dontAsk`; `bypassPermissions` only with `--claude-allow-bypass` | at once; if the CLI refuses, the process is ended                                                 |
| `effort`                    | `low`, `medium`, `high`, `xhigh`, `max`                                                                   | restarts the process once it is idle with no background work                                      |
| `account`                   | `default` or a name the node offers                                                                       | same as effort; the session's transcript is copied to the other configuration so it resumes there |
| `continue_after_compaction` | boolean, default true                                                                                     | next compaction                                                                                   |
| `continuation_text`         | text written after a requested compaction                                                                 | next compaction                                                                                   |
| `messaging`                 | boolean, default true                                                                                     | calls at once; the tools are offered from the next process on                                     |

The node's capabilities (`configuration` of the Claude provider) list `accounts`,
`efforts`, `permission_modes`, `session_defaults` and `session_permission_ttl_ms`.
Accounts are configuration directory names chosen by the operator
(`--claude-account NAME=CONFIG_DIR`); clients see names only.

Sessions load user settings only. A project's own `CLAUDE.md` and `.claude/` settings load
after the owner turns on repository settings for that project (`project.claude_permissions`),
which also lets the repository's allow rules authorize tools.

Owner sessions have no spending limit and no deadline. Permission questions arrive as
the CLI's own stdio requests and wait `--claude-session-permission-ttl-ms` (30 minutes by
default) before they are denied. Every tool call, its input and its result are journaled
whether it was asked about or not, including in bypass mode.

## Compaction and the context meter

`session.compact { session_id, focus?, continue? }` queues `/compact <focus>` like a
message and returns `{ input_id, accepted_seq }`. A typed `/compact` works the same way.
The node journals:

- `compaction.started { run_id }`;
- `compaction.completed { run_id, result, trigger, pre_tokens, post_tokens, duration_ms,
error }` (also for automatic compaction, `trigger: auto`);
- `compaction.summary { run_id, text }` (large summaries are artifacts).

After a compaction someone asked for, and when `continue` (or the session's
`continue_after_compaction`) is true, the node queues the continuation text as the next
message of the same owner. The input is marked `continuation: true` in `input.accepted`.

`session.context { run_id, total_tokens, max_tokens, percentage, auto_compact_threshold,
auto_compact_enabled, model, categories }` is appended after every turn and every
compaction.

## Idle processes

A process is ended by the node only when it is idle, has no background task, cron,
scheduled wake-up, queued input or open question, and either:

- nobody has followed its stream for `--claude-idle-ms` (30 minutes by default, `0` never);
- its effort or account changed, or its chat was moved to another target;
- more than `--claude-max-live` processes (12 by default) are needed, or another chat needs
  its target, and it is the longest idle.

A session with background work is never ended by this policy. Ending it only costs a
restart with `--resume` on the next message. The node also ends a process when its chat is
deleted or the authority of a device with input in it is revoked.

A process that fails to start or dies within 30 seconds is not restarted at once; the wait
doubles from 5 seconds up to 10 minutes.

## Node restarts and updates

Each long-lived process runs under a small host process of its own, in its own process
group, with no channel to the daemon that started it. When the node stops (a restart, a
service restart, `abele-node update`) it leaves these processes running. The next node
takes them over on start:

- What the process wrote while no node was reading is kept by its host and journaled by the
  next node from the position the last one stopped at, once. A running turn, background
  tasks, monitors and crons go on undisturbed; the turn ends in the journal as it ends in
  the process.
- A permission question that was open is asked again.
- Inputs that were written into the process keep their state; the queue goes on.
- The journal says `session.process { state: running, reattached: true }`.

If the process died while no node was running, the session shows `session.process {
state: exited }` (`reason: process_lost` when nothing of it was left), in-flight inputs
become `delivery_unknown`, and the next message resumes it with `--resume`.

Without a node a process keeps running for `--claude-detached-ms` (10 minutes by default),
then its host ends it. `0` ends every session together with the node, as before. Live
sessions do not block `abele-node update`; the report lists them as `kept_sessions`.

On Linux the service unit needs `KillMode=process` (the installer writes it), or systemd
ends the sessions together with the daemon. A node that adopts a process checks that its
run directory is private and owned by the node's user, and that the installation that
started it may still run it in a trusted project; otherwise the process is ended.

## Messages between sessions

Owner sessions get two agent tools from the node (on the same MCP server as the node's
other tools):

- `node_sessions { all? }` lists the owner's chats on this node: `session_id`, `title`,
  `project`, `process` (`none`, `starting`, `idle`, `running`, `stopping`),
  `waiting_for_owner` (a permission question is open), `messaging`, `self`. Without `all`,
  only chats with a running process.
- `node_session_send { session_id, text }` queues `text` as a message to that chat and
  returns `{ input_id, session_id, title, state: queued, process }`. A chat with no process
  is started. Refusals come back as `{ code }`: `messaging_off`, `invalid_target` (itself),
  `not_found`, `target_busy` (16 messages from other chats already wait there),
  `target_more_permissive` (the target's permission mode lets more run without asking than the
  sender's: `plan`, `dontAsk` < `manual` < `acceptEdits` < `auto` < `bypassPermissions`),
  or an admission code. The text cannot close or open a `session-message` block.

The receiver's journal has `input.accepted { input_id, text, from_session: { session_id,
title } }`; the process reads the text inside a `<session-message from_session_id=…
from_title=…>` block with a note that it comes from another session, not from the owner.
The sender's journal has `session.message.sent { input_id, to_session_id, to_title, text }`.

The grant is the session setting `messaging` (on by default). Both sides need it: a session
with messaging off neither gets the tools nor receives messages. Delegated work never has
the tools and cannot be written to. The message runs with the authority of the
installation that started the sender, checked again when it is admitted.

The messages go through the node, not the CLI's own peer messaging, so they are in both
journals and visible from every device, they reach a chat whose process is not running or
was restarted, and the sender is named by the node rather than by the model.
