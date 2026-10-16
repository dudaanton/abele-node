# Session updates

Every agent's transcript is also written in one shared vocabulary, so a client renders a
Claude, Codex or pi chat with the same code. The kinds follow the
[Agent Client Protocol](https://agentclientprotocol.com) `session/update` notification;
names are snake_case like the rest of the node protocol. The node stays the host: ACP is
the shape of the records, not a transport.

Capability: `session_updates` (`session-update-v1; session.commands`).

## The event

`session.update { run_id?, update }`, appended right after the provider record it was
derived from. The provider's own records (`claude.*`, `codex.*`, `pi.*`) are journaled
exactly as before, so older clients keep working. A record that was mapped carries
`mapped: true`.

Read updates with `sessionUpdatesOf(event)` (node-protocol, re-exported by node-client),
not by filtering `session.update`:

- it returns the update of a `session.update` event;
- it maps a provider record that has no `mapped` flag, so a journal written before the
  node wrote updates replays into the same updates;
- it maps the node's own `session.context` (context meter) and successful
  `compaction.completed`, which a long-lived session writes in place of the provider's
  records.

Turns, background tasks, prompts and the process stay node events (`turn.*`,
`session.tasks`, `prompt.*`, `session.process`); they are not repeated as updates.

The vocabulary only grows. Clients ignore fields they do not know, and a kind they do
not know (`isKnownSessionUpdate`) is kept but not rendered. Text is at most 65536
characters per field; cut text has `truncated: true`, and the provider record keeps the
whole of it.

## Kinds

| kind                                   | fields                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `user_message`                         | `message_id`, `block?`, `text`                                                                                            |
| `agent_message_chunk`                  | `message_id`, `block?`, `text`, `parent_tool_call_id?` — appended to (message, block)                                     |
| `agent_message`                        | same — the whole text of (message, block), replacing its chunks                                                           |
| `agent_thought_chunk`, `agent_thought` | same; `agent_thought.redacted` when the reasoning is withheld                                                             |
| `tool_call`                            | `tool_call_id`, `title`, `tool_kind?`, `status?`, `locations?`, `content?`, `name?`, `raw_input?`, `parent_tool_call_id?` |
| `tool_call_update`                     | `tool_call_id` and any field of `tool_call` that changed; `content` replaces                                              |
| `plan`                                 | `entries: [{ content, priority, status }]`, the whole plan each time                                                      |
| `current_mode_update`                  | `mode_id`                                                                                                                 |
| `available_commands_update`            | `commands: [{ name, description, input_hint?, source? }]`, the whole list                                                 |
| `config_option_update`                 | `options: [{ id, name, category, current_value, options? }]`                                                              |
| `usage_update`                         | `used_tokens`, `max_tokens`, `percentage?`, `cost_usd?`                                                                   |
| `compaction_update`                    | `state: started \| completed \| failed`, `trigger?`, `pre_tokens?`, `post_tokens?`, `error?`                              |
| `compaction_summary`                   | `text`                                                                                                                    |
| `notice`                               | `level: info \| warning \| error`, `text`, `code?`                                                                        |

`tool_kind` is ACP's tool `kind` (`read`, `edit`, `delete`, `move`, `search`, `execute`,
`think`, `fetch`, `switch_mode`, `other`), renamed because `kind` names the update.
`content` is `{ type: 'content', text }` or `{ type: 'diff', path, old_text, new_text }`
(`old_text` null for a new file). `parent_tool_call_id` nests a subagent's output under
the call that started it.

## Commands

- `session.commands { session_id }` → `{ session_id, commands, seq }`: the list from the
  latest `available_commands_update`, empty with `seq` 0 before the agent reported one.
  Client: `sessionCommands(session_id)`.
- A command runs as an ordinary message, `/name input` (`commandText`). Client:
  `runCommand(session_id, name, input, observed_seq)`.

Claude reports its commands at every start of its process: the CLI's own commands and
skills, without the ones only its terminal screen handles. The CLI does not describe
them in its stream, so `description` is null.
