import { expect, it } from 'vitest'
import { assertCodexLayout } from '../packages/provider-codex/src/home.js'
it('allows the node default nested worktree layout without exposing state or Codex-home directories', () => {
  expect(() => assertCodexLayout('/state', '/state/worktrees/project/workspace')).not.toThrow()
  expect(() => assertCodexLayout('/state', '/external/workspace')).not.toThrow()
  for (const workspace of ['/state', '/state/codex/workspace', '/state/other', '/'])
    expect(() => assertCodexLayout('/state', workspace)).toThrow('overlap')
})
