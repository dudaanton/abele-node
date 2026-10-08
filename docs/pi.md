# Pi SDK provider

AbeleNode includes a supervised pi SDK provider alongside Claude Code and the
non-executing fake provider. It uses the same sessions, journal, durable input
queue, approval service and authenticated client API. There is no separate pi
control protocol or unauthenticated endpoint. Plugin provider selection depends
on the plugin version.

**Capability-gated:** `node.describe` and welcome reports list installed providers
and per-feature status. An available SDK is not proof of valid model credentials,
endpoint availability or acceptance of every extension. Check permission, resume,
compaction and extension-UI gates before relying on them. The pinned SDK's basic
allow/deny/expiry, interruption and exact-file resumed inference have bounded
real-provider acceptance. Extension UI and real compaction remain unverified;
steering, arbitrary TUI emulation and exhaustive native-child history are not
supported.

## Requirements and configuration

The provider has an exact `@earendil-works/pi-coding-agent@0.87.0` dependency. Model
configuration and authentication remain local to the SDK worker; keys, headers,
model request payloads and environment are not exported through the client API.

Set provider/model identifiers to match your own configured SDK provider, or omit
both to use the SDK's **user-only** default provider/model settings. Repository
settings cannot change that default selection. No model endpoint or credential is
bundled with AbeleNode.

```sh
node packages/node-daemon/dist/cli.js start \
  --pi-provider YOUR_PROVIDER --pi-model YOUR_MODEL --pi-profile isolated
```

Start/install options:

| Option                             | Default / behavior                                                         |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `--pi-provider`, `--pi-model`      | User-only SDK defaults when omitted; explicit identifiers override them    |
| `--pi-agent-dir`                   | SDK configuration directory for local authentication, models and resources |
| `--pi-profile inherited\|isolated` | `inherited`                                                                |
| `--pi-max-tokens`                  | 4096; range 64–32768                                                       |
| `--pi-deadline-ms`                 | 120000; range 1000–1800000                                                 |
| `--permission-ttl-ms`              | 60000; shared approval deadline                                            |

`inherited` uses `DefaultResourceLoader` for supported trusted skills, context and
extensions. A registered trusted project and ready, exclusively leased worktree
are required before project code loads. Runtime replacement cannot switch to a
different workspace. Trusted extensions run with the OS user's permissions and
are **not sandboxed**.

`isolated` disables discovered extensions, skills, templates, themes and context,
and supplies empty `SYSTEM.md`/`APPEND_SYSTEM.md` sources before discovery or
reading, including symlinks. The SDK's built-in coding instructions and local
model/authentication configuration remain. This profile does not bypass approval.
Unsupported custom UI emits `pi.capability.error` and fails rather than silently
approving.

## Client flow and prompts

Provision a trusted Git workspace before choosing pi:

```ts
const project = await client.registerProject(PROJECT_PATH, 'trusted')
const job = await client.createWorkspace(project.project_id)
// Wait until getJob(job.job_id).state === 'succeeded'.
const session = await client.createSession('Pi task', job.workspace_id, 'pi')
await client.subscribe(session.session_id)
await client.send(session.session_id, 'Your task', await client.cursor(session.session_id))
```

Provider selection uses the existing `session.create` method, receipt and client
outbox. Browser/client packages do not import the SDK or access its files directly.
The same flow works through local-token or paired access; see
[remote access](remote-access.md) for the separately enabled paired profile.

Every SDK tool, including reads and extension tools, requires one exact node grant.
Prompts bind session/run, revision, action digest, native session identity and expiry.
The first valid committed answer wins. Select/confirm/input/trust questions use the
same durable prompt service:

- Permission, confirm or trust: `client.answerPrompt(prompt, 'allow' | 'deny')`.
- Select: allow with a value from `prompt.options` as the third argument.
- Input: allow with human-entered text as the third argument, bounded to 32768 code units.
- Denial/cancellation: `client.answerPrompt(prompt, 'deny')`.

No argument editing, blanket always-allow or automatic approval is provided.
Resolution and single-use delivery consumption are separate committed facts;
delivery rechecks installation authority. Expiry, interruption, worker/IPC loss,
missing UI transport and unconfirmed delivery never grant permission. SDK dialog
cancellation invalidates its exact question; late answers are not retargeted.
Client disconnection alone does not stop a run or discard its pending prompt.

## Lifecycle, resume and process ownership

Each active session turn uses a supervised worker hosting SDK APIs directly, not
the pi CLI/RPC executable. Ordinary follow-ups remain in the node queue. Completion
requires session-level `waitForIdle()`, not low-level `agent_end`, so retries,
compaction and native continuations do not prematurely complete the input.
Swallowed extension-command and `session_shutdown` errors are included in the
final outcome **after disposal**, before the worker sends its terminal result.

Workers close at settlement to confirm descendant cleanup. Subsequent inputs reopen
the exact stored native JSONL file with `SessionManager.open`, never "continue
recent" by cwd. Before publishing a file mapping, the host materializes the exact
SDK header and pending entries, fsyncs file/directory and reloads using the public
SDK API while preserving the active leaf. Empty commands, preflight failures and
runtime replacement therefore do not publish a nonexistent file. No synthetic
assistant message or private SDK-field mutation is used.

Schema 10 records unique native mappings and updates session/catalog/journal facts
transactionally. Preserve the protected `pi-sessions` directory with node-state
backups. Missing native context fails explicitly instead of silently starting fresh.
Runtime replacement rebinds subscriptions and UI; native tool IDs reused in a new
context require a fresh grant.

Built-in bash uses the SDK's schemas, output accumulation, truncation and configured
shell/prefix with managed process operations. A detached **group anchor** is
registered and durably acknowledged before the shell starts inside its group. The
anchor outlives a fast-exiting shell, so reparented background jobs remain visible
by process-group ID rather than depending on descendant polling. The whole group
is reaped at command completion. The daemon independently checks absence and commits
recovery-record removal before acknowledging release. Storage/probe failures deny
admission or release and retain recovery obligations.

SDK workers and anchors independently clean owned groups on IPC loss. A hung SDK
abort cannot stall independent cleanup; unconfirmed probes retain anchors for
restart/operator recovery rather than abandoning live descendants on a timer.
This is **not an OS sandbox** or a guarantee against deliberate group escapes or
arbitrary trusted-extension subprocesses. See [security](security.md).

## Journal projection and bounds

- Project `pi.message.start/delta/final` by `(run_id, runtime_generation, message_id)`;
  final snapshots replace partials. Delta fields exclude cumulative SDK snapshots.
- Correlate `pi.tool.call/update/result` by `tool_use_id`, including parallel tools
  completing out of source order. Native child/run identifiers remain native
  evidence, not newly created node sessions or node-owned run IDs.
- Compaction changes provider context, never retained client/journal history.
- Preflight acceptance is SDK input-delivery evidence, not a successful pipe write.
  Completion is not human acceptance or proof every tool succeeded. Interrupted or
  uncertain inputs remain unknown and are never automatically replayed as shell work.
- Large normalized payloads use authorized artifacts; fetch before projection.
  Records, total output, outstanding bytes, process claims and questions are bounded.
- Model objects and raw error diagnostics are not journaled. Model selection exports
  only provider/model identifiers. Protected SDK-native files may retain diagnostics;
  avoid sharing them without review. Approved tools or trusted extensions can still
  disclose local files because they run as the OS user.

## Build and verification

```sh
npm ci --ignore-scripts
npm run build
npm run types
npm test
npm run format:check
npm audit
npm run acceptance:pi # fake SDK/CLI by default; no model requests
```

The SDK's published shrinkwrap can restore an older `brace-expansion` despite npm
root overrides. AbeleNode pins audited 5.0.12 and prepares that installed, non-native
module before compilation. Availability and tests check the **actual SDK resolver
on disk**, not only a clean-looking lockfile audit. Rebuild after dependency
installation; deployment must use the prepared resources. No native build or
third-party install script is required.

For Linux container verification, copy source into native container storage rather
than a host-shared filesystem. Supply a supplementary group for owner/group
preservation checks; a native temporary filesystem avoids container-layer fsync
latency distorting test deadlines. Do not skip metadata assertions or relax
process/protocol deadlines to accommodate a host filesystem's emulated ownership.

Automated tests use SDK-faithful doubles and synthetic processes: lazy native files,
system-prompt discovery, cumulative snapshots, swallowed command/shutdown errors,
parallel tools, retries/compaction/idle, approvals, runtime replacement, interruption,
separate-group cleanup after supervisor loss, and real adapter/SQLite admission and
release faults. Publication and cross-platform metadata checks remain strict.

Real-model acceptance is explicit and quota-consuming, never part of CI. Use only
disposable projects, a bounded turn budget and individually reviewed scratch actions.
Do not retry uncertain shell effects. Availability of a configured service and
real provider behavior must be verified separately from offline coverage.
