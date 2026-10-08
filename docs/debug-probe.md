# Experimental debugger probe

The scripts under `probes/debug-*` explore Debug Adapter Protocol (DAP) control of
**synthetic Node JavaScript/TypeScript and Python programs**. They are experimental
probe tooling, not a daemon debugger service, public RPC contract, Claude tool or
plugin debugger UI. No model inference is used. Device-specific automation, internal
research logs and generated run evidence are not part of the public source tree.

## What the probe exercises

- JS/TS through **js-debug 1.140.0**; Python through **debugpy 1.8.17**.
- Launch and existing-process attach, verified breakpoints, stack/scopes/variables,
  expression evaluation, stepping, exceptions, detach and owned-process termination.
- Source-mapped TS locations, including exact source/next-line checks after a step.
- DAP byte framing, fragmented UTF-8, out-of-order responses, event ordering,
  timeouts and reverse requests through a small probe client.
- Process-group cleanup on SIGINT/SIGTERM, early start/configuration errors, failed
  evidence writes and exited group leaders. Cleanup precedes evidence saving.

The real-adapter driver includes eight explicit fixture profiles. This does **not**
establish arbitrary VS Code configuration compatibility, multi-thread correctness,
worker/fork trees, conditional breakpoints, restart/recovery, source mismatch
protection, read-only inspection or production-safe shared debugger control.

There is no published Electron/Obsidian attachment implementation. A production
integration would need a reviewed bootstrap, authenticated/scoped target access,
source/build identity checks and a control host outside any paused target renderer.
Do not equate DAP feasibility with a safe application debugger or remote access.

## Offline tests (safe for CI)

```sh
node --test probes/debug-*.test.mjs
```

These use fake DAP streams, synthetic OS processes and installer-source assertions.
They do not install/start real adapters, touch an application or contact a model.
The installer test checks that managed-Python downloads remain disabled; it does
**not** execute the installer. Both ordinary CI and tag checks run these tests.

## Manual real-adapter check

The scratch installer is **never run in CI** and adapters are not bundled in the
published Docker image. Review its downloads, terms and known upstream advisories
before using it. Everything it installs is under `.scratch/adapters`; logs/results
are under `.scratch/evidence`, both ignored by Git and Docker.

Prerequisites: Node/npm, curl, tar, shasum, uv and an **already installed Python
3.12**. The current debugpy artifact is deliberately a macOS CPython 3.12 universal2
wheel, not a portable Linux/Windows installer. `UV_PYTHON_DOWNLOADS=never` and
`--no-python-downloads` prevent uv from installing an interpreter elsewhere.

`DEP_CHECK` is required: provide an executable for your own dependency-review
policy. The installer invokes it as `check npm NAME VERSION` or
`check pypi NAME VERSION`; successful reviews must exit zero. Its JSON stdout is
saved locally. No private infrastructure path or permissive default is supplied.

```sh
# Explicitly permit this pinned, synthetic experiment ONLY after reviewing findings.
# The adapter pin is NOT approved for production installation.
DEP_CHECK=/absolute/path/to/your/dependency-review \
  ABELE_B0_ALLOW_AUDITED_RELEASE=1 bash probes/debug-install.sh
node probes/debug-library-check.mjs
node probes/debug-real.mjs
node probes/debug-evidence.mjs
```

The installer checks downloaded SHA-256 hashes, exact npm pins and audit output.
It adds a scratch-only CommonJS package boundary for the official js-debug bundle;
it does not patch provider binaries or change production dependencies. Raw requests,
responses, capabilities, process output and the path-free summary stay local.
`debug-evidence.mjs` requires all eight real profiles to complete before writing
`.scratch/evidence/debug-probe-evidence.json`. Never publish raw logs automatically;
they can contain paths, evaluated values or credentials from an inappropriate target.

## Adapter pins and security gate

| Artifact                                                                            | Version / source                                      | Checksum / license                                                                                            |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| js-debug standalone                                                                 | 1.140.0, official `microsoft/vscode-js-debug` release | SHA-256 `27dab92937ec1ab35821ae955aac867544fe06a1b6307229049f2d789af10968`; MIT, bundled notices need review  |
| debugpy                                                                             | 1.8.17, PyPI macOS CPython 3.12 universal2 wheel      | SHA-256 `f14467edef672195c6f6b8e27ce5005313cb5d03c9239059bc7182b60c176e2d`; MIT, vendored notices need review |
| TypeScript                                                                          | 5.9.3, npm                                            | Lockfile integrity; Apache-2.0                                                                                |
| `@vscode/debugadapter`, `@vscode/debugadapter-testsupport`, `@vscode/debugprotocol` | 1.68.0, npm                                           | Lockfile integrity; MIT                                                                                       |

The js-debug upstream release lockfile has known advisories, including critical
`shell-quote` advisory **GHSA-pqg4-j6r4-53mv**. A checksum or MIT license is not proof
of safety; the standalone bundle has no verified complete SBOM here. The scratch
installer fails on audit findings unless the explicit experimental opt-in is set.
A clean scratch npm audit does not override findings in the upstream adapter graph.
**Production adoption requires a new audited pin or a verified build/SBOM.**

The probe comparison favors `@vscode/debugprotocol` for types and a node-owned
bounded transport for future implementation. `@vscode/debugadapter` is adapter-side;
`@vscode/debugadapter-testsupport` silently drops reverse requests and leaves
pending requests without the required lifetime contract. None has been added as a
production runtime dependency.

## Semantics and limits

- js-debug uses root and child DAP sessions; even a single Node target can require
  `startDebugging`, another DAP connection and the adapter's pending-target ID.
  TS terminal launch also uses `runInTerminal`. The synthetic probe accepts known
  fixture requests; production must authorize reverse requests before execution.
- debugpy start/configuration ordering differs: send launch/attach, configure,
  then await the start response. Observing start and configuration promises together
  prevents an early failure from leaving requests/waiters pending.
- Node inspector endpoints speak **CDP**, not DAP. Do not expose either protocol
  publicly or substitute it for the planned authenticated remote channel.
- Inspection/evaluation can execute code. JS/TS explicit getter evaluation changes
  fixture state; Python property expansion can change state even through `variables`.
  No unconditional “read-only inspection” security policy is established.
- Per-thread stopped/continued flags are retained. A single stop is not proof the
  whole program is paused. Refresh frame/variable handles after stepping.
- The process helper owns synthetic POSIX groups and uses bounded TERM/KILL/reaping.
  It is probe lifecycle support, not an OS sandbox or reviewed production supervisor.

Shared-command receipts, authorization, stop epochs, stale rejection, bounded
backpressure, adapter/node recovery, target ownership and source identity remain
future debugger-service work. An adapter reply alone is not proof of attaching to
an existing process; the real profiles explicitly compare target PIDs and verify
continued liveness after detach.
