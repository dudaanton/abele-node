# Docker deployment

Native [installation](install.md) is the main path: it uses your computer's existing
CLI login, repositories and provider resume files. Docker is optional and introduces
Linux binaries, container paths and separate credentials. Windows is untested.

## Image contents and startup

The multi-stage `Dockerfile` pins the Node 22.23.2 Debian slim multi-platform index
by digest, installs Git, `procps` and `tini`, compiles the workspaces, and retains
production dependencies. Runtime runs as non-root `node` (UID/GID 1000).
**No Claude Code, pi or other provider binary, credentials, Git history, tests or
probe evidence is bundled.** Provider licenses/terms apply separately.

From the source checkout:

```sh
docker build -t abele-node:local .
docker compose -f docker-compose.example.yml up -d --build
docker compose -f docker-compose.example.yml ps
docker compose -f docker-compose.example.yml logs --tail=50 abele-node
docker compose -f docker-compose.example.yml exec abele-node \
  node packages/node-daemon/dist/cli.js status
docker compose -f docker-compose.example.yml exec abele-node \
  node packages/node-daemon/dist/cli.js doctor
```

The example builds locally and names the image
`ghcr.io/dudaanton/abele-node:0.1.0`. Once a release exists, use
`docker compose -f docker-compose.example.yml pull` and `up -d --no-build`
to use the registry image instead. Prefer version tags (or a release image digest)
over `latest` for upgrades. Tag pushes matching `vX.Y.Z` publish both Linux amd64
and arm64 images to GHCR; the tag must match the root package version.

The healthcheck reads the live runtime and opens/closes a WebSocket upgrade
through the container forwarder. It needs no provider CLI/token and grants no
session authority. It is daemon/network liveness, **not provider availability**.
`status` alone is only a local runtime/PID report.

## Why two ports?

The daemon still binds **127.0.0.1:7777 inside the container**. Docker bridge DNAT
cannot reach a loopback-only listener directly. The container entrypoint starts
that daemon plus a bounded TCP forwarder on port **7778**, preserving all Host,
Origin and application bytes. The example maps:

```yaml
ports:
  - '127.0.0.1:7777:7778'
```

Enroll the desktop plugin at **`ws://127.0.0.1:7777/channel`**, just like native
installation. Keep host port 7777: the daemon's Host admission expects that port.
Do not publish `7778:7778`, use `localhost` aliases, rewrite headers, attach
untrusted sibling containers, expose on a LAN, or use host networking. Other peers
on the container network can reach the forwarder and appear loopback-local, though
they still need a token. This is a container deployment workaround, **not the
planned remote channel**. The example has a dedicated network, drops capabilities
and enables `no-new-privileges`; it does not prevent provider network access.

## State, workspaces and projects

The example has persistent named volumes:

| Volume/path                                    | Contents                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `state` → `/home/node/.local/state/abele-node` | SQLite/WAL, identity, token hashes, receipts, journals, artifacts, file-recovery copies, lock |
| `workspaces` → `/workspaces`                   | Node-owned managed Git worktrees; configured/persisted on first start                         |
| Optional bind `/projects`                      | Your original Git checkouts, mounted explicitly by you                                        |

The private token-management socket is ephemeral: `daemon.lock.control_socket`
points into a short random temporary directory, removed on normal shutdown, not
inside the state volume. New containers create new endpoints; do not mount or
hardcode the socket path. Protected [file-edit recovery copies](editing.md) stay
in the state volume and share its backup/security requirements.

The experimental [debugger probe](debug-probe.md) is source-only tooling: neither
its scratch installer nor its adapters/fixtures are copied into this image.

Named volumes initialize with the image's UID/mode. For bind mounts, prepare
ownership for UID/GID 1000 and private state mode `0700`; do not solve errors by
running root or `chmod 777`. On Linux host files may need an explicit ownership
plan. Repository mounts must be writable for Git branch/worktree metadata, even
though the original checkout is not edited by the daemon. If Git refuses dubious
ownership, align ownership instead of globally trusting every repository.

Mount only the projects you want the agent to access, for example:

```yaml
volumes:
  - ./projects:/projects
```

Register **container paths**, e.g. `/projects/my-project`, through the client/plugin.
A host path is not a path inside the container. Prefer a repository cloned inside
that mounted directory; host-created worktree `.git` pointers may refer to host-only
absolute paths. Submodules and linked worktrees can need additional Git common
metadata mounts. Keep repository and managed-worktree paths stable across upgrades;
Git worktree metadata and the node's durable provenance refer to absolute paths.
Do not share a live state volume with a native daemon or a second container.

## Enroll and inspect

```sh
docker compose -f docker-compose.example.yml exec abele-node \
  node packages/node-daemon/dist/cli.js token create desktop
docker compose -f docker-compose.example.yml exec abele-node \
  node packages/node-daemon/dist/cli.js token list
# Replace INSTALLATION_ID with the returned installation ID when revoking:
docker compose -f docker-compose.example.yml exec abele-node \
  node packages/node-daemon/dist/cli.js token revoke INSTALLATION_ID
```

The new token is shown once. Enroll with endpoint, installation ID/token and the
reported node identity where requested; see [installation](install.md#enroll-the-abele-plugin).
Secrets/client persistence must remain device-local. Health and fake sessions work
without any provider. Real sessions require a trusted Git project, a provisioned
managed workspace and a compatible authenticated provider CLI.

## Add your own Claude Code CLI

The published image intentionally omits provider binaries. Install/authenticate
according to the provider's official instructions and terms. The daemon only
enables **2.1.285/2.1.291**; newer versions are gated. `doctor` checks version/flags,
not login/quota. pi execution is not yet implemented even if you supply pi.

Two approaches, both under **your** control:

### Extend the image privately

Obtain a Linux CLI binary for the intended architecture through an authorized
provider installation. Build your own derived image; do not redistribute the
provider binary without permission:

```dockerfile
FROM ghcr.io/dudaanton/abele-node:0.1.0
# ./provider/claude must be a compatible Linux binary, not a macOS executable.
COPY --chown=node:node --chmod=0555 provider/claude /opt/provider/claude
ENV ABELE_CLAUDE_PATH=/opt/provider/claude
```

Build per target architecture (or provide the corresponding binary for each
`TARGETARCH`). This example copies a user-supplied standalone binary; if your CLI
is a script/npm installation, provide its complete runtime/dependencies too.
Do not put credentials in `COPY`, build args, image layers or published registries.

Set the Compose service to your own image and remove/change its `build` section.
A sample local build is `docker build -f Dockerfile.provider -t my-abele-node .`.
Use a separate Docker build context containing only the derived Dockerfile and
provider files; this repository's allowlisted `.dockerignore` deliberately excludes
arbitrary provider/credential directories.

### Mount a user-installed CLI

Mount a compatible, executable Linux installation read-only:

```yaml
volumes:
  - ./provider:/opt/provider:ro
environment:
  ABELE_CLAUDE_PATH: /opt/provider/claude
```

Mount the **whole** installation if symlinks/dependencies require it, and make sure
resolved paths exist inside the container. A macOS binary or a script with a
host-only interpreter/shebang will not work. Match amd64/arm64 to the image.
The binary is resolved/pinned at daemon startup; restart after changing it.

### Credentials and native resume files

Authenticate inside the container using your supplied CLI and its official login
flow, with `HOME=/home/node`, or mount a **dedicated** provider configuration/state
directory, for example:

```yaml
volumes:
  - ./claude-home:/home/node/.claude
  # If your CLI version uses this separate config file, preserve it as well:
  # - ./claude-config.json:/home/node/.claude.json
```

These are CLI-owned examples, not a guarantee of its storage format. A macOS
Keychain login may not be portable; authenticate for the Linux runtime instead.
Keep provider state private and writable where the CLI needs token refresh/native
session persistence. Back it up separately from the node volume. Do not mount your
whole home directory or Docker socket. Never paste secrets into Compose, tracked
`.env` files, image layers or reports. Anyone controlling the daemon/agent with
access to this credential mount can misuse it; a container is not protection from
that agent. A writable mount also lets the agent modify those files.

Container environment options: `ABELE_CLAUDE_PATH`,
`ABELE_CLAUDE_PROFILE` (`inherited` default or `isolated`), `ABELE_CLAUDE_BUDGET`
(`0.35`), `ABELE_CLAUDE_DEADLINE_MS` (`120000`), and
`ABELE_PERMISSION_TTL_MS` (`60000`). The default model is Haiku. Default inherited
configuration preserves user permission rules; repository permission sources need
explicit trusted-project opt-in. Read [security](security.md) before changing it.

## Stop, upgrade and remove

```sh
docker compose -f docker-compose.example.yml down
```

This stops/reaps the daemon and preserves named volumes. Do not use `cli.js stop`
as the primary container shutdown method: the forwarder/entrypoint and restart
policy belong to Compose. The 45-second grace period allows cleanup; inspect any
unconfirmed runs before restarting. Logs go to Docker stdout/stderr; configure your
Docker engine's log rotation. Durable session/provider evidence is in SQLite.

For upgrades, stop and back up state, provider files, original repositories and
managed worktrees consistently. Update the image version/digest, pull/build, then
start and inspect `status`, `doctor` and health. Schema downgrades require a stopped
pre-upgrade backup. Do not change mount paths/UID casually.

`down --volumes` **destroys node state and managed-worktree volumes**. Preserve
changes and Git metadata first; original project branches/worktree registrations
may remain and require explicit inspection. There is no automatic worktree repair.

## Troubleshooting

- Port in use: stop the native daemon or other owner. This image expects host port
  7777; choosing another published port will fail Host admission.
- Unhealthy: inspect `logs`, state-volume permissions, disk space and daemon
  singleton ownership. Do not delete a corrupt lock without inspecting ownership.
- CLI unavailable: verify Linux architecture, shebang/dependencies, symlinks,
  executable mode, `ABELE_CLAUDE_PATH` and pinned version. Startup itself can be
  healthy while provider execution is unavailable.
- Git common directory missing / dubious ownership: check container-visible paths
  and writable metadata mounts; do not blindly disable Git ownership checks.
- Lost native context: persist the CLI's resume directory/config separately. A
  persisted node native-session ID cannot restore deleted provider transcripts.

See [security](security.md) for trust, same-user filesystem races, approval semantics
and process-group limits.
