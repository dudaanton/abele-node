# Session and delegation tool permissions

Detect `node.describe.capabilities["tool.permissions.v1"].status === "supported"`.
Sessions returned by create/get/list/configure, `session.state`, and delegations
returned by create/status carry a persisted `tool_permissions` object:

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
