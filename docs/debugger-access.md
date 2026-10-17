# Debugger access requests, version 1

Discover `capabilities['debugger.access.v1'].status === 'supported'` and the
advertised `debugger.v1.*` methods. These additions leave existing debugger RPCs
and session-update version 1 intact. Older clients ignore the new update kind.

A valid agent tool call without sufficient debugger authority returns
`{outcome:'rejected', code:'unauthorized', snapshot:null, observation:'unknown',
request_id, message}`. The message explains that an owner-issued grant for this
run/target is missing and the owner was asked in chat. No adapter operation is
sent. An unrelated conversation, invalid arguments, or inactive/revoked caller
does not generate a request.

The chat's journal receives a `session.update` event with `{run_id, update}`.
`update` conforms to `DebuggerAccessRequestSchema`:

- `kind: 'debugger_access_requested'`, `version: 1`, `request_id`, `method`;
- `actions`: `['read']` or `['read', requestedAction]`; `access` is the display
  category (`read`, `evaluate/setVariable`, or the requested control action);
- trusted `installation_id`, `run_id`, node-generated `task_id`,
  `conversation_id`, `workspace_id`, `debug_session_id`, `target_id`, `incarnation`;
- `target`: debugger target metadata; `folder`: chat folder path, or null when
  unavailable; `program`: retained launch program, otherwise the target's launch
  configuration label (for an attached process this includes its PID);
- `expires_at`: request/grant deadline, limited by node policy.

Render an Allow/Deny control on this item. Use the authenticated owner connection,
never the agent tool transport:

| RPC                           | Strict parameters                 | Result                                                           |
| ----------------------------- | --------------------------------- | ---------------------------------------------------------------- |
| `debugger.v1.access.requests` | `{}`                              | Pending active request items (up to 128)                         |
| `debugger.v1.access.decide`   | `{request_id, decision:'allow'    | 'deny'}`                                                         | `DebuggerGrant` on Allow, `{denied:true}` on Deny |
| `debugger.v1.grant.list`      | `{offset?:number, limit?:number}` | This issuer's retained grants, including revoked/expired records |
| `debugger.v1.grant.revoke`    | `{grant_id}`                      | `{revoked:true}`                                                 |
| `debugger.v1.grant.delete`    | `{grant_id}`                      | `{deleted:true}`                                                 |

`DebuggerClient` supplies `accessRequests`, `decideAccess`, `grants`,
`revokeGrant`, and `deleteGrant`. Do not send identity, scope, actions, mode,
expiry, or issuer fields with a decision: they are rejected. Allow uses only
the host-retained request, checks that its run and incarnation are still current,
and uses policy mode (`ask` by default). Expression access still needs the
existing exact-operation approval; Allow is not an evaluate/setVariable approval.

Grant pages are newest first, with offset 0 and limit 16 by default (maximum 16
to fit even paired-key records in a channel frame). Increment offset by the
returned length until a short/empty page. Refresh from offset 0 after deletion.

Requests are bounded, coalesced per run/session/incarnation/action, and retained
only in memory. Deny is terminal for that request. Settled, expired, replaced,
already decided, or pre-restart request IDs return `stale_state`; the UI should
refresh pending requests instead of resending a decision. Allow does not resume
or replay a rejected tool call: the agent retries explicitly. If an allowed
grant is subsequently revoked, the next rejected call can ask again.

Grants remain durable and scoped to the original identity, target and incarnation;
run settlement still revokes them. Revoke, delete, and mode changes require the
stored issuer's exact installation/profile/paired key, checked against the
authenticated caller. Delete revokes first (invalidating pending operations and
waits), then removes the grant row. It does not erase operation/history evidence.
Missing/deleted IDs fail authorization. These issuer restrictions tighten the old
revoke/mode behavior, which previously accepted any enrolled owner.

The legacy owner `debugger.v1.task.settle` RPC also checks every affected issuer
before changing anything, so it cannot bypass issuer-only revoke. Trusted run
lifecycle settlement still revokes all grants belonging to the settling run.

This run does not change other access models. The node has project trust and
repository-permission settings, not a separate folder/vault access-grant ledger.
Delegation grants already check `approved_by` when revoked but retain revoked
rows and expose no delete RPC; cleanup there needs a separate design, including
mailbox and audit references.
