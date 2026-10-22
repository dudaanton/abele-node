/** Older clients use strict resource schemas. Keep stored/provider policy intact;
 * project only the published copy until this connection explicitly opts in. */
export function legacyExecutionPolicy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(legacyExecutionPolicy)
  if (!value || typeof value !== 'object') return value
  const record = value as Record<string, unknown>
  const project = typeof record.project_id === 'string' && typeof record.root_path === 'string'
  const session =
    typeof record.session_id === 'string' &&
    (typeof record.provider === 'string' ||
      typeof record.process === 'string' ||
      typeof record.delegation_id === 'string')
  return Object.fromEntries(
    Object.entries(record)
      .filter(
        ([key]) =>
          !(project && key === 'codex_network_enabled') && !(session && key === 'tool_permissions')
      )
      .map(([key, child]) => [
        key,
        key === 'configuration' &&
        typeof record.provider === 'string' &&
        child &&
        typeof child === 'object'
          ? Object.fromEntries(
              Object.entries(child).filter(
                ([name]) =>
                  ![
                    'per_action_approval',
                    'approval_mode',
                    'workspace_actions_without_approval',
                  ].includes(name) && !(record.provider === 'acp' && name === 'permission_modes')
              )
            )
          : // Tool payloads and other configuration maps remain opaque.
            ['input', 'raw_input', 'raw_output', 'configuration'].includes(key)
            ? child
            : legacyExecutionPolicy(child),
      ])
  )
}
