# Run without Docker

This is the recommended deployment: the daemon and your CLI share your local
repositories, login and provider resume files. Run it as your ordinary user, not root.
Windows is **untested**; Unix sockets, POSIX process groups and service support make
this guide specific to macOS/Linux. macOS is the primary tested native host.
The offline suite runs on both macOS and Linux: macOS checks native ACL/xattr
preservation, while Linux checks POSIX modes/inodes/ownership. Linux service examples
are provided; native service lifecycle and real-provider login/execution acceptance
on Linux remain unverified.

## Prerequisites

- Node.js **>=22** (`package.json` engines). The tested/pinned build uses
  **22.23.2**, npm **10.9.8**, and experimental built-in `node:sqlite`. An older
  Node 22 minor can lack the required SQLite API; use the tested version rather
  than interpreting the engine range as a compatibility guarantee.
- Git **2.31+**, available as `/usr/bin/git`. On macOS install the Command Line
  Tools (`xcode-select --install`); on Debian/Ubuntu install `git` and `procps`.
  Process supervision requires `/bin/ps`. Repositories need an initial commit
  before managed worktrees can be provisioned.
- Your own Claude Code CLI **2.1.285 or 2.1.291** installed and logged in under the
  same user, if you want real execution. Use the provider's official installation
  and login instructions; verify its version separately. A paid account/quota may
  be required. `doctor` checks compatibility, **not authentication or quota**.
- pi can be installed/configured separately, but its daemon adapter is not yet
  implemented. A pi login does not enable node execution. Neither CLI is needed
  for startup, health checks or fake sessions.

## Install from source

```sh
git clone https://github.com/dudaanton/abele-node.git "$HOME/abele-node"
cd "$HOME/abele-node"
npm ci --ignore-scripts
npm run types
npm test
npm run build
```

The root is a private npm workspace, not a globally installable npm release.
Commands below assume the checkout is `$HOME/abele-node`; choose another stable
path if desired. Use `node packages/node-daemon/dist/cli.js` from that checkout.

## First start

```sh
cd "$HOME/abele-node"
node packages/node-daemon/dist/cli.js start
```

It runs in the foreground on `127.0.0.1:7777`, prints a JSON `listening` record
with the `node_id`, and stays alive. Ctrl-C/SIGTERM shuts it down and cleans up
owned provider groups. There is no host/bind-address flag.

The default CLI candidate is `$HOME/.local/bin/claude`. To use another installation,
stop first and supply the **absolute, version-pinned executable**:

```sh
node packages/node-daemon/dist/cli.js start \
  --claude-path "$HOME/.local/share/claude/versions/2.1.291"
```

This path is an example for a native CLI installation; check your own installation
layout. The adapter resolves symlinks before checking and launching, preventing a
mid-run auto-update switch. You can also set `ABELE_CLAUDE_PATH`; it is not a PATH
search. An unavailable CLI does not prevent the daemon from starting.

Useful start/install options:

| Option                                 | Default / meaning                                                                       |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| `--state-dir PATH`                     | `$HOME/.local/state/abele-node`; use consistently for every command                     |
| `--port PORT`                          | `7777`; `0` selects an ephemeral port for tests, not service installation               |
| `--worktree-root PATH`                 | `STATE_DIR/worktrees`; absolute, empty, node-owned managed root                         |
| `--claude-path PATH`                   | `$HOME/.local/bin/claude`, or `ABELE_CLAUDE_PATH`                                       |
| `--claude-profile inherited\|isolated` | `inherited`: user-only settings; repository permissions require explicit project opt-in |
| `--claude-budget USD`                  | `0.35`, maximum `10`; requested CLI limit, not a quota/billing guarantee                |
| `--claude-deadline-ms MS`              | `120000`, valid range `1000`–`1800000`                                                  |
| `--permission-ttl-ms MS`               | `60000`, valid range `1`–`3600000`                                                      |

Managed-root selection is persisted and cannot change after the first workspace
reservation. Do not point it at your original checkouts. Register projects through
the plugin/client using their existing paths; the node creates managed branches
`abele/<workspace_id>` without taking over the original checkout.

## Enroll the Abele plugin

From another terminal, in the checkout:

```sh
node packages/node-daemon/dist/cli.js token create desktop
node packages/node-daemon/dist/cli.js status
```

`token create` generates a random 256-bit token and prints JSON containing
`installation_id`, `token` and its label. **The token is shown once**; only its hash
is stored by the daemon. This works before startup or through protected local IPC
while running; it does not open a second database owner.

In a plugin version that includes AbeleNode integration, add a local node. The
connection needs:

- Endpoint: `ws://127.0.0.1:7777/channel` (or your actual native port).
- Installation ID and token from `token create`.
- Expected node identity (`node_id` from `status`) when the enrollment UI asks for it;
  the client also pins it on its first successful connection.

UI labels/layout may vary by plugin version; this repository does not install the
plugin or guarantee that a released plugin has the enrollment UI yet. The
[plugin repository](https://github.com/dudaanton/abele-obsidian-plugin) is the source
of its UI instructions. The client API is `@abele/node-client`.

Enrollment secrets and the installation's client store belong in **device-local**
storage, not Obsidian-synced settings, notes, URL queries, cookies or shell arguments.
Use a separate token for each installation. A replaced token needs a fresh client
store namespace. Only desktop local connections work; a phone's loopback points at
the phone, not this computer. Pairing/remote enrollment is not available.

```sh
node packages/node-daemon/dist/cli.js token list
node packages/node-daemon/dist/cli.js token revoke INSTALLATION_ID
```

List never prints secrets/hashes. If you lose a token, revoke it and create another.
All admitted installations currently share node-wide authority; do not issue tokens
to untrusted users. To run Claude, explicitly register a **trusted** Git project,
wait for managed-workspace provisioning to succeed, and attach a Claude session.
The fake provider is non-executing and is the default in the client API.

## macOS: LaunchAgent

The built-in installer is the simplest service path. Stop any foreground daemon,
then run:

```sh
cd "$HOME/abele-node"
node packages/node-daemon/dist/cli.js install \
  --claude-path "$HOME/.local/share/claude/versions/2.1.291"
node packages/node-daemon/dist/cli.js status
launchctl print "gui/$(id -u)/dev.abele.node"
```

It copies built packages and production dependencies to
`$HOME/.local/state/abele-node/runtime`, writes
`$HOME/Library/LaunchAgents/dev.abele.node.plist`, and bootstraps it for the logged-in
user. This runtime is independent of the source checkout. It sets HOME/PATH,
RunAtLoad/KeepAlive and private log paths. **Keep the absolute Node executable
installed**, especially if using a version manager. Shell startup files are not read.

Equivalent minimal plist example (replace **every** `HOME_PATH` with your actual
absolute home path; launchd does not expand `$HOME` or `~`). The example Node path
is illustrative; use `command -v node` from your intended Node installation.
The built-in installer generates the real paths and additional CLI options for you.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.abele.node</string>
  <key>ProgramArguments</key>
  <array>
    <string>HOME_PATH/.local/bin/node</string>
    <string>HOME_PATH/.local/state/abele-node/runtime/packages/node-daemon/dist/cli.js</string>
    <string>start</string>
    <string>--state-dir</string><string>HOME_PATH/.local/state/abele-node</string>
    <string>--claude-path</string><string>HOME_PATH/.local/share/claude/versions/2.1.291</string>
  </array>
  <key>WorkingDirectory</key><string>HOME_PATH/.local/state/abele-node</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>HOME_PATH</string>
    <key>PATH</key><string>HOME_PATH/.local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>HOME_PATH/.local/state/abele-node/logs/stdout.log</string>
  <key>StandardErrorPath</key><string>HOME_PATH/.local/state/abele-node/logs/stderr.log</string>
</dict>
</plist>
```

For a hand-written plist, first deploy a complete runtime (the installer does this),
create the log directory/files with modes `0700`/`0600`, and validate with
`plutil -lint`. Do not load both a custom plist and the installed one. Stop disables
this state's installed agent before signaling the process so KeepAlive cannot undo it:

```sh
node packages/node-daemon/dist/cli.js stop
# To restart the installed service without reinstalling:
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/dev.abele.node.plist"
```

## Linux: systemd --user

The CLI's `install` command is macOS-only. On Linux use a stable source checkout
(or your own deployed runtime) and create
`$HOME/.config/systemd/user/abele-node.service`:

```ini
[Unit]
Description=AbeleNode local coding daemon
After=network.target

[Service]
Type=simple
WorkingDirectory=%h/abele-node
ExecStart=%h/.local/bin/node %h/abele-node/packages/node-daemon/dist/cli.js start --state-dir %h/.local/state/abele-node --claude-path %h/.local/share/claude/versions/2.1.291
Environment="PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin"
UMask=0077
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=default.target
```

Replace the Node and Claude paths with existing absolute executables. `%h` is
systemd's home-directory specifier, not shell expansion. Run as your user, not a
system-wide root service:

```sh
systemctl --user daemon-reload
systemctl --user enable --now abele-node.service
systemctl --user status abele-node.service
journalctl --user -u abele-node.service -f
```

If it should survive logout, explicitly opt into lingering with
`loginctl enable-linger "$USER"` (may require administrator approval). This extends
how long a credentialed agent can run; do not enable it casually. Stop with
`systemctl --user stop abele-node`, not merely the CLI's `stop`, while supervised.

## State, logs and diagnostics

Default state: `$HOME/.local/state/abele-node` on both operating systems.

- `node.sqlite` plus WAL/SHM: identities, token hashes, sessions, queue, receipts,
  prompts, journals, jobs and retained content/diff/artifact bytes.
- `daemon.lock`: PID, port, node identity, detected provider configuration and the
  ready private endpoint in `control_socket`.
- `file-recovery/`: protected pre-write copies for [editing/restore](editing.md),
  bounded to 32 copies / 16 MiB per workspace.
- `worktrees/`: default managed worktree root, unless explicitly configured otherwise.
- `runtime/`, `logs/`: created by the macOS installer. Foreground output goes to
  the terminal; systemd output goes to the journal.

The token-management socket now lives in a short, random `0700` **temporary directory**,
not under an arbitrarily long state path. Its `0600` endpoint is published only after
startup as `daemon.lock.control_socket` (also visible in `status`). The endpoint is
at most 100 bytes to avoid macOS/libuv Unix-path truncation. It uses the OS temporary
directory, falling back to `/tmp` if a custom TMPDIR would make the path too long.
Normal shutdown removes the directory; SIGKILL/crash orphan cleanup is not automated.
The CLI discovers this endpoint and retains `STATE_DIR/control.sock` fallback for
older already-running daemons. Do not hardcode or back up the temporary endpoint.

Claude approval IPC also uses a **separate short random `0700` temporary directory
per run**, with a `0600` socket and MCP configuration. It no longer selects a
HOME-based default or derives IPC paths from the state directory; custom
`--state-dir` values do not send IPC writes to the default home state. The allocator
canonicalizes the OS temporary root before measuring the socket path and falls back
to canonical `/tmp` if necessary to keep it within 100 bytes. The core records the
run's endpoint directory in SQLite for cleanup/reconciliation; confirmed normal,
interrupted and restart cleanup removes it. Cleanup refuses unmanaged paths,
symlink replacements, wrong ownership or insecure directory permissions. Keep the
same temporary-root environment when reconciling unfinished runs. Temporary IPC
files are not backup data; journals and native provider resume files are separate.
For an upgrade from the earlier HOME-based IPC layout, stop the old runtime and
confirm its active runs are cleaned up first; do not ask the new runtime to blindly
remove legacy paths.

State directories are `0700`; database/lock/socket/logs are `0600`. This is not
at-rest encryption. Logs are **not rotated automatically**. Journals, receipts,
content and snapshots have no automatic retention expiry. Monitor disk space.
Provider resume files and credentials remain CLI-owned (typically under
`$HOME/.claude` for Claude); the node does not back them up or read credentials.

```sh
node packages/node-daemon/dist/cli.js status
node packages/node-daemon/dist/cli.js doctor
# For a non-default state, pass the same option to EVERY command:
node packages/node-daemon/dist/cli.js doctor --state-dir "$HOME/abele-node-state"
```

`status` reports the locally recorded live PID/identity/port and provider report;
it is **not** an authenticated network probe. `doctor` adds Node/SQLite/state-mode
and LaunchAgent diagnostics. With a running daemon, provider diagnostics describe
that daemon, not a different CLI from your current shell. Neither command requests
model inference. Runtime diagnostics can contain local paths; redact before sharing.

## Upgrade

1. Stop via launchd/systemd (or Ctrl-C for foreground). Confirm `status` is stopped
   and investigate any unconfirmed provider cleanup before proceeding.
2. Back up the **whole stopped state directory** and preserve the provider's native
   resume files separately. Also preserve project Git metadata and managed worktrees
   together; worktree paths/registration provenance are absolute. Copying only the
   SQLite main file while WAL is live is not a safe backup.
3. In the checkout, fetch and select the intended release, then rebuild:

   ```sh
   git fetch --tags origin
   git checkout v0.1.0  # example; select an existing release
   npm ci --ignore-scripts
   npm run types
   npm test
   npm run build
   ```

4. macOS: run `install` again with the same state/root/port/provider options. Linux:
   restart the user service; foreground: start again. Check `status` and `doctor`.

Database migrations are versioned and transactional; newer schemas are refused by
older code. Migration 9 refuses legacy recovery rows/old mutation intents requiring
manual inspection rather than deleting their evidence; see [editing](editing.md). Downgrades require the stopped pre-upgrade backup, not deleting migration
markers. Provider version updates need separate compatibility verification; no
permission-bypass fallback exists.

## Uninstall

First stop all sessions and review any dirty managed worktrees. Preserve their
changes/branches before removing anything.

- macOS: run `stop`, then remove
  `$HOME/Library/LaunchAgents/dev.abele.node.plist`.
- Linux: `systemctl --user disable --now abele-node.service`, remove the unit file,
  then `systemctl --user daemon-reload`. Disable lingering only if you enabled it
  solely for this service.
- Revoke tokens if retaining state. Remove the checkout/runtime only after stopping.
  **State is not automatically deleted**: archive it, or remove the state directory
  only after consciously discarding history and worktree data. Remove a custom
  managed root separately. Do not delete original projects or provider credentials
  as part of daemon uninstall. Removing worktree directories by hand can leave Git
  registrations; inspect each project's `git worktree list` and repair explicitly.

## Troubleshooting

| Symptom                                         | What to check                                                                                                                                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `EADDRINUSE` / port 7777 in use                 | Another daemon/service may already own it. Run `status` with the correct state, inspect `lsof -nP -iTCP:7777 -sTCP:LISTEN` on macOS or `ss -ltnp` on Linux. Stop the owner or choose `--port 7779` and enroll that native endpoint. Never kill an unknown process. |
| `already_running`                               | One daemon per state. Check service supervision before starting a foreground copy.                                                                                                                                                                                 |
| `lock_needs_doctor`                             | An unreadable/corrupt lock is not proof of a dead process. Inspect the lock and process ownership; do not blindly delete it.                                                                                                                                       |
| CLI missing / `unavailable/incompatible`        | Check the absolute `--claude-path`, executable permission, version (only 2.1.285/2.1.291), and required flags. Pin an installed compatible binary; restart/reinstall to change it. `PATH` alone is not enough.                                                     |
| CLI login fails                                 | Authenticate your own CLI as the same OS user, with the service's HOME. Compatibility checks do not test account login/quota.                                                                                                                                      |
| Service works in shell but not at login         | Node version-manager paths may have moved; shell rc files are not read. Inspect plist/unit absolute paths, HOME/PATH and stderr/journal.                                                                                                                           |
| Plugin rejects endpoint / authentication        | Use exact `ws://127.0.0.1:PORT/channel`, not `localhost`, a LAN IP or a token-bearing URL. Check installation/token/node identity and desktop Origin. A revoked/new token needs a new client-store namespace.                                                      |
| SQLite/API error                                | Use Node 22.23.2, writable private local state, and sufficient disk space. Do not put live SQLite/WAL state in a synced folder or network filesystem.                                                                                                              |
| `git_required` / provisioning `needs_attention` | Commit the original repository first; re-register a formerly plain folder. For ambiguous Git effects inspect the durable job and worktree/branch state; there is no blind repair/retry.                                                                            |
| `delivery_unknown` / cleanup unconfirmed        | Do not resend an uncertain input automatically. Inspect durable run evidence, CLI processes and workspace state; cleanup failure fences further execution.                                                                                                         |

Read the [security model](security.md) before trusting a repository or changing
Claude setting sources.
