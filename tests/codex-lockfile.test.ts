import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
it('preserves the audited SDK transitive version when adding provider workspaces', () => {
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
  expect(
    lock.packages['node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion']
      .version
  ).toBe('5.0.12')
})
