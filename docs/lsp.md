# Language servers on the node

Install servers privately, without sudo or global npm installs:

```sh
abele-node lsp install typescript eslint
abele-node lsp install --popular
abele-node lsp status
abele-node lsp status --json
```

`javascript` is an alias for `typescript`. Supported languages are TypeScript/JavaScript,
Python, Rust, Go, JSON, YAML, CSS, HTML, Bash, and ESLint diagnostics. Go installation is
skipped with an explanation when Go is absent. Rust binaries support macOS and Linux on
arm64 and x64. All commands accept `--state-dir`.

Discovery checks the node's private installation first, then PATH. Status includes the
executable, its reported version (or `unknown` if unsupported), and found/missing state.
ESLint status also checks the current project: its own `node_modules/eslint` and configuration
are required. Installing the ESLint server does not install ESLint into a project or change
its configuration. Missing project ESLint does not prevent TypeScript features.

Private npm installs use `--ignore-scripts`, exact versions, and separate prefixes inside
the node state folder. Pins: typescript-language-server 4.3.4, TypeScript 5.9.3, pyright
1.1.396, vscode-langservers-extracted 4.10.0 (ESLint/JSON/CSS/HTML), yaml-language-server
1.17.0, bash-language-server 5.4.3. Go uses `gopls@v0.17.1`. Rust uses the rust-analyzer
2025-02-10 release; compressed binaries must match the SHA-256 hashes recorded in the node.
These are optional runtime installations, not new node package dependencies.

A server starts when a supported document opens or a language query needs it. Devices and
sessions share one process per server and canonical root; ESLint runs alongside TypeScript.
Servers stop after three minutes without document activity or queries, even if a document
was left open by a disconnected client. A subsequent query reopens it from disk. Configure
`ABELE_LSP_IDLE_MS` and `ABELE_LSP_MEMORY_MB` in the node environment (defaults: 180000 and
384). There are at most 16 server processes and 64 documents per server, with a 512 KiB file
limit. JS heaps and TypeScript worker heaps are limited; total process-tree RSS is checked
every five seconds. Shutdown stops the server's process group, including child workers.
A crash restarts once and reopens documents; a second crash is reported through `lsp.status`.
Idle eviction resets that lifecycle on the next open.

Protocol capability `lsp_v1` exposes versioned `lsp.v1.status`, `install`, `open`, `close`,
`definition`, `hover`, `references`, `symbols`, `diagnostics`, and `cancel`. Document methods
take exactly one of `workspace_id` or `worktree_id`, and a relative `path`. Positions and
ranges use zero-based UTF-16 offsets. `open` accepts optional full text and a monotonically
increasing version; call it again to update a document. Without text, it reads the current
file using the existing confined file API. Symlinks and traversal are rejected. Definitions
and references outside the root are omitted, including dependency definitions outside it.
Server-initiated workspace edits are refused.

Diagnostics are asynchronous pushes in the catalog stream (`lsp.diagnostics`) and a cached
per-file pull via `diagnostics`. Open the file first and listen for pushes to receive the
initial analysis; a pull immediately after open can still be empty. TypeScript and ESLint
results are merged, tagged with their server source, and bounded to 256 entries/64 KiB.
Other responses are bounded too. Each call can carry a `request_id`; `cancel` aborts that
installation's matching request. The typed `NodeClient.lsp` methods send cancellation for
an optional `AbortSignal`. Calls are online-only and are never automatically retried.

After an agent turn, the node refreshes open documents and files identified by edit tool
events, plus up to 64 changed source files reported by Git (including shell edits). In plain
folders, shell edits to unopened files need a client open/query first. Diagnostics also appear
as `session.update` notices in chats bound to that root. The run-bound `lsp` tool offers
definition, hover, references, and diagnostics through the existing tool bridge. Pi consumes
that bridge today; the Codex and ACP transports currently do not expose node MCP tools.
Claude receives diagnostics notices but no extra LSP tool.

Verification uses a fake stdio server, fake installation transports, confined node RPCs,
and a real TypeScript server acceptance check in a disposable HOME. Tests do not launch
subscription-backed agents or use the network.
