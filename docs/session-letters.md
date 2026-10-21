# Letters between client chats

Discover `session_letters_v1` in `node.describe.supported_capabilities` (or
`welcome.capabilities.supported_capabilities`) before sending a letter. Older
nodes reject the new request field; ordinary sends remain compatible.

Call `session.send` with an operation ID retained across retries:

```json
{
  "session_id": "destination-session",
  "text": "The message to deliver",
  "observed_seq": 42,
  "sender": { "id": "opaque-source-chat", "title": "Sending chat" }
}
```

`sender` is optional. Its ID is a nonempty string of at most 256 characters;
its display title is at most 256 characters (and may be empty). Unknown sender
fields are rejected. The reference is client-supplied display metadata: it is
not verified, grants no permissions, and must never be used to authorize a reply
or resolve an execution target. Normal installation/session/target checks apply.
Escape it as untrusted text when displaying it. It is separate from the node's
internal `from_session` identity, which clients cannot supply.

The receipt remains `{ input_id, accepted_seq }`. The session journal's
`input.accepted` event contains the exact `sender` snapshot, visible to every
authorized client reading that session, including clients on other devices.
Renaming the source chat does not alter old events. No device-local lookup is
needed to display provenance.

An input with `sender` is a letter. It waits for the current turn to finish and
runs alone: neither another letter nor ordinary queued input can join its turn.
Queue order is preserved. Internal messages with `from_session` use the same
barrier. Ordinary inputs retain their existing provider queue behavior.

Match the receipt's `input_id` against `input.reply.data.input_id`. This journal
event supplies the stable `turn_id`, `run_id`, `outcome`, and `final_reply`, either
`null` (no final assistant message) or:

```json
{ "message_id": "assistant-message", "event_seqs": [123, 124] }
```

The sequence numbers reference `session.update` events in the same session
stream. Their `data.turn_id` matches the completed turn, and their `data.update`
contains `kind: "agent_message"`, the message ID, and text. Concatenate the text
in the listed order. These are the last replacements of the final top-level
assistant message's blocks, excluding earlier commentary and tool-child replies.
For long-lived sessions, `turn.completed.data.input_ids` also lists the inputs
that contributed to the turn. For one-process-per-message providers, the stable
turn ID equals the run ID. The deterministic fake provider references its last
`content.delta` event (text or artifact) instead of a `session.update`.

Existing text bounds and `truncated` indicators still apply. Do not return streamed
deltas, the previous turn's reply, or a later turn's output. Check `outcome` before
treating the result as a successful answer; a failed/interrupted turn can contain
partial output. Cancellation before a turn starts produces no turn reply.

Journal replay after reconnect or restart provides the same mapping. A client
should retain its stream cursor and operation ID, obtain the send receipt, and
replay until the corresponding completion or input failure/cancellation is seen.
Older journals may lack `input.reply`; absence does not promise a reply. The new
event leaves existing strict `turn.completed` payloads unchanged, so older clients
can continue reading the stream.

The TypeScript helper accepts sender as the last optional argument:
`client.send(session_id, text, observed_seq, script?, expected_target?, operation_id?, sender?)`.
Use `client.sendResult(operation_id)` to obtain the input receipt after flushing.
