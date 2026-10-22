# Session and delegation tool permissions

Detect `node.describe.capabilities.capabilities["tool.permissions.v1"].status === "supported"`.
Also detect `node.describe.capabilities.capabilities["execution.policy.v1"].status === "supported"`
and call `execution.policy.v1.enable {}` on each authenticated channel connection.
Wait for `{ "enabled": true }` before fetching extended policy resources or subscribing.
The same capability is advertised in the welcome's existing capability map and the
enable method is listed in welcome methods. The request accepts only an empty object.
Opt-in is per connection, resets on reconnect, and never changes execution permissions.

Without this opt-in, all ordinary responses, replay pages and subscription events
omit `Project.codex_network_enabled` (including when true) and `tool_permissions`
on sessions, live session state and delegations, including nested setup results.
Storage and provider inputs retain the real values. Older plugins therefore continue
to parse their strict resource schemas. Clients that cannot opt in cannot read these
fields; they must display unknown rather than infer false or bypass from absence.

Provider configuration maps also omit the new `per_action_approval`, `approval_mode`
and `workspace_actions_without_approval` metadata until opt-in, as well as ACP's new
`configuration.permission_modes`. Existing providers' pre-existing `permission_modes`
fields remain available; the mode names use the existing session permission enum.

Sessions returned by create/get/list/configure, `session.state`, and delegations
returned by create/status carry a persisted `tool_permissions` object after opt-in:

```json
{
  "permission_mode": "manual",
  "per_action_approval": false,
  "status": "unsupported",
  "reason": "interactive_approval_unsupported"
}
```

`permission_mode` is the effective owner choice using the existing session mode
names: `manual` is Ask; `bypassPermissions` is explicit bypass. Other existing
provider-specific session modes retain their native meaning. `per_action_approval`
states whether the runner can support interactive action approvals; it does not
change when bypass is selected. `status` says whether the selected mode can run.
An unsupported Ask mode prevents launching a provider, with
`interactive_approval_unsupported`; it never converts to bypass.

The owner/plugin may supply `delegation.create.permission_mode`; omission means
`manual`. This must come from owner configuration, not model-selected tool input.
Ordinary sessions use `session.create.settings.permission_mode`. Both bounded and
long-lived runners receive the chosen mode. `session.configure` can change a
bounded session's mode only between runs; the current delegation snapshot is
updated with it. Use delegation status for the current policy: an idempotent create
receipt retains its original creation snapshot.

Bypass additionally requires the operator's existing `--claude-allow-bypass`
opt-in, shared by Claude Code, pi and Codex. Provider configuration advertises
`permission_modes` and `per_action_approval`. A missing interactive capability is
not consent to bypass. Do not start an unsupported mode or infer consent from
missing prompts. Show the effective mode and unsupported reason on cards.

Pi's Ask policy gates each SDK tool, including reads and edits, and denial leaves
its action unexecuted. Claude Code receives the ordinary native permission mode
and node approval bridge. Codex's certified native `on-request` integration cannot
enforce Ask for every action, so its `per_action_approval` is false and Ask is
blocked before starting its process. Codex can run only after an explicit bypass
choice with operator opt-in; its existing filesystem profile and approval bridge
still deny outside-workspace patch paths, protected paths, permission expansion
and session-wide grants. Bypass does not widen those boundaries.

Pi and trusted local extensions are not an OS filesystem sandbox. An outside
path is still subject to Ask, but an owner who explicitly selects pi bypass
authorizes its ordinary tools without prompting, including outside paths. Do not
describe bypass as workspace confinement.

Snapshots survive client reconnects and node restarts. Existing sessions without a
stored mode migrate to Ask unless they already have an explicit settings mode;
changing node defaults cannot silently grant bypass. On startup the node refreshes
the stored approval capability and mode support against the installed adapter.
Removing the operator's bypass opt-in makes that persisted bypass unsupported.

The request and response fields are additive/optional in the protocol schemas.
Older nodes omit the capability and snapshots: clients should display unknown
mode rather than infer bypass or universal interactive approval.
