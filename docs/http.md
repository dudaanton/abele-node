# Saved requests (http v1)

A project's saved HTTP requests live as files in the project, sending them goes out from the node,
and every send is kept beside them. The plugin draws them and resolves what only it knows (its
keys, its scripts); the node reads and writes the files and sends.

## Destination ownership and recording correlation

With `http_v1.transport_status`, `http.v1.send.status` accepts
`transport_only:true`. This reads the existing send's current network outcome
without waiting for adapter evaluation, recording drains or a paused target.
An answered/failed/timed-out network result is available before recording links
finish; `send.run.step` may therefore be absent. Body pages can be read once the
transport answered. Omit the option for the existing recording-aware completion
read. Poll the same send ID to obtain its final recording link; never resend or
cancel because a status observation timed out. History records the actual final
network outcome, not a failed status observation.

With `trace_v1.fixed_prefix_paging`, capture the first `trace.v1.run` response's
`run.steps`, then pass it as `through` on subsequent pages (with unchanged kind
filters). The node sorts and pages only that written prefix. Its `run.steps` stays
at that prefix count and `next` ends there, even if later exchanges have earlier
timestamps. A missing/truncated prefix fails with `trace_prefix_unavailable`.
Omitting `through` retains the live timeline behavior.

`trace_v1.bound_record_points` means that recording and HTTP instrumentation start
only after at least one enabled record point binds. Rejected or disabled points
alone do not start a run. Pending synchronization retains an existing recording;
when all its points are rejected or disabled, that recording ends.

Detect `http_v1.destination_owner` before using
`http.v1.destination({project_id, url})` with the fully resolved request URL. Its result is
`{debug_session_id: string | null, candidates: string[], reason}`. `reason` is `owned`,
`ambiguous`, `unobserved`, or `remote`. A unique owner requires an observed local listener,
the same project, a live debugger session and a matching OS process start identity. Discovery
uses OS reads, not application HTTP requests. Remote destinations and unverified process
identities are never assigned to the currently selected debugger by inference.
Only literal loopback addresses and `localhost` are attributed; other aliases/proxies stay
unassigned. More than 256 candidate sessions fails with `http_destination_too_many_sessions`.

For recording-aware routing, send with `route_by_destination:true`. The node repeats the
ownership lookup and selects that recording; an explicitly supplied, different
`debug_session_id` fails with `http_recording_owner_mismatch`. An unknown or ambiguous owner
fails with `http_destination_unobserved`. Without this opt-in, the existing explicit-session
send contract is unchanged. Listener ownership is a point-in-time observation, not proof
that a later request succeeds; captured incoming traffic still confirms recording association.

Detect `http_v1.recording_correlation` / `trace_v1.sent_observation_merge` and use the existing
`step_header:true` option when sending into a recording. It transmits the send's generated
`X-Abele-Step` identity. When exactly one captured incoming exchange carries that identity,
the saved-send result links to that captured row and the row is marked `sent:true`. The node
does not append another trace HTTP summary. The captured duration, values and chain are kept;
saved-request response history remains independent. Without exact correlation, observations
are not merged by URL or time. Clients should preserve those separate observations.

`trace_v1.scalar_briefs` advertises bounded scalar values in newly recorded object briefs,
including event type. Discriminator fields such as type/kind/status are shown first. Existing
recordings retain their stored briefs.

`trace_v1.discovery_probe_suppression` indicates that the node's inspector discovery requests
carry a random process-local marker. The recorder excludes only marked loopback inspector
discovery paths; ordinary requests to the same paths remain recorded. Dynamically allocated
inspectors can still be discovered without filling recordings with the node's own probes.

## Request files

Everything is under `.abele/requests/` in the project folder:

- `<collection>/<name>.http` is one request. A collection is a folder. The file is the `.http`
  format of REST Client and the JetBrains client: the method and address, headers, a blank line,
  the body. What that format has no words for is a `# @` comment above it: `# @name`, `# @before`
  and `# @after` (plugin scripts by name), `# @check`, `# @off-param` and `# @off-header` (lines
  kept but not sent), `# @body` when the body's format cannot be read off its `Content-Type`.
  A hand-written `.http` file with one request reads too; unknown comment lines are dropped when
  the request is saved.
- `env/<name>.json` is one environment (a name may not end in `.local`, and no request or
  collection goes in `env/`, in any case of the word): `{ "vars": [{ "key", "value"?, "secret"?, "off"? }],
"step_header"? }`. A variable marked `secret` (a token taken from an answer) is never written:
  its value lives in the plugin's memory and comes with each send.
- `env/<name>.local.json` holds values for this machine only, `{ "vars": [{ "key", "value" }] }`.
  They win over the shared file and stay in the local file when the environment is saved.
- `.history/` keeps what was sent and what came back, per request, the last 50 sends.

The folder's own `.gitignore` keeps `.history/` and `env/*.local.json` out of git. Whether the
requests and environments are committed is the owner's choice; the node never adds them.

Keys never reach these files. `${abele_key:name}` stays in the request as written; the plugin
puts the value in for one send and gives it to the node with the list of values to blank.

## Sending

`http.v1.send` takes the request as it is to go: method, full address, headers, body, and
`secrets`, the values to blank. It answers at once with a `send_id`; `http.v1.send.status`
follows it, since a request may take longer than the channel waits for any answer. Before
anything is written or answered, every secret is replaced by `••••` wherever it shows, as written
or percent-encoded: in the address, the headers, the body, the answer's headers and body, and an
error's words. In a send with any key, `Authorization`, `Cookie`, `X-Api-Key` and the like are
kept blanked whole when no key shows in them as written, since one may be there encoded (Basic).
Only `http:` and `https:` addresses are sent to.

Outcomes:

- `answered`: status, reason, time, size, headers and the first 96 KiB of the body; `http.v1.body`
  reads the rest in pages. Up to 5 MiB of a body is kept; past that it is cut and says so. A body
  that is not text is kept as a line naming its size and type.
- `failed`: it never reached the server: nothing listened there, no such host, a certificate not
  trusted, an address that cannot be sent to.
- `unknown`: no answer in time (30 s unless `timeout_ms` says otherwise, up to 5 minutes), or the
  connection went mid-way. It may have gone through, and the node never sends it again.

The send deadline ends the caller's wait, not the outgoing request. After a deadline, status
can change from `unknown` to `answered` when a late answer arrives; its body and history are
then kept normally. Only explicit cancellation, node shutdown or a transport failure ends the
outgoing request. A send still waiting for its late answer occupies one of the 16 send slots.

Redirects are followed within the origin as a browser follows them. A redirect to another origin
is followed only when the send came with no key at all, in whatever form: a key is allowed for one
origin, so a request that carries one stops at the redirect and that is the answer, its `Location`
among its headers. Followed to another origin, a send leaves behind `Authorization`, `Cookie` and
headers named as keys (`X-Api-Key`, `Api-Key`). A redirect to anything but `http:` or `https:` is
not followed.
Links inside `.abele/requests/` are never followed, neither when listing nor when reading or writing.

At most 16 sends are out at once. A finished send stays answerable in memory for ten minutes and
afterwards is read back from `.history/`.

Nodes advertising `http_v1.send_cancel` accept `http.v1.send.cancel` with `project_id` and
`send_id`. It aborts the outgoing transport and returns the same shape as send status, without
waiting for debugger recording to flush. Repeating it preserves the result; a completed answer
stays answered. Cancellation before a complete answer is `unknown` with a stopped reason: the
service may already have received the request. It does not undo remote changes or resend it.

## Into a recording

With `debug_session_id`, the send goes into the run that session is recording
([recorded runs](trace.md)); without a run being written it is refused with
`http_not_recording`. While it is out, every step the record points take is put under it: same
`chain`, `by_time: true`, as the link is only by time. When the answer is in, the request is written
as an `http` step with `sent: true`, at the time it went, with the values `request` (what was sent,
blanked) and `response` (the body). `trace.v1.run` lists steps by time, so the request heads the
steps it caused. With `step_header` the request carries `X-Abele-Step: <chain>`, which a record
point can take to prove the link; reading it back into the link is a later stage.

## Who may send

All `http.v1.*` methods are owner methods, answered for the connected installation like
`trace.v1.*`. A provider session on the node has no way to them: the right to read or edit the
project's files is not the right to send HTTP from the machine.

## Methods

| Method                                      | What                                                                          |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| `http.v1.list`                              | collections with their requests and each one's last status; environment names |
| `http.v1.request.get` / `.save` / `.delete` | one request; `save` with `from` moves it, `create` refuses to overwrite       |
| `http.v1.collection.create`                 | a folder                                                                      |
| `http.v1.env.get` / `.save` / `.delete`     | one environment                                                               |
| `http.v1.send` / `http.v1.send.status`      | send, follow                                                                  |
| `http.v1.send.cancel`                       | stop the outgoing transport by send ID                                        |
| `http.v1.history`                           | a request's sends, the latest first                                           |
| `http.v1.body`                              | a page of a kept answer's body                                                |

The capability `http_v1` is advertised on every node. Errors are channel errors such as
`http_request_not_found`, `http_request_exists`, `http_environment_not_found`,
`http_send_not_found`, `http_not_recording`, `http_too_many_sends` and `http_bad_path`.

## Not here yet

Client certificates, trusting a self-signed certificate by its fingerprint, sending from a device
instead of the node, and keys kept on the node for an agent with no plugin open.
