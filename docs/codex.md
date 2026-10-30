# Codex provider

Codex execution is available on macOS after the node's doctor checks succeed.
The node automatically finds a supported Codex installation and uses Codex's own
model selection: the user's `config.toml` model, or Codex's built-in default. It
passes no model override unless you configure one. It reuses your existing Codex login
(subscription or API key), like Claude Code; there is no separate node login when
Codex is already logged in for the daemon's OS user. Until these checks succeed, creating a
session with `provider: "codex"` returns `provider_unavailable`; the node does not
fall back to another provider. Codex execution on Linux and Windows is unavailable.

## Detection

Discovery accepts stable Codex **>=0.160.1** within major version 0.
Protocol preflight accepts the reviewed 0.160.1 and 0.162.1 schema closures;
newer versions must reproduce both closures of one reviewed protocol and pass
the initialization, effective-policy and model probes. Native execution gates
are version-specific: 0.160.1 and 0.162.1 are enabled on their own native
proofs; any other version (including 0.163.0, whose protocol is not yet reviewed)
stays disabled until its own proofs are collected. Doctor/status identify the found version and blocking gate. The node checks
version/help output, fingerprints the canonical executable, and verifies the
app-server protocol schemas. It never installs or upgrades Codex automatically.
Official npm installations are resolved to their bundled/platform native executable
without executing the JavaScript launcher. Other opaque launchers are rejected.
Codex runs its tools through a helper, `codex-code-mode-host`, which it looks for
beside its own executable. An installation without it is refused
(`codex_code_mode_host_missing`): otherwise every tool call would fail inside the
turn while the model still answered as if it had worked.

- `--codex-path /absolute/codex` selects the executable explicitly.
- `ABELE_CODEX_PATH` supplies the executable when `--codex-path` is omitted.
- Discovery is automatic: the owner login shell (`$SHELL -lc`, including npm global
  and Homebrew PATH setup), `~/.local/bin/codex`, `~/.codex/local/codex`,
  `/opt/homebrew/bin/codex`, `/usr/local/bin/codex`, then absolute entries in the
  daemon's trusted `PATH`, plus Codex beside the Node executable. Relative entries
  are ignored; startup does not search a session's workspace. Incompatible auto-discovered
  candidates are skipped; an explicit executable never silently falls back.
- `--no-codex` disables discovery/preflight/execution, even with an executable set.
  `--codex` remains accepted for compatibility and can re-enable installer setup.
- `--codex-model MODEL_ID` or `ABELE_CODEX_MODEL` overrides Codex's own selection.
  With no configured override, thread/start, thread/resume and turn/start omit
  the model parameter. Doctor/status report the model exposed by `config/read`
  or the default in `model/list`; otherwise they show `Codex default`.
  The account's non-hidden catalog must offer any exposed/explicit model with low
  reasoning effort. When doctor cannot determine the default, execution checks
  the actual model returned at thread creation before sending user input.
  Missing models cause refusal, never silent model substitution or inference.

The shell installer records its discovered executable, model, optional home and
opt-out in its wrapper/service/config and preserves those selections on upgrade.
Only the first-party model provider is supported, and unexpected provider
definitions are refused.

## Administrator prerequisite

An administrator must configure the remote-control ban in
`/etc/codex/requirements.toml`. A file under `CODEX_HOME` is not an equivalent
managed requirement. Review existing administrator requirements before editing;
do not replace other restrictions.

```sh
sudo install -d -o root -m 0755 /etc/codex
sudoedit /etc/codex/requirements.toml
```

The file must include:

```toml
allow_remote_control = false
```

The file and containing directory must be regular/non-symlink, root-owned, and
not group/other-writable. Typically:

```sh
sudo chown root /etc/codex /etc/codex/requirements.toml
sudo chmod 0755 /etc/codex
sudo chmod 0644 /etc/codex/requirements.toml
```

Root-owned platform aliases such as macOS's `/etc` are checked through both
lexical and physical administrator-owned ancestry. Effective requirements must
also report the ban as false. Missing, unset, true or unsafe policy is refused.

## Use your existing login (default)

The node uses CODEX_HOME from the daemon environment when set, otherwise
`~/.codex` of the OS user running the daemon. It preserves the user's `HOME` and
Codex credential-store selection, including an existing system credential-store
login. It never rewrites your `config.toml` or copies your credentials into node
state. Run the node as the same OS user you normally use for Codex.

The simple subscription path is just:

```sh
abele-node doctor
abele-node start
```

No executable/model flags or second login are needed if Codex is installed,
already logged in and administrator policy is configured. To override the defaults,
use these options. `--state-dir` can be omitted to use
`$HOME/.local/state/abele-node`; it does not select the Codex home:

```sh
STATE_DIR=/absolute/node-state
CODEX_BIN=/absolute/codex
MODEL_ID=YOUR_MODEL_ID

abele-node doctor --state-dir "$STATE_DIR" \
  --codex-path "$CODEX_BIN" --codex-model "$MODEL_ID"
abele-node start --state-dir "$STATE_DIR" \
  --codex-path "$CODEX_BIN" --codex-model "$MODEL_ID"
```

If Codex is already logged in, no additional login is needed. Doctor prints the
selected home and login status. If not logged in, it prints the login command for
that home, for example `codex login --device-auth`. Follow Codex's displayed
instructions, then run doctor again. Resolve other configuration errors before
login; an unchecked login status is not the same as being logged out.

A service uses its own environment, not your terminal's shell startup files. If
using a custom `CODEX_HOME`, set it in the service environment too. The macOS CLI
`install` command records the current `CODEX_HOME` in its LaunchAgent. Stop a
running node before restarting with new options. For installed services, persist
the executable/model options in their configuration; see [installation](install.md).

## Optional isolated node home

For a separate node-owned login, select `--codex-home /absolute/directory` or set
`ABELE_CODEX_HOME` in the daemon environment. The flag takes precedence over
`ABELE_CODEX_HOME`; both take precedence over the inherited `CODEX_HOME`. This
option is useful for separately configured machines and container deployments;
see [Docker deployment](docker.md) for the current platform limit.

```sh
CODEX_DIR="$STATE_DIR/codex"
abele-node doctor --state-dir "$STATE_DIR" \
  --codex-home "$CODEX_DIR" --codex-path "$CODEX_BIN" --codex-model "$MODEL_ID"
```

Doctor prepares the isolated home after executable and administrator checks pass.
The home, SQLite and log directories must remain private and canonical;
credential/config symlinks, non-private files and wrong ownership are refused.
Use either your ChatGPT subscription or an API key supported by Codex. Subscription
login:

```sh
CODEX_HOME="$CODEX_DIR" "$CODEX_BIN" \
  -c 'cli_auth_credentials_store="file"' login --device-auth
```

For API-key authentication, supply `OPENAI_API_KEY` to the daemon environment, or
use Codex's own API-key login. With the key already set in your shell:

```sh
printf '%s' "$OPENAI_API_KEY" | CODEX_HOME="$CODEX_DIR" "$CODEX_BIN" \
  -c 'cli_auth_credentials_store="file"' login --with-api-key
```

Do not put a key value in command arguments, tracked files or service definitions.
The isolated option uses file-based credential storage per launch. The daemon
passes `OPENAI_API_KEY` only to isolated Codex app-servers; tool shells still use
the restricted environment policy. Existing API-key logins in an inherited home
are also accepted. No launch forces a subscription-only authentication method.

Use the same home selection for doctor and start:

```sh
abele-node doctor --state-dir "$STATE_DIR" \
  --codex-home "$CODEX_DIR" --codex-path "$CODEX_BIN" --codex-model "$MODEL_ID"
abele-node start --state-dir "$STATE_DIR" \
  --codex-home "$CODEX_DIR" --codex-path "$CODEX_BIN" --codex-model "$MODEL_ID"
```

With a running daemon, `abele-node doctor` rechecks that daemon's configured
selection in its own environment and updates its availability. After logging in,
run doctor again; no restart is needed. To diagnose alternate executable/model
options, stop the daemon first or persist the new options through the installer.

Doctor checks the stdio handshake, schemas, effective configuration, managed
requirements, authentication type, and exposed/explicit model availability with low
reasoning effort. It creates no thread or model turn. Startup uses these same
checks, and they are reapplied before each production turn. Doctor does not return
authentication payloads or unrestricted diagnostics. Human-readable output is
the default; add `--json` for scripts.

## Default configuration and permissions

The node applies its defaults on every app-server launch through `-c` overrides,
not by changing user configuration files. History persistence is disabled per
launch; native thread/resume files remain available for recorded session resume.
Telemetry and analytics are off by default. Feedback, prompt/response logging,
update checks, apps, plugins, hooks, memories and native multi-agent features are
off by default. Remote features, including remote control, are off by default.
Web search, tool-network access, shell environment inheritance and login shells
are off by default. The worker environment is allowlisted, and no Codex network
listener is requested.

Each active run or live owner chat has one supervised stdio app-server. Its permission profile
grants writes to the canonical workspace and minimum runtime reads, with explicit
denials for node state, sibling workspaces, host-temp locations and protected Git
and policy paths. Bound developer profiles add a private tool home/cache area and
the narrow Git commit paths described below. The filesystem root itself is denied,
so escalation keeps this same profile on 0.160.1 and 0.162.1 alike. (From 0.161.0, Codex would otherwise let an
approved command write anywhere that is not explicitly denied; 0.160.1 never did.)
Unbound diagnostic/probe profiles keep Git metadata read-only or denied. Bound
developer profiles allow status/diff and committing the worktree's own branch,
while keeping repository configuration, hooks and other refs read-only and other
worktree metadata denied.
Effective values are checked before user input. Project or
managed configuration that adds roots/resources or changes checked values causes
refusal, not silent permission broadening. Only explicit node RPC methods are
available; Codex endpoints are never exposed to the plugin.

## Approvals and questions

The native `on-request` policy runs workspace-contained operations without
per-action prompts. The node therefore blocks Ask (`manual`) before launch rather
than treating it as bypass. Running requires an explicit `bypassPermissions`
choice and the operator's shared `--claude-allow-bypass` opt-in. Native command
and patch approval requests still use exact, durable single-action decisions. Only
single-action `accept`, `decline` and cancellation are supported. Session-wide
grants, rule amendments, grant roots, permission-expansion requests and requests
with missing or inconsistent action evidence are denied. This is not pi's
every-tool approval gate.

Clients can detect this mode in the Codex provider's `configuration` returned by
`node.describe`: `approval_mode: "on-request"`, `per_action_approval: false`, and
`workspace_actions_without_approval: true`. These additive fields are present even
when the provider is unavailable. For the actual session/delegation mode and
whether it can run, read its persisted `tool_permissions` snapshot through the
[`tool.permissions.v1` contract](tool-permissions.md). Show unsupported Ask
explicitly; never change it automatically to bypass.

Questions preserve option descriptions and free-text answers, with one durable
prompt per bounded question. Rejection, expiry or interruption cancels the
interaction; no default answer is selected. Prompt delivery records authorization
to dispatch, not proof that an operation executed.

Delegated children use node-owned isolated workspaces and explicit provider
grants. Existing grants and default grant lists do not automatically acquire
Codex authority; see [delegation](delegation.md).

## Developer tool environment

Detect `codex.developer-environment.v1` in node capabilities. Node-launched Codex
developers receive node/npm from the node service's installation and the system
Git toolchain on an explicit PATH; shell startup files and ambient credentials
are not inherited. If npm is missing from that Node installation, startup fails
with `codex_node_toolchain_unavailable` before launching the developer.

The bound worktree can run its package tests and `git status`, `git diff`, staging
and commits. The common Git directory is readable; only the shared object store,
this worktree's index/HEAD/commit message/reflog and the branch bound at startup
(including its locks and reflog) are writable. Other worktree metadata and other
branch refs remain protected. Shared objects are necessary for a normal Git
commit; this is not a separate object database. Creating arbitrary branches,
changing repository configuration and rewriting other refs are not granted.

HOME, TMPDIR, XDG/npm caches and Python bytecode caches use a private directory
under node state, scoped by workspace identity, outside the checkout. This is a
tool home, separate from the authenticated Codex home. Tools creating
`~/Library/Caches` no longer leave those files in the worktree.

Network remains **off by default**. The owner can explicitly opt a trusted project
in with `project.codex_permissions { project_id, network_enabled: true }`, or
`NodeClient.setProjectCodexPermissions(project_id, true)`. `Project.codex_network_enabled`
persists and is returned to clients. Use this only when dependency installation
or project tests need network; set it false again when it is unnecessary. The
setting cannot change while project execution is active. It authorizes network
for that project's Codex process, not only npm. Existing thread bindings pin this
policy: create a new Codex session after changing network or upgrading the tool
environment instead of weakening a thread's recorded binding.

A new worktree does not inherit another checkout's `node_modules`. When a Node
manifest declares dependencies and they are absent, the node emits a startup
warning before model work: either install them first (owner/another authorized
provider), or explicitly enable project network and let the developer install.
No automatic dependency installation or implicit network grant occurs.

## Owner chats are live sessions

An owner chat keeps one app-server and its Codex thread for as long as it is in use,
like a Claude chat. Delegated work keeps one bounded process per message.

- A message written while Codex works is steered into the running turn. Between turns
  it starts the next one; messages that queued up meanwhile go into that turn together.
- A turn has no deadline. Stop interrupts the current turn and keeps the process.
- `/compact` (or the compact button) asks Codex to compact the thread. Automatic
  compaction inside a turn is reported the same way, and the context meter follows
  Codex's token usage.
- The session's `/` commands are `/compact` plus every enabled Codex skill;
  `/<skill> text` runs that skill with the rest as its input.
- Effort can be low, medium, high or xhigh. The model is fixed per thread, and there
  is one permission mode: workspace operations run without prompts and everything
  else asks, as described below.
- When the node stops, the process stops with it. The next message starts a new
  app-server that resumes the recorded thread; a turn that was running is reported
  as interrupted.
- An idle process with nobody watching ends after the node's idle time, like Claude's.

## Resume and interruption

The node records the thread ID, workspace identity, policy fingerprint and model
before dispatching user input. The binding records Codex's actual model, not the
`Codex default` display label; a different model on resume is refused even when
no override is configured. Resume uses only the recorded thread ID; missing
context is an explicit error. There is no latest-thread lookup, caller-supplied
rollout path, automatic uncertain-input retry or approval replay.

Interruption cancels prompts, requests native interruption when possible and
reaps the process. Unconfirmed cleanup keeps `done` unsettled and workspace
ownership retained. A transient cleanup failure opens a durable `session.error`
record and schedules up to three automatic retries with bounded backoff. The turn
deadline remains armed until cleanup succeeds. Exhausted retries retain ownership
and report an explicit error rather than silently releasing the workspace.

## Workspace-local temporary files

Before the app-server starts, the node creates and validates a canonical, private
`<workspace>/.abele-tmp` directory. `TMPDIR` points there, giving temp-aware tools a
writable path inside the Codex sandbox. Symlinked temp/ignore paths, tracked temp
contents and unexpected existing ignore metadata are refused.

The directory contains a self-ignoring `.gitignore`; it and all temp contents stay
out of ordinary Git status without changing tracked project files or shared Git
metadata. These runtime files are never committed by the node. Tools should use
`TMPDIR` or an explicit temp template/path; BSD `mktemp` without options can choose
the system temp directory rather than the supplied `TMPDIR`.

Claude and pi retain their existing system-temp environment; Codex's workspace
preparation does not change their temp/IPC behavior.

## Process ownership and cleanup limits

The supervisor samples the native process's descendants during a turn and again
at cleanup. Each run also gets a random environment marker inherited by its
native process and tool shells. Cleanup checks the current user's readable process
environments for that exact marker. Only matching process identities are retained;
environment contents are not returned or journaled. Private per-run scope files
support the same sweep after restart.

Live samples retire exited child identities, including a child PID already reused
by an unrelated process. A replacement is tracked only with fresh descendant or
marker evidence. The app-server's own birth identity and all pre-signal identity
checks remain fenced. Inventory updates persist removals and group changes together;
a failed probe leaves the previous inventory intact.

The 500 ms sampler tolerates two consecutive unavailable probes and resets this
budget after a successful sample. A third consecutive unavailable probe ends the
transport with `codex_process_inventory_unavailable:<original error>`. Changed root
identity or persistence failures still end it immediately, retaining their cause.
Cleanup confirmation remains mandatory; unavailable inventory never proves absence.

This is sampled process ownership, not exhaustive kernel containment. A process
that removes its marker and detaches or reparents before a sample can escape the
inventory. Protected or unreadable environments cannot supply sweep evidence.
The marker is not an authorization credential. Known identities are rechecked
before signals; unconfirmed cleanup retains ownership and remains an error.
