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
- Your own Claude Code CLI **>=2.1.285 and <3.0.0**, with the required public and
  permission prompt flags, installed and logged in under the
  same user, if you want real execution. Use the provider's official installation
  and login instructions; verify its version separately. A paid account/quota may
  be required. `doctor` checks compatibility, **not authentication or quota**.
- The pinned pi SDK is bundled with the daemon. Real SDK execution needs your own
  local model configuration/authentication; see [pi configuration and limits](pi.md).
  No external provider CLI is needed for startup, health checks or fake sessions.

## One-command native installer

Install the prerequisites above first. **Read [install.sh](../install.sh) before
executing downloaded code.** Never run this command with sudo:

```sh
curl -fsSL https://raw.githubusercontent.com/dudaanton/abele-node/main/install.sh | sh
```

For a specific release:

```sh
curl -fsSL https://raw.githubusercontent.com/dudaanton/abele-node/main/install.sh | \
  sh -s -- --version 0.3.6
```

Only releases with installer assets can be installed this way. The installer
resolves the latest stable GitHub release when no version is specified. It downloads
`abele-node-X.Y.Z-PLATFORM.tar.gz` and `SHA256SUMS`, checks the exact asset checksum,
and unpacks the built packages plus production dependencies. Supported platforms
are `darwin-arm64`, `darwin-x64`, `linux-arm64` and `linux-x64`. The pi SDK includes
native terminal-library prebuilds, so the artifacts are platform-specific. Node is
**not** bundled or installed: the script requires Node 22.x, at least 22.23,
with working `node:sqlite`, and recommends the tested 22.23.2. It also checks
`/usr/bin/git` >=2.31, curl, tar and shasum/sha256sum.

By default, versions live in `$HOME/.local/share/abele-node/X.Y.Z`, with an
atomically replaced `current` symlink. The command is a wrapper at
`$HOME/.local/bin/abele-node`; add that directory to PATH if the installer warns.
An absolute Node executable is recorded in the wrapper and service. Keep that
Node installation available; services do not source your shell startup files.

| Installer option             | Meaning                                                                                                                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--version X.Y.Z`            | Pin a stable release (`vX.Y.Z` also accepted).                                                                                                                |
| `--prefix PATH`              | Installation prefix, default `$HOME/.local`; wrapper in `PATH/bin`, releases in `PATH/share/abele-node`.                                                      |
| `--state-dir PATH`           | Private state, default `$HOME/.local/state/abele-node`. Must be separate from installed releases and the bin directory.                                       |
| `--claude-path PATH`         | Claude executable; discovers `ABELE_CLAUDE_PATH`, shell PATH, then common locations. Records an absolute physical path; does not install/authenticate Claude. |
| `--no-service`               | Do not register/start a service. Start manually with `abele-node start`. Use again for foreground-only upgrades.                                              |
| `--uninstall`                | Stop the managed daemon, remove its service, wrapper and installed versions; retain state.                                                                    |
| `--purge-state`              | With `--uninstall` only: also remove the state directory, including managed worktrees/history.                                                                |
| `--confirm-purge-state PATH` | Required for purge: repeat the exact absolute state directory to explicitly authorize deletion.                                                               |
| `--help`                     | Print usage.                                                                                                                                                  |

Paths must be absolute and normalized (no `..`, trailing slash or control characters).
Safety checks resolve physical paths, including symlinked parents and existing
ancestors of directories not yet created. Existing directories are compared by
device/inode identity, including case aliases on case-insensitive APFS. Missing
components use read-only case-sensitivity evidence; when their distinction cannot
be proved, overlapping case variants are rejected conservatively. State cannot
physically overlap runtime/bin or resolve to HOME itself or an ancestor of HOME.
A truncated piped
script does nothing: execution starts only after the complete installer body has
been parsed.

The installer records non-secret state/provider settings; reruns with the same
prefix retain them if omitted. The saved state path is canonical, and a service's
state is read from its authenticated plist/unit rather than re-resolving a caller
alias. Its directory identity is recorded for **both foreground and service**
deployments. Even `--no-service` creates a private empty state directory before
recording its identity. A moved/replaced state is refused before stop or purge;
identity is checked again at destructive boundaries, including after stopping and
immediately before deletion. It refuses changing an installed state directory.
Legacy foreground configs without a recorded identity are not silently rebound:
inspect and stop that deployment manually, preserve its state, then migrate to a
fresh installer deployment.
The wrapper supplies those recorded settings for **every command**; use the source
CLI for independently configured instances. It never creates, prints or stores
enrollment secrets; it only prints the command you should run next.

macOS uses the CLI's LaunchAgent installer with the selected immutable release
runtime (no second runtime copy under state). Linux writes
`$HOME/.config/systemd/user/abele-node.service` and enables it with `systemctl --user`.
Without a user manager, use `--no-service`. The script does not enable lingering.
An existing manually installed service is not overwritten: stop/remove it first,
keep its state, then use the installer with the same state/provider settings.
The installer records the physical service-file path and a content fingerprint in
its non-secret config. Every rerun, including uninstall and foreground-to-service
conversion, refuses an unrecorded, missing or modified service file before it can
stop or overwrite anything. Older installer service configurations without this
ownership record are also refused. To move from such a deployment, explicitly stop
the old service, preserve state, and remove the old service and installed
runtime/config before doing a fresh install. Never discard the config of a running
service; use the manual service path if you need to manage its configuration yourself.

Systemd drop-in admission checks apply **only to service deployments**: installing,
upgrading or removing a managed service. Foreground-only installs, upgrades and
uninstalls do not scan drop-ins or contact systemd/busctl, so unrelated user-wide
`service.d` defaults cannot block `--no-service` deployments.

For service deployments, before the first stop or reload the installer checks `service.d/*.conf`, `abele-.service.d/*.conf` and
`abele-node.service.d/*.conf` in all user unit search paths: XDG config/data paths,
runtime/control/generator paths, system defaults, `SYSTEMD_UNIT_PATH`, and the
manager's authoritative `UnitPath` list. Native Linux service deployment requires
`busctl` (systemd tools) with JSON output so paths containing spaces can be checked
without guessing. Missing/invalid introspection fails closed; use `--no-service`
or the manual path if it is unavailable. Admission checks repeat after download and
before stop/reload. Detectable loaded `DropInPaths` or a foreign `FragmentPath`
are refused before the first stop; the installer does not try to enumerate every
possible unit alias to prove that no override can appear later. It also verifies that the manager's live
PID belongs to the recorded state/runtime. Use the manual service path if you need
overrides. On macOS, cached launchd arguments must match the owned plist. An absent
daemon PID alone never confirms stop: launchd must report the job unloaded, or
systemd must report no main PID and an inactive/failed state after stopping.
Unknown manager responses fail closed without removing the runtime or service file.
Legacy services with non-canonical state arguments require an explicit manual stop
and migration; the installer does not guess where their running state was pinned.

For a foreground-only installation, for example:

```sh
curl -fsSL https://raw.githubusercontent.com/dudaanton/abele-node/main/install.sh | \
  sh -s -- --no-service --prefix "$HOME/.local" --state-dir "$HOME/abele-node-state"
abele-node start
```

After installation, run `abele-node token create desktop`, then follow
[plugin enrollment](#enroll-the-abele-plugin). With a service, `abele-node status`
and `abele-node doctor` should report a running daemon. With `--no-service`, they
validate the runtime but report stopped until you start it yourself. Provider
unavailability does not fail installer health checks.

### Installer upgrades and removal

Back up the whole **stopped** state before upgrading; see [upgrade](#upgrade).
Once your installed release includes the update command, use:

```sh
abele-node update --check             # current/latest; always exits 0 on a successful check
abele-node update                     # latest stable GitHub release
abele-node update --version 0.3.2     # example: explicitly select an existing tag
abele-node update --check --json      # machine-readable report for scripts
```

Update output is short plain text by default: current/target versions, agent-turn
admission pause/resume, completion or failure, and the next command to run. Active
runs still require waiting for them to finish or an explicit `--force`; a forced
update says that the installer must stop running agents, not that they are already
stopped. Installer stdout/stderr are captured, not dumped into the human summary.
`--json` emits one complete report on stdout (including failures), with versions,
installation settings, active-run IDs, pause/resume state, warnings, exit status,
next steps and the full captured installer diagnostics. Scripts parsing update
output must pass `--json`; failure exit codes remain nonzero in either mode.

`--check` never downloads/runs an installer or stops the daemon. An update available
is reported clearly, not as an exit-code failure. Normal updates do nothing when
the target is equal to or older than the installed version, including explicit
version pins. This is an upgrade command, not a database downgrade mechanism.
The updater uses the recorded prefix, state directory, Claude path and service mode,
not shell discovery or new command-line state/provider overrides. Older installer
configs without a recorded prefix are supported by deriving it from the installed
runtime path. A source/manual installation instead says to use `git pull` and makes
no changes.

The updater downloads `install.sh` from the selected **release tag**, never `main`.
If the release publishes `SHA256SUMS`, its single `install.sh` entry must match
before any execution; a missing/duplicate entry, checksum mismatch or failed
download is an error, never a reason to bypass verification. Future releases carry
both the installer asset and its checksum. If a legacy release has no installer
asset, the unpinned update refuses it. Explicit `--version X.Y.Z` allows that tag's
raw installer over HTTPS, with a clear notice that it has no installer checksum.
An installer asset published without `SHA256SUMS` also produces a warning.
The installer remains responsible for archive verification, service ownership,
transactional deployment and rollback; updater failures preserve its diagnostics
and exit status.

Active provider runs are reported by run/session ID and block installation. The
updater holds a private `STATE_DIR/update.lock` admission fence through download
and installer execution, so queued provider runs cannot start between inspection
and deployment. Dispatch and fence publication serialize via a short-lived
`STATE_DIR/.run-admission` lock. Neither lock changes queued input or database
schema; normal completion/failure releases the updater's fence and dispatch
resumes. SIGINT/Ctrl-C, SIGTERM and SIGHUP abort an in-progress download and release
the fence before exiting. Concurrent updaters are refused. If the updater was
killed without cleanup, provider dispatch and later updates can reclaim
`update.lock` once its recorded PID is confirmed absent. Recovery serializes with
fence publication and never removes a replacement lock. Live, malformed or
unverifiable owners remain fenced. An orphaned `.run-admission` lock still requires
manual inspection: confirm its owner has stopped before removing it. Never remove
a live process's lock. Wait for active runs to finish; `abele-node update --force` explicitly permits interrupting
active runs, but does not bypass any installer ownership or cleanup checks.
Foreground-only daemons still need to be stopped manually before installation,
even with `--force`.
For releases predating the update command, rerun the same one-liner (and the same
`--prefix`, plus `--no-service` if used), or pin a newer version with `--version`.
Downloads/import validation happen before stopping the old service. Ownership checks also complete before deployment mutation;
a refusal does not trigger recovery of an untouched service. Fresh service installs
and foreground-to-service conversions refuse a running foreground/manual daemon:
stop it explicitly first.

The installer keeps a private **write-ahead** journal. Before each mutation it writes
and fsyncs an intent containing its target, backup and prior state; afterward it
writes and fsyncs a completion marker. This covers our service stop, immutable
version deployment, pointer switch, unit write, enablement, service start and
wrapper/config publication. Before the first mutation it checks journal writability
and free space on the journal/backup volumes and allocates a private 1 MiB recovery
reserve. If a completion write fails (including disk exhaustion), the durable intent
still authorizes recovery. An incomplete final journal write is ignored safely.

The installer itself journals the possibly partial macOS plist write/bootstrap
around the CLI call. It neither passes nor depends on `--installer-journal`, so
cached older runtimes can safely ignore that protocol. Rollback treats intents
without completion as **possibly applied**, restores their snapshots idempotently
in reverse, and checks actual manager state before stopping a possibly started job.
No matching launchd job means no CLI stop: a manual daemon is never signaled just
because an install intent existed. State is retained, and cached
versions referenced by active/unverifiable user overrides are not removed.

After switching `current` and starting the new service, `status`/`doctor` verify the
running runtime's identity and release version, not just `running: true`.
Recovery restores a journaled unit write from its exact backup (including mode).
Only a journaled stop of our previously running service authorizes its restart;
an already inactive service stays inactive on failure. That restored systemd unit
is reloaded, enabled without starting it, and explicitly restarted—even if alias,
generic or other user overrides change its effective configuration. `enable --now` is not used as a substitute for restart:
a timer or socket may have reactivated the rejected version during restoration.
Health checks then verify that the running runtime is the previous version. Overrides are
reported, not deleted or used to veto recovery. An unconfirmed failed-service stop
also does not prevent restoring the old unit and explicitly attempting a restart. If the old install had no service, rollback removes and
disables the newly created one instead of leaving it to restart at login. Foreground daemons must be stopped
manually before a `--no-service` upgrade. Previous versions are retained.

Runtime rollback is **not a database downgrade**: a new version may already have
migrated state. If an older runtime refuses the schema, stop and restore your
pre-upgrade backup rather than editing migration markers. The installer reports
failed service rollback; inspect logs and run `status`/`doctor` before proceeding.
The restart may use user override settings, so it is not a promise that the effective
runtime matches the old version. If health cannot verify that version, or the service
manager/restart fails, the warning is explicit and the backup remains available.
State-identity and backup-integrity checks are not relaxed during recovery.
Service backups are private and adjacent to the service file, so an external
runtime prefix does not cause cross-filesystem rename failures. Before stopping the
old service, the installer writes, preserves the mode of, and fsyncs a complete
restore candidate **on the service file's volume**. Recovery only validates and
atomically renames that candidate; it does not allocate new service-file bytes when
HOME fills after the upgrade begins. The original backup remains available for
manual recovery. If restoration/restart cannot be verified,
the original backup is retained outside download cleanup and its path is printed
for manual recovery. Do not delete that backup before restoring or safely archiving it.

To uninstall while retaining state:

```sh
curl -fsSL https://raw.githubusercontent.com/dudaanton/abele-node/main/install.sh | \
  sh -s -- --uninstall
```

Explicitly discard state only after reviewing sessions, dirty worktrees and backups:

```sh
curl -fsSL https://raw.githubusercontent.com/dudaanton/abele-node/main/install.sh | \
  sh -s -- --uninstall --purge-state \
  --confirm-purge-state "$HOME/.local/state/abele-node"
```

For a custom prefix/state, pass the same prefix and confirm the recorded state path.
Uninstall does not remove original projects, provider credentials or a separately
configured managed root. Purging managed worktree files can leave registrations
in their original repositories; inspect `git worktree list` and repair explicitly.

For local installer tests only, `ABELE_INSTALL_BASE_URL` replaces the GitHub download
base (assets are under `/releases/download/vX.Y.Z/`), and `ABELE_INSTALL_API_URL`
replaces the latest-release JSON endpoint. The updater uses these same overrides;
pinned lookups replace the endpoint's trailing `/latest` with `/tags/vX.Y.Z`.
`ABELE_UPDATE_RAW_URL` overrides the raw-file repository base for pinned legacy
updater tests (files are under `/vX.Y.Z/install.sh`). Update downloads require
HTTPS, with HTTP allowed only for loopback test servers. These overrides execute
code from that source; do not point them at an untrusted server. SHA-256 detects corruption, not
compromise of the release publisher or both files on a mirror.

## Install from source (manual alternative)

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

It runs in the foreground on `127.0.0.1:7777`, prints its port and node ID
in plain text, and stays alive. Add `--json` for a machine-readable `listening`
record. Ctrl-C/SIGTERM shuts it down and cleans up owned provider groups. There is no host/bind-address flag.

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

For an installer deployment:

```sh
abele-node token create desktop
abele-node status
```

For a source checkout, substitute `node packages/node-daemon/dist/cli.js` for
`abele-node` in these commands.

`token create` generates a random 256-bit token and prints short connection
instructions. **The token is shown once**; only its hash is stored by the daemon.
This works before startup or through protected local IPC while running; it does
not open a second database owner. Output is plain text by default. Add `--json`
for scripts to get `installation_id` and `token`.

In the plugin, open **Abele Settings → Nodes** and fill in:

- **Label:** any name you like.
- **URL:** `http://127.0.0.1:7777`, or the URL printed by `token create`.
- **Installation token:** the token printed by `token create`.

Click **Add node**. Do not append `/channel` or use `ws://`; the plugin builds the
channel URL itself. You do not need to paste an installation ID or node ID.
`token create` uses the running daemon’s actual port. If you create a token before
starting on a custom port, pass that same `--port PORT` to both commands.

Use a plugin version with **Nodes** settings; this repository does not install the
plugin. See the [plugin repository](https://github.com/dudaanton/abele-obsidian-plugin)
for its UI instructions. The client API is `@abele/node-client`.

Enrollment secrets and the installation's client store belong in **device-local**
storage, not Obsidian-synced settings, notes, URL queries, cookies or shell arguments.
Use a separate token for each installation. A replaced token needs a fresh client
store namespace. Only desktop local connections work; a phone's loopback points at
the phone, not this computer. For a phone or remote desktop, use **Pair remote node**
in the plugin with an invitation after enabling the node’s paired listener and
Tailscale Serve. See [remote access and pairing](remote-access.md); real phone
pairing is not verified by this guide.

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

Run `abele-node --version` (or `abele-node version`) to print the installed package
version. For a source checkout, use `node packages/node-daemon/dist/cli.js --version`.

Default state: `$HOME/.local/state/abele-node` on both operating systems.
At startup the daemon resolves the state directory's existing ancestor to its
physical path before creating missing descendants. Database, recovery, provider
state and lock operations then use that pinned path; `status`/`doctor` report it.
A stable parent alias such as macOS `/tmp` → `/private/tmp` is supported. Changing
an alias while the daemon is running does not relocate its state; stop before
moving state, and use the reported physical path to address the running instance.

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

All CLI commands print concise human-readable text by default. `status` shows
running state, version, port, node ID, Claude/pi availability with repair guidance,
paired/remote state, and project/workspace counts. `doctor` shows an OK/problem
checklist with a fix for each problem. Disk encryption is reported as unknown because
the command does not inspect encryption of the state volume; check FileVault or
your OS disk-encryption settings. The legacy JSON `encrypted_at_rest` flag describes
application-level encryption, not disk encryption. Counts include registered projects and workspaces that have not been removed.
They are read locally without starting the daemon;
“unknown” means the database could not be read.

For scripts, add `--json` to retain the original output schema (including the existing
plain version string and error messages):

```sh
abele-node status --json
abele-node doctor --json
abele-node token create desktop --json
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
3. For the one-command installer, run `abele-node update` (or
   `abele-node update --version X.Y.Z` to select a release). It reuses the recorded
   installation settings. If the old release has no update command, rerun the
   installer with the same prefix/settings and intended `--version` (plus
   `--no-service` for a foreground-only deployment).
   For a source checkout, fetch and select the intended release, then rebuild:

   ```sh
   git fetch --tags origin
   git checkout v0.3.6  # example; select an existing release
   npm ci --ignore-scripts
   npm run types
   npm test
   npm run build
   ```

4. The one-command installer restarts its service and checks `status`/`doctor`.
   For source installs on macOS, run `install` again with the same
   state/root/port/provider options; on Linux, restart the user service.
   For foreground installs, start again. Check `status` and `doctor`.

Database migrations are versioned and transactional; newer schemas are refused by
older code. Migration 9 refuses legacy recovery rows/old mutation intents requiring
manual inspection rather than deleting their evidence; see [editing](editing.md). Downgrades require the stopped pre-upgrade backup, not deleting migration
markers. Provider version updates need separate compatibility verification; no
permission-bypass fallback exists.

## Uninstall

First stop all sessions and review any dirty managed worktrees. Preserve their
changes/branches before removing anything.

For one-command installations, use `install.sh --uninstall` as described above.
For manual/source installations:

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

| Symptom                                         | What to check                                                                                                                                                                                                                                                                                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `EADDRINUSE` / port 7777 in use                 | Another daemon/service may already own it. Run `status` with the correct state, inspect `lsof -nP -iTCP:7777 -sTCP:LISTEN` on macOS or `ss -ltnp` on Linux. Stop the owner or choose `--port 7779` and enroll that native endpoint. Never kill an unknown process.                                                                                                |
| `already_running`                               | One daemon per state. Check service supervision before starting a foreground copy.                                                                                                                                                                                                                                                                                |
| `lock_needs_doctor`                             | An unreadable/corrupt lock is not proof of a dead process. Inspect the lock and process ownership; do not blindly delete it.                                                                                                                                                                                                                                      |
| Claude unavailable                              | Run `abele-node doctor` or `abele-node status`: human output gives the cause and repair command (`claude.diagnostic` with `--json`). Versions >=2.1.285 and <3.0.0 require all public flags and acceptance of the permission prompt flags. Run `claude update` for old/missing flags, then reinstall with `sh install.sh --claude-path /absolute/path/to/claude`. |
| CLI login fails                                 | Authenticate your own CLI as the same OS user, with the service's HOME. Compatibility checks do not test account login/quota.                                                                                                                                                                                                                                     |
| Service works in shell but not at login         | Node version-manager paths may have moved; shell rc files are not read. Inspect plist/unit absolute paths, HOME/PATH and stderr/journal.                                                                                                                                                                                                                          |
| Plugin rejects endpoint / authentication        | In the plugin’s URL field use `http://127.0.0.1:PORT` with the daemon’s actual port, without `/channel`; not `ws://`, `localhost`, a LAN IP or a token-bearing URL. Paste only the token into Installation token. For a phone or remote desktop use Pair remote node. Check the token and desktop Origin. A revoked/new token needs a new client-store namespace. |
| SQLite/API error                                | Use Node 22.23.2, writable private local state, and sufficient disk space. Do not put live SQLite/WAL state in a synced folder or network filesystem.                                                                                                                                                                                                             |
| `git_required` / provisioning `needs_attention` | Commit the original repository first; re-register a formerly plain folder. For ambiguous Git effects inspect the durable job and worktree/branch state; there is no blind repair/retry.                                                                                                                                                                           |
| `delivery_unknown` / cleanup unconfirmed        | Do not resend an uncertain input automatically. Inspect durable run evidence, CLI processes and workspace state; cleanup failure fences further execution.                                                                                                                                                                                                        |

Read the [security model](security.md) before trusting a repository or changing
Claude setting sources.

The one-command installer discovers Claude in this order: `--claude-path`,
`ABELE_CLAUDE_PATH`, `command -v claude` in the installing shell, then
`~/.local/bin/claude`, `~/.claude/local/claude`, `/opt/homebrew/bin/claude`,
`/usr/local/bin/claude`. It records an absolute physical path in its config and
includes Claude's directory and the installer's Node directory in service PATH.
It checks `claude --version` under that PATH; shell startup files are not loaded.
If Claude is missing or that check fails, installation continues and pi still works.
Install/fix Claude and rerun the installer with `--claude-path` to update the service.

Compatible versions without recorded real acceptance evidence report
“untested version, flags detected” and unverified permission/resume capabilities.
The recorded evidence for 2.1.285 and 2.1.291 is retained. Availability checks never
start inference or verify account login, quota, or real permission behavior.
