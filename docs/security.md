# Security and threat model

AbeleNode is an **early, single-user daemon with loopback-only listeners**, not a
multi-user service or OS sandbox. Local-token control stays loopback-only. Remote
control is available through separately enabled paired WSS with Tailscale Serve in
front of a separate paired backend, never by exposing the local-token listener.
The plugin pairing UI is not yet released. See [remote access](remote-access.md).

## Local admission and authority

The native local-token listener binds only `127.0.0.1`. Admission accepts the exact listener's
`127.0.0.1:PORT` Host and loopback peer, with either no Origin (native clients) or
`app://obsidian.md` (desktop Obsidian). Other browser origins, URL queries and
nonbinary application records are refused. The local-token client accepts only explicit
`ws://127.0.0.1:PORT/channel`, with no hostname aliases, credentials, fragments,
redirects, LAN fallback or alternate security profile.

Each installation receives an independent random 256-bit token, shown once;
only SHA-256 token hashes are stored. Token management uses a protected Unix
socket while running and never opens another database owner. The ready endpoint is
published as `control_socket` in the protected runtime lock, in a short random
`0700` temporary directory with a `0600` socket (at most 100 bytes to avoid macOS
Unix-path truncation). Normal shutdown removes it; crash orphan cleanup is not
automated. Older running daemons retain the legacy state-path fallback. List does not reveal
hashes/secrets. Revocation is checked at connection admission, mutations, receipt
replay, queued execution and publication, including when queued records actually
leave the scheduler. Tokens confer **node-wide** authority, not project-scoped ACLs.
A stolen token can control the node's projects/sessions, so store it separately in
a device-local secret adapter, not URLs, cookies, synced settings or notes.

A client store pins node and installation identities before outbox replay. New
credentials require a fresh installation namespace. Production plugin persistence
must be transactional/device-local; `MemoryClientStore` is only a simulation.

Docker adds a container-only TCP forwarder on port 7778 to reach the native
loopback listener. It does not rewrite Host/Origin/token bytes. The host binding
**must** remain `127.0.0.1:7777:7778`. Container-network peers can reach the
forwarder and appear loopback-local to the daemon, so the network must contain no
untrusted siblings. It is not a remote-access mechanism; do not use host
networking, LAN publishing, tunnels or a public reverse proxy. Docker port
publishing protects the host exposure, not admission against other containers.

## Paired remote admission

Both node listeners remain on loopback. The optional paired listener accepts only
`paired-wss-v1`; it refuses `local-token-v1` even from loopback. Tailscale Serve
provides tailnet-only WSS in front of that backend, never Funnel. Its manager reads
existing configuration before changes, refuses foreign mappings and local-token
exposure, and only removes its own confirmed, unchanged mapping. Uncertain CLI
results leave pending intent, not deletion rights. Starting/stopping the node does
not change Serve configuration.

Tailnet membership alone grants no application authority. Invitations bind endpoint,
node identity, node-key fingerprint, expiry and a single-use secret. A claim requires
fresh device-key possession but grants no access until a local owner confirms the
exact enrolling key. Private keys stay device-local. Every connection verifies the
pinned node application key and a fresh, expiring, connection-bound device proof
using WebCrypto ECDSA P-256. The signed transcript binds node, installation and
protocol; client freshness uses its nonce and a local monotonic deadline, not
synchronized wall clocks. Changed node keys require explicit owner-verified recovery.

The configured Host and path must match exactly. Origins are an explicit allowlist;
missing/null Origin needs its own client policy and device authentication. Forwarded
addresses, hosts and Tailscale identity headers are not authorization. Revocation
fences mutations, receipt replay, prompt answers, artifact reads and queued/live
publication; already-sent bytes cannot be recalled. Explicit migration preserves
principal-scoped receipts, session identities and cursors. These are node-wide owner
grants, not mixed-trust or per-project permissions.

TLS protects records while trusting the local node/Serve process, PKI and endpoint
devices. Application-key proof is not TLS certificate pinning or protection from a
malicious TLS-terminating proxy. No external relay or end-to-end channel is provided.
Effective network policy, certificate forwarding and device key persistence require
deployment verification. Full prerequisites, pairing, revocation and recovery are
in [remote access](remote-access.md).

## Local storage and durability

State directories are `0700`; database, WAL/SHM, lock, credential socket, installer
plist and logs are `0600`. Singleton ownership uses an atomic exclusive lock:
only a positively dead PID permits reclaim. Corrupt lock evidence requires
operator inspection. State is private to the OS user, **not encrypted at rest**.
The same OS user (including its agents) can read/change it directly.

SQLite uses plain SQL, versioned `PRAGMA user_version` migrations, WAL, foreign
keys, `synchronous=FULL` and a 3-second busy timeout. Future schema versions are
refused. Preconditions, state, sequences, journal events and principal-scoped
receipts commit together before response/publication. Reusing the same principal,
operation ID and canonical method/body recovers the original receipt; a changed
body returns `idempotency_mismatch`. A lost response means `outcome_unknown`, not
permission to repeat shell effects with a new operation. Internal/storage failures
pause execution/approvals instead of dropping history or inventing rejection after
possible commit. Prompts distinguish committed resolution from provider delivery.

History, receipts, snapshots and content have **no automatic expiry**. Logs are not
rotated. Disk-full, sustained-load, backup/restore and operational hardening remain
important deployment concerns. Provider-native resume files are separate provider-owned
state and need preservation; pi native files live in the protected node state. Stopped backups must preserve SQLite/WAL,
Git metadata and worktrees consistently. Journal/raw provider records, tool inputs,
file contents and logs can contain secrets; avoid putting secrets into prompts and
redact diagnostics before sharing.

## Repository trust and Git boundaries

Registration canonicalizes paths and records explicit `trusted`/`untrusted` trust.
A real provider requires a trusted Git project and its ready, exclusively leased
managed worktree. Plain-folder registration is browsing-only; the node does not
silently initialize/copy it. Trust changes are not currently supported.

Git uses typed argv through `/usr/bin/git`, no shell, bounded output and subprocess
deadlines. Operations disable hooks, fsmonitor, pagers, signature display/signing,
external diff/textconv and configured checkout/clean filters **even for trusted
projects**. Invocations ignore system/global Git config and pin supported signature
programs to `/usr/bin/false`; commit/log/blob views also disable signature display.
`diff.submodule=short` and `GIT_NO_LAZY_FETCH=1` are defensive overrides, not an OS
sandbox. Views can differ from an external filter-aware Git client.

This API boundary is against the client and untrusted repository content, **not**
the owner's repository-local `.git/config` or submodule configuration, which a
cloned repository cannot ship. Owner-configured promisor remotes and submodule
filter programs are outside this threat model.

Jobs reserve durable intent before Git effects; a SQLite commit does not pretend
to atomically cover Git. Restart reconciles intent against worktrees/branches;
ambiguous effects become `needs_attention`, preserve evidence and need inspection.
There is no blind retry or automatic repair. Removal rechecks lease, canonical
managed path, Git root/common-directory/branch binding, tracked dirt and untracked
**and ignored** files at acceptance and execution, then uses Git without force.
Roots, symlink replacements and unmanaged paths are refused; no recursive
filesystem deletion is used. Branches are retained. These same-user checks cannot
guarantee safety against a writer racing the last check; stop external writers
before removal.

## File browsing, editing and review

File API callers supply workspace-relative paths, not arbitrary filesystem paths.
Absolute paths, traversal and symlink reads are refused. Component/symlink/realpath
checks, final-component `O_NOFOLLOW`, after-open `fstat` device/inode comparison
against fresh `lstat`, and before/after metadata/path checks reject observed
replacements/changes before returning content. These are portable Node checks,
**not atomic `openat` traversal**.

Same-user local processes are outside the boundary: they already have direct
access to the user's files and can interleave parent swaps/restorations with every
pathname check. A fully interleaved race remains an expected-failing test, not a
claimed prevention. Provider shell tools are not restricted by this read API.
A concurrent same-user process swapping a checked parent directory for a symlink
between durable intent and exclusive file creation is out of scope: `O_NOFOLLOW`
protects the final component, not atomic parent traversal. Portable Node checks
provide no native `openat` containment.

Content/diff identities authorize reads against their workspace. Retained bytes
survive restart/external edits. A Git patch captures what Git observed, not an
atomic snapshot of a concurrently changing filesystem or attribution to a turn.
Review anchors validate against retained hunks/session workspace. Valid saved
context may be accepted conservatively with `stale: true`; it is never silently
retargeted. Authority/storage failures still fail closed.

[Bounded UTF-8 writes and explicit restore](editing.md) use content preconditions,
installation-scoped receipts and private pre-write recovery copies.
Existing files are written in place on a pinned descriptor; their inode/permissions
are not replaced. There is no filesystem CAS or exclusion of external writers.
Crashes can leave partial bytes; durable unfinished intents settle unknown and
are never automatically replayed. Recovery copies live outside source checkouts,
with a per-workspace limit of 32 copies / 16 MiB and oldest-first eviction. Receipts
can outlive a copy. Workspace authorization applies to recovery reads/restores.
State backups must preserve these copies too. Legacy recovery/mutation evidence
requiring inspection is refused at migration rather than silently imported/deleted.

The [experimental debugger probe](debug-probe.md) is not a production control API.
DAP/CDP and evaluate can execute arbitrary target code; Python variable expansion
can invoke properties. Synthetic reverse-request acceptance is not authorization
policy. Adapters stay scratch-only and the js-debug pin has unresolved upstream
advisories. Device automation and generated research evidence stay local; do not
expose an inspector/DAP/CDP endpoint or adopt the probe as a sandbox.

## Claude settings, approvals and execution

Production defaults to **inherited user-only** configuration (`--setting-sources
user`). User allow rules may authorize tools without a node prompt. Such results
are labeled **"Allowed by your Claude settings"**, not node approvals; exact matched
rules are not exposed by the CLI. Repository `.claude/settings.json` and
`.claude/settings.local.json` do not self-authorize by default. Explicit owner
opt-in on a trusted project enables `user,project,local` for subsequent inherited
turns; it is refused while a run is active/unconfirmed. `isolated` uses empty
user/project/local sources, strict MCP config, disabled slash commands and requested
hook disabling. **Managed settings and other CLI resources may still apply.**
`run.started` records requested configuration; `claude.init` records what the CLI
reports. The node does not claim a complete hidden hook/policy inventory.

The versioned stdio MCP bridge uses a per-run `0600` Unix socket in a `0700`
directory and a random capability bound to session/run/generation. Tool ID, name
and original JSON arguments must match an observed call before approval. First
valid committed answer wins; expiry, mismatch and bridge/IPC loss deny. Client
disconnection leaves a prompt pending until expiry. Grants have a separate,
atomically reserved **single-use** delivery fact; replay/concurrent bridge requests
cannot reuse them. The bridge returns allow only after committed delivery is
confirmed. That is bridge receipt evidence, **not proof a tool executed**. There
are no bypass flags, argument editing, persistent always-allow decisions or Claude
credential readers. Unsupported questions deny explicitly.

Inputs execute serially, one invocation per durable input. Follow-ups queue;
subsequent turns use explicit stored `--resume UUID`, never cwd-wide `--continue`.
`input.delivered` requires assistant activity, not a stdin write. Completion
requires a valid non-error provider result and confirmed cleanup; exit 0 alone is
insufficient. Completion is not human acceptance or proof every tool succeeded.
Interrupt/crash/uncertain delivery is `delivery_unknown` and is never automatically
replayed. Late records remain marked late without upgrading the outcome.

An independent worker process group is journaled before launching CLI/repository
customizations; CLI PID evidence commits before stdin delivery. IPC loss triggers
cleanup. Restart reconciles owned groups/observed descendants before another run.
TERM is followed by daemon-owned whole-group SIGKILL escalation, even for a stopped
worker. Cleanup must be positively confirmed; failed/timed-out probes mean unknown,
not gone. Unconfirmed groups remain tracked and fence execution/detachment until
inspection/retried cleanup. Immutable process start/group evidence guards signals.
Background subprocesses terminate at invocation settlement. This is **not an OS
sandbox or a guarantee against malicious group escapes/reparenting**. Agent tools
still run as the daemon user, can access that user's other files/credentials and
can make network requests. A container restricts what is mounted, not what an
agent can do with granted mounts, credentials or network access.

Only CLI versions 2.1.285/2.1.291 with required flags are enabled. Compatibility
checks run bounded version/help commands; they do not verify login or quota. New
versions require real permission/resume acceptance, never a bypass fallback.
Automatic tests use fake executables, including version/help. Live provider probes
are explicit, quota-consuming manual operations, not CI tests.

## Pi SDK approvals and execution

The [pi SDK provider](pi.md) uses the same authorization, queue, journal and
single-use approval machinery as other sessions. Tools require exact human grants;
missing, expired, interrupted or unconfirmed answers deny. Model/authentication
configuration is resolved only inside the worker; keys, headers, request payloads
and environment are not exported through the client protocol. Feature availability
is capability-gated and is not proof of model login or endpoint availability.

Trusted project admission precedes executable resources. Isolated mode prevents
SYSTEM/APPEND_SYSTEM discovery and reads as well as other inherited resources; it
does not bypass approvals. Trusted extensions are full same-user code, not sandboxed.
Unsupported custom UI and swallowed command/shutdown errors fail the turn rather
than turning handled preflight into success. SDK-native diagnostic files remain
protected local state and should be reviewed before sharing.

Built-in bash uses an owned group anchor, with evidence committed before shell
execution. Anchors outlive fast-exiting shells so ordinary background jobs cannot
escape descendant-poll gaps. Group absence and recovery-record removal are verified
before release acknowledgement; worker/anchor IPC loss also triggers independent
cleanup. Explicit group escapes and arbitrary trusted-extension subprocess behavior
remain outside the same-user boundary. Native child IDs are not node session IDs.

## Resource bounds and remaining gates

Binary UTF-8 JSON records are bounded: 256 KiB records, 16 KiB first auth record,
10-second admission deadline, bounded replay pages/outbound queues, 2 MiB
unacknowledged events per connection, 32 connections and 256 subscriptions per
connection. Heartbeat/dead timers are 25/75 seconds. Slow consumers disconnect and
replay later without blocking workers. Control replies outrank artifact traffic.
Large payloads use authorized bounded artifact/content reads; oversized outputs
fail explicitly rather than silently truncating snapshots. Session execution and
provisioning each have bounded concurrency.

Paired remote admission has offline coverage; real Tailscale forwarding/certificates,
effective access policy, device-key persistence and off-network mobile operation
remain deployment checks. An external relay or end-to-end encrypted channel is not
provided. Comprehensive provider child/thinking support, login/logout
service lifecycle, sustained load, log rotation and full disk/backup recovery are
not promised by these tests. Desktop Origin tests do not establish supported mobile
operation. See [remote access](remote-access.md) for the paired profile's limits.
