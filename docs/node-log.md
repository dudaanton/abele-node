# Node log API

Capability **`node_log_v1`** advertises the read-only **`node.log.v1.tail`** method.
The plugin's owner UI can call it through the authenticated channel; no provider
session, execution permission, approval, mutation operation ID or background
subscription is needed. Existing methods and event/response envelopes are unchanged.

```ts
// All fields are optional.
await client.request('node.log.v1.tail', {
  limit: 200, // default 200, integer 1–1000
  since: '2026-10-22T10:00:00Z', // ISO 8601 with Z or an explicit UTC offset
  level: 'warnings_and_errors', // 'all' (default) | 'warnings_and_errors'
})
```

The response is:

```ts
{
  lines: [{
    time: '2026-10-22T10:00:02.000Z', // UTC ISO timestamp, or null if unknown
    level: 'error',                   // debug | info | warn | error | unknown
    text: '...',                      // redacted text; JSON may be normalized
    source: 'stderr',                 // stdout | stderr
  }],
  truncated: false,
  reason?: 'logs_missing' | 'logs_unavailable' | 'empty' | 'no_matching_lines',
  files: [
    { source: 'stdout', truncated: false, reason?: 'missing' | 'unavailable' | 'rotated' | 'empty' },
    { source: 'stderr', truncated: false, reason?: 'missing' | 'unavailable' | 'rotated' | 'empty' },
  ],
}
```

`NodeLogMethodSchemas`, `NodeLogTailSchema` and type `NodeLogTail` are exported by
`@abele/node-protocol`. The method is absent from the mutation set and writes
neither logs nor receipts. Unknown parameters, including file/directory selectors,
are rejected with `invalid_params`.

Only `logs/stdout.log` and `logs/stderr.log` beneath the running node's physically
pinned state directory are read. A configured `--state-dir` is honored; the API
never falls back to another installation's default directory. It does not create
missing directories/files, follow directory or file symlinks, accept hardlinked
or non-regular files, enumerate arbitrary paths, or read rotated archives.

Each call reopens the active files, so rename-and-recreate rotation is picked up
on the next call. A missing file is reported in `files`; the other stream remains
available. A missing log directory or two absent active files returns an empty
`lines` array with `reason: "logs_missing"`. An empty available log returns `empty`;
unsafe/unreadable files or detected rotation races return `logs_unavailable` when
there are no lines from the other stream. No raw filesystem error/path is exposed.

Disk logs are normally captured by the macOS installer/service. Foreground output
can go only to a terminal, and systemd normally uses its journal. This API does
not invoke `journalctl` or collect another source when disk logs are absent.

Each file contributes at most its last 256 KiB. Leading partial lines and trailing
lines still being written are withheld, and lines over 8192 bytes after redaction
are omitted. The combined response has a 192 KiB line-data budget, below the
channel record limit. `truncated` reports discarded data from byte/line/response
bounds or from the requested line count. Filters operate on this bounded window,
before selecting the final `limit` lines; the API does not scan unlimited history
to satisfy a filter. Poll for a new snapshot rather than treating the tail as a
lossless cursor.

JSON `time`/`timestamp`/`ts` timestamps (numeric epoch milliseconds or date strings)
and leading ISO timestamps are recognized. JSON `level`/`severity`, Pino numeric
levels and plain severity labels are normalized; warning becomes `warn`, and
fatal/critical become `error`. Unrecognized values remain null/unknown. Timestamped
lines are merged chronologically, followed by untimed lines in stable file order
(stdout, then stderr). Since-time filtering is inclusive and excludes untimed
lines. The warnings/errors filter excludes unknown severity.

Authorization uses the node's existing owner model: authenticated local-token
installations and confirmed paired devices currently have owner authority.
Unauthenticated identities, bare grant/agent identifiers, unsupported authority
profiles, pending devices and revoked installations are refused. Authority is
checked again when publishing the response, so revocation also fences queued data.
Do not expose this owner diagnostics endpoint as a delegated/model tool.

Redaction happens on the node before any response. It reuses existing HTTP secret
masking (including percent/form encodings) and Git URL credential stripping, and
masks credential-labelled JSON/console values, Authorization/proxy authorization,
cookies/API-key headers, pairing/token/password/key fields, private-key blocks,
recognizable provider keys, JWTs and long opaque credential-shaped strings.
Sensitive environment values and credential values recognized within either
bounded stream are also masked in echoes. Short labelled values are masked even
when too short for general echo matching. A private-key end marker without its
opening marker conservatively hides the snapshot prefix. An unstructured multiline
credential container hides its snapshot suffix; deep or excessive credential
records may be replaced wholesale. Conservative masking can hide
non-secret hashes/identifiers too; it cannot identify arbitrary short unlabelled
secrets it has never observed. Render returned text as text, never HTML.
