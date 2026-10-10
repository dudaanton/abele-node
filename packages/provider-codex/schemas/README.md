# Codex protocol pins

The stable and experimental manifests fingerprint the full exported TypeScript
schema closure from the Codex 0.160.1 generator (734 and 875 files respectively).
The root namespace includes requests, notifications, RPC results and native
approval/question responses; parameter-only entry points are not sufficient.
Doctor regenerates both closures and rejects any changed or missing dependency.

Source: https://github.com/openai/codex/tree/rust-v0.160.1/codex-rs/app-server-protocol/schema/typescript

The compressed deterministic test recording in
`tests/fixtures/codex-0.160.1-schemas.json.gz` contains those generated files. They
are generated from OpenAI Codex, copyright OpenAI, licensed under Apache-2.0:
https://github.com/openai/codex/blob/rust-v0.160.1/LICENSE
No authentication, configuration, sessions or model output is included.
