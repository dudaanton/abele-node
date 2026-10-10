# Codex provider

Codex execution is available on macOS after the node's doctor checks succeed.
Install the supported native executable, authenticate in the node's own Codex
home, and select an available model. Until these checks succeed, creating a
session with `provider: "codex"` returns `provider_unavailable`; the node does not
fall back to another provider. Codex execution on Linux and Windows is unavailable.

## Detection

Only Codex **0.160.1**, without a prerelease suffix, is accepted. The node checks
version/help output, fingerprints the canonical executable, and verifies the
app-server protocol schemas. It never installs or upgrades Codex automatically.
Opaque launchers are rejected; configure an absolute path to the native executable.

- `--codex-path /absolute/codex` selects the executable explicitly.
- `ABELE_CODEX_PATH` supplies the executable when `--codex-path` is omitted.
- `--codex` opts into discovery through absolute entries in the daemon's trusted
  `PATH`. Relative and worktree search entries are ignored.

Without any of these options, ordinary daemon startup does not discover or start
Codex. `--codex-model MODEL_ID` selects the model explicitly; there is no automatic
model substitution. Only the first-party model provider is supported, and
unexpected provider definitions are refused.

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

## Log the node into Codex

Use the same state directory as the node's `--state-dir` option. If that option is
omitted, the default is `$HOME/.local/state/abele-node`. Run the following commands
as the OS user that runs the node. Replace the example absolute paths and model
ID with your configuration:

```sh
STATE_DIR=/absolute/node-state
CODEX_BIN=/absolute/codex
MODEL_ID=YOUR_MODEL_ID

abele-node doctor --state-dir "$STATE_DIR" \
  --codex-path "$CODEX_BIN" --codex-model "$MODEL_ID"
```

Doctor prepares the private `$STATE_DIR/codex` home once executable and
administrator-policy checks pass. Before login, an authentication-required
result is expected. Do not proceed past other configuration errors.

Log in using device authentication:

```sh
CODEX_HOME="$STATE_DIR/codex" HOME="$STATE_DIR/codex" \
  "$CODEX_BIN" \
  -c 'cli_auth_credentials_store="file"' \
  -c 'forced_login_method="chatgpt"' \
  -c 'analytics.enabled=false' \
  -c 'feedback.enabled=false' \
  login --device-auth
```

Follow Codex's displayed login instructions. Credentials are stored in
`$STATE_DIR/codex/auth.json`; the node does not copy credentials from another CLI
home. The executable path must be absolute and resolved before changing `HOME`.
The Codex home, SQLite and log directories must remain private and canonical;
credential/config symlinks, non-private files and wrong ownership are refused.

After login, verify readiness and start or restart the node with the same options:

```sh
abele-node doctor --state-dir "$STATE_DIR" \
  --codex-path "$CODEX_BIN" --codex-model "$MODEL_ID"
abele-node start --state-dir "$STATE_DIR" \
  --codex-path "$CODEX_BIN" --codex-model "$MODEL_ID"
```

If the node is already running, stop it before restarting. For an installed
service, persist these options in its configuration; see [installation](install.md).
Doctor checks the stdio handshake, schemas, effective configuration, managed
requirements, local authentication type, and selected-model availability with
low reasoning effort. It creates no thread or model turn. Startup uses these same
checks, and they are reapplied before each production turn. Doctor does not return
authentication payloads or unrestricted diagnostics. Human-readable output is
the default; add `--json` for scripts.

## Default configuration and permissions

Telemetry and analytics are off by default. Feedback, prompt/response logging,
update checks, apps, plugins, hooks, memories and native multi-agent features are
off by default. Remote features, including remote control, are off by default.
Web search, tool-network access, shell environment inheritance and login shells
are off by default. The worker environment is allowlisted, and no Codex network
listener is requested.

Each active run has one supervised stdio app-server. Its permission profile
grants writes to the canonical workspace and minimum runtime reads, with explicit
denials for node state, sibling workspaces, host-temp locations and protected Git
and policy paths. Effective values are checked before user input. Project or
managed configuration that adds roots/resources or changes checked values causes
refusal, not silent permission broadening. Only explicit node RPC methods are
available; Codex endpoints are never exposed to the plugin.

## Approvals and questions

Workspace-contained commands run without per-command prompts. Native command
and patch approval requests require one exact, durable answer from you. Only
single-action `accept`, `decline` and cancellation are supported. Session-wide
grants, rule amendments, grant roots, permission-expansion requests and requests
with missing or inconsistent action evidence are denied. This is not pi's
every-tool approval gate.

Questions preserve option descriptions and free-text answers, with one durable
prompt per bounded question. Rejection, expiry or interruption cancels the
interaction; no default answer is selected. Prompt delivery records authorization
to dispatch, not proof that an operation executed.

Delegated children use node-owned isolated workspaces and explicit provider
grants. Existing grants and default grant lists do not automatically acquire
Codex authority; see [delegation](delegation.md).

## Resume and interruption

The node records the thread ID, workspace identity, policy fingerprint and model
before dispatching user input. Resume uses only the recorded thread ID; missing
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

This is sampled process ownership, not exhaustive kernel containment. A process
that removes its marker and detaches or reparents before a sample can escape the
inventory. Protected or unreadable environments cannot supply sweep evidence.
The marker is not an authorization credential. Known identities are rechecked
before signals; unconfirmed cleanup retains ownership and remains an error.
