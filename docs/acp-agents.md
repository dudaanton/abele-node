# ACP agents

AbeleNode can run any coding agent that speaks the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP) over stdio as a node
session, next to Claude Code, Codex and pi. Each session is one long-lived agent
process: messages written while the agent works wait and go in together as its next
prompt, and the session uses the same journal, input queue, approvals and clients as
every other provider.

## Agents

Two agents are known out of the box:

| id         | Agent      | Command                     |
| ---------- | ---------- | --------------------------- |
| `gemini`   | Gemini CLI | `gemini --experimental-acp` |
| `opencode` | OpenCode   | `opencode acp`              |

An agent whose command is not installed is listed with `available: false` and the
diagnostic `acp_agent_not_installed`; sessions cannot be created for it. Bare commands
are looked up in the node's `PATH`, then in `~/.local/bin`, `/opt/homebrew/bin` and
`/usr/local/bin`.

The list is changed in `acp-agents.json` in the node's state directory. An entry with a
known id changes that agent; a new id adds one; `"enabled": false` hides one:

```json
{
  "agents": [
    { "id": "gemini", "enabled": false },
    { "id": "goose", "name": "Goose", "command": "goose", "args": ["acp"] },
    {
      "id": "mine",
      "name": "My agent",
      "command": "/opt/agent/bin/agent",
      "env": { "AGENT_LOG": "off" }
    }
  ]
}
```

`id` is lowercase letters, digits, `_` and `-`, at most 32 characters. `env` is added
to the node's environment for that agent only. The file is read again whenever a
session starts. `node.describe` lists the agents under the `acp` provider.

## Sessions

Create a session with `provider: "acp"` and the agent's id:

```json
{
  "provider": "acp",
  "agent": "gemini",
  "workspace_id": "…",
  "settings": { "permission_mode": "manual" }
}
```

- **Updates.** Each `session/update` notification is journaled as an `acp.update` record,
  followed by the `session.update` it stands for (see `session-updates.md`): message and
  thought chunks, the whole message or thought once it is finished, tool calls and their
  updates (with diffs), the plan, mode and configuration options, compaction and notices.
  The agent's slash commands become the session's command list (`session.commands`), and
  running one sends `/name input` to the agent. Usage drives the session's context meter.
  Kinds the node does not know yet stay in the `acp.update` record only. Turns are
  journaled as `turn.started` and `turn.completed` like any live session.
- **Permissions.** `session/request_permission` becomes a node prompt answered from any
  paired device. The node only ever answers with the agent's single-use options; an
  "always" option is never chosen, and an agent that offers no single-use allow is
  rejected. With `permission_mode: "bypassPermissions"` the node allows each single
  action itself; every such decision is journaled as `acp.permission`, shown as a notice, and the tool
  call is shown as it runs.
- **Stop.** An interrupt sends `session/cancel` and keeps the process; any open
  permission question is cancelled. `session.stop` ends the process and everything it
  started.
- **Resume.** The agent's session id is kept on the node session. The next process
  resumes it with `session/resume` when the agent offers it, or with `session/load`
  otherwise (the history the agent replays is not journaled twice). An agent that can
  do neither starts a new session, and the journal says so with a notice.
- **Model.** `settings.model` other than `default` is set through the agent's `model`
  configuration option; an agent without one refuses the session.

The node does not offer the agent its file system or terminal: the agent uses its own
tools in the session's workspace. Delegated work does not run on ACP agents, and a
node restart ends their processes (the next message resumes the session).
