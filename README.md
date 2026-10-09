# AbeleNode

AbeleNode is a daemon on your development machine for running coding-agent sessions
in isolated Git worktrees. Its control surface is the
[Abele Obsidian plugin](https://github.com/dudaanton/abele-obsidian-plugin), through
an authenticated WebSocket client API. Plugin UI availability depends on the plugin
version; this repository supplies the daemon, protocol and client libraries.

**Early software.** Local-token control stays loopback-only. Node-side paired WSS
through Tailscale Serve is available but separately enabled; plugin pairing UI is
not yet released. Claude Code execution works with explicitly tested CLI versions;
the pi SDK provider is available and capability-gated;
see [pi configuration and limits](docs/pi.md). Windows is untested. See
[remote access, pairing and revocation](docs/remote-access.md).

## What works today

- Durable sessions, event history, queued follow-ups, reconnect/replay and
  retry-safe mutation receipts, backed by SQLite.
- Multiple projects, managed Git worktrees and branches, exclusive session leases,
  durable provisioning/removal jobs and restart reconciliation.
- Supervised Claude Code turns: streaming text/tool events, allow/deny/expiry
  approvals, interruption, process-group cleanup and explicit native-session resume.
- Supervised pi SDK turns using the same queue, journal, approvals and native-file
  resume flow; per-feature capability gates and local model configuration apply.
- Node-side delegation with owner-approved controller grants, isolated child workspaces,
  structured durable mailboxes and retry-safe creation. The plugin tool integration
  is separate; see [delegation API and limits](docs/delegation.md).
- Workspace browsing, file/content reads, Git history, retained immutable diffs
  and anchored review comments submitted as session inputs.
- Bounded UTF-8 file editing/creation with content-version checks, durable save
  receipts, protected recovery copies and explicit restore. See [editing](docs/editing.md).
- Per-installation tokens, revocation, status/doctor commands and macOS LaunchAgent
  installation. Offline tests use a non-executing fake provider and fake CLI fixtures.
- Separately enabled paired WSS through Tailscale Serve, owner-confirmed device keys,
  node-key pinning, revocation and explicit migration/recovery. The node-side client
  API is available; the plugin pairing UI is not yet released.

Git-mutation UI, live steering, AskUserQuestion, persistent always-allow,
exhaustive child history and readable thinking are **not supported**. An experimental
[debugger probe](docs/debug-probe.md) exercises synthetic JS/TS/Python targets; it is
not a daemon debugger feature or plugin debugger UI. A worktree is isolation for
Git state, not an OS sandbox for agent tools.

## Requirements

- Node.js **>=22**, as declared in `package.json`; use **22.23.2** and npm **10.9.8**
  for the tested toolchain. The daemon uses experimental built-in `node:sqlite`.
- Git at `/usr/bin/git`, with worktree and `--path-format` support (Git 2.31+).
- Native deployment is the main path; macOS is the primary tested native host.
  The offline suite also runs on Linux, with POSIX metadata checks in place of macOS
  attribute tools. Linux service/container examples are provided; native service
  and real-provider acceptance on Linux remain unverified.
- For real execution: your own installed, authenticated Claude Code CLI,
  **2.1.285 or 2.1.291**. Newer versions are refused until tested. Pi uses the pinned
  SDK dependency with your local model configuration/authentication; inspect its
  feature gates before relying on unverified behavior. No external provider CLI
  installation is required for SDK hosting.
- For remote control: an installed, logged-in Tailscale client, MagicDNS, HTTPS
  certificates and verified access policy. Real mobile integration and device-key
  persistence remain deployment checks; see [remote access](docs/remote-access.md).

## Quick start: without Docker (recommended)

Install Node.js **22.23.2** and Git **2.31+** first, then run as your ordinary user:

```sh
curl -fsSL https://raw.githubusercontent.com/dudaanton/abele-node/main/install.sh | sh
```

**Read [the script](install.sh) first** before piping downloaded code into a shell.
It downloads a platform-specific GitHub release, verifies its SHA-256 checksum,
installs under `$HOME/.local`, and starts a macOS LaunchAgent or Linux user service.
It does not install Node, provider CLIs or credentials. Linux requires a running
systemd user manager; use `sh -s -- --no-service` instead of `sh` above for a
foreground-only installation, then run `abele-node start` yourself.
See [installer options and the manual source path](docs/install.md).

With `$HOME/.local/bin` on your PATH:

```sh
abele-node token create desktop
abele-node status
abele-node doctor
```

The token command prints an `installation_id` and a new `token` **once**. Enroll the
plugin with `ws://127.0.0.1:7777/channel`, that installation ID/token, and the reported
`node_id` where requested. Use device-local secret storage, never synced settings.
See [installation](docs/install.md) for exact configuration, service examples,
upgrades, backups and troubleshooting. A missing/incompatible CLI does not prevent
startup or fake-provider use.

## Quick start: Docker

Docker is an optional isolated runtime, not a way to reuse your host's macOS CLI.
The image contains Node, Git, the daemon and SDK resources, **no external provider
binary or credentials**.
From this checkout:

```sh
docker compose -f docker-compose.example.yml up -d --build
docker compose -f docker-compose.example.yml exec abele-node \
  node packages/node-daemon/dist/cli.js status
docker compose -f docker-compose.example.yml exec abele-node \
  node packages/node-daemon/dist/cli.js token create desktop
```

The default published port is only `127.0.0.1:7777`. State and managed workspaces
have separate persistent volumes. For released images, use `up -d --no-build`
instead (after an image has been published). Read [Docker deployment](docs/docker.md)
before mounting repositories, CLIs or credentials. This example provides local-token
access only; it does not configure the paired listener or Tailscale Serve.

## Security and threat model

Keep both daemon listeners on loopback. There is deliberately no native bind-address
option. Never expose the local-token listener through a LAN listener, tunnel or
reverse proxy. Remote control uses only the separately enabled paired backend through
tailnet-only Tailscale Serve, never Funnel; tailnet membership alone does not authorize
a device. See [remote access](docs/remote-access.md) before enabling it. TLS trusts
the local Serve process and PKI; this is not end-to-end encryption against a relay.
The Docker-only forwarder requires the loopback port binding in the example. It
preserves Host, Origin and authentication checks, but peers on its container network
can reach it: that network must remain private.

Tokens grant control of this user's node, projects and sessions; they are not
per-project permissions. State is private to the OS user but **not encrypted at
rest**. Agent tools run as that user and can access more than their worktree.
Repository trust, permission receipts and filesystem checks do not replace an OS
sandbox. See the retained [security/threat model](docs/security.md) for admission,
revocation, Git/file boundaries, configuration policy, cleanup and durability limits.

## Development

```sh
npm ci --ignore-scripts
npm run types
npm test                       # builds first; fake SDK/CLI, at most two workers
npm run test:installer         # production tarball + local HTTP server; temporary HOMEs
npm run build
npm run format:check
node --test probes/approval-mcp.test.mjs probes/echo.test.mjs
node --test probes/debug-*.test.mjs # fake DAP/process tests; no adapter installation
```

`.npmrc` enables `legacy-peer-deps` to work around an npm 10 optional-peer resolver
failure with the pinned Vitest toolchain. Dependencies are exact pins recorded in
`deps.yaml`; install scripts are not needed. Manual provider probes and
`acceptance:stage3` consume model quota and are **not** part of CI or normal tests.
The public probes provide generic CLI/SDK examples, synthetic debugger fixtures and
model-free MCP/transport/lifecycle tests; generated research evidence stays local.
`npm run acceptance:stage4b` verifies editing/restart/restore offline with fake providers.
`npm run acceptance:pi` verifies SDK sessions/restart/cleanup with a fake SDK host;
explicit live acceptance consumes model quota and is not a CI operation.
`npm run acceptance:remote` verifies paired-device flows offline without changing
live Tailscale configuration. It does not establish real mobile interoperability.
`npm run acceptance:delegation` verifies offline delegated completion/replay, mailbox
isolation, human transcript access and creation retries using fake providers.
The [debugger scratch installer](docs/debug-probe.md#manual-real-adapter-check) is
manual-only, excluded from CI and from the published image.

The workspace packages separate protocol, channel server/client, node core/client,
daemon and Claude/pi adapters. `@abele/node-client` requires a device-local transactional
`ClientStore`; `MemoryClientStore` is only for tests. Paired access also requires a
transactional, device-local `DeviceKeyStore`; private keys must not be synced. The
libraries are source/local workspace artifacts (currently version `0.0.0`), not
published npm packages.

## License

[GPL-3.0-only](LICENSE), the same license family as the Abele Obsidian plugin.
Provider CLIs and services have their own licenses and terms.
