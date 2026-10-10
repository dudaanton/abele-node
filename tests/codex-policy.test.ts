import { expect, it } from 'vitest'
import {
  buildConfig,
  checkEffective,
  launchOverrides,
} from '../packages/provider-codex/src/policy.js'
const paths = {
  home: '/fixture/state/codex',
  state: '/fixture/state',
  workspace: '/fixture/work.space',
  sibling: '/fixture',
  repository: '/fixture/repository.git',
}
function effective() {
  const config: any = { mcp_servers: {}, plugins: {} }
  let section = ''
  for (const line of buildConfig(paths).trim().split('\n')) {
    if (line.startsWith('[')) {
      section = line.slice(1, -1)
      continue
    }
    const at = line.indexOf(' = '),
      key = line.slice(0, at)
    let target = config
    for (const k of section ? section.split('.') : []) target = target[k] ??= {}
    target[key.startsWith('"') ? JSON.parse(key) : key] = JSON.parse(line.slice(at + 3))
  }
  return config
}
it('uses inline tables for filesystem roots so CLI dotted-key parsing cannot reinterpret paths', () => {
  const overrides = launchOverrides(paths).filter((_, i) => i % 2 === 1)
  expect(overrides.some((k) => k.startsWith('permissions.abele.filesystem.'))).toBe(false)
  expect(overrides.some((k) => k.startsWith('permissions.abele.workspace_roots.'))).toBe(false)
  expect(overrides.find((k) => k.startsWith('permissions.abele.filesystem='))).toContain(
    '"/fixture/work.space" = "write"'
  )
})
it.each([
  'analytics',
  'resources',
  'remote',
  'extra-root',
  'extra-write',
  'network',
  'shell',
  'mixed',
  'provider',
  'provider-overrides',
])('rejects effective project or managed-layer conflict %s', (conflict) => {
  const config = effective(),
    requirements = { requirements: { allowRemoteControl: false } }
  expect(() => checkEffective(config, requirements, paths)).not.toThrow()
  if (conflict === 'analytics') config.analytics.enabled = true
  if (conflict === 'resources') config.mcp_servers.unexpected = { command: 'unapproved' }
  if (conflict === 'remote') requirements.requirements.allowRemoteControl = true
  if (conflict === 'extra-root') config.permissions.abele.workspace_roots['/extra'] = true
  if (conflict === 'extra-write') config.permissions.abele.filesystem['/extra'] = 'write'
  if (conflict === 'network') config.permissions.abele.network.enabled = true
  if (conflict === 'shell') config.shell_environment_policy.inherit = 'all'
  if (conflict === 'mixed') config.sandbox_mode = 'danger-full-access'
  if (conflict === 'provider') config.model_provider = 'unexpected'
  if (conflict === 'provider-overrides')
    config.model_providers = { openai: { base_url: 'https://unexpected.invalid' } }
  expect(() => checkEffective(config, requirements, paths)).toThrow()
})
