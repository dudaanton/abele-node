import { expect, it } from 'vitest'
import { checkManagedAncestry } from '../packages/provider-codex/src/discovery.js'
it('accepts administrator-owned platform aliases but rejects writable or user-owned ancestors', () => {
  const directory = { uid: 0, mode: 0o40755, isSymbolicLink: () => false }
  const alias = { uid: 0, mode: 0o120777, isSymbolicLink: () => true }
  expect(() => checkManagedAncestry([directory, alias, directory])).not.toThrow()
  for (const unsafe of [
    { ...directory, uid: 501 },
    { ...directory, mode: 0o40777 },
    { ...alias, uid: 501 },
  ])
    expect(() => checkManagedAncestry([directory, unsafe])).toThrow('unsafe_managed_requirements')
})
