import { expect, it } from 'vitest'
import { filesystem } from '../packages/provider-codex/src/policy.js'

const project = '578dcfb2-390c-410e-8623-4a3cb906b88c',
  ws = '0b50a4eb-54d2-4915-bbb9-8dc736d3e560'
const managed = {
  home: '/fixture/home/.codex',
  state: '/fixture/state',
  workspace: `/fixture/state/worktrees/${project}/${ws}`,
  sibling: `/fixture/state/worktrees/${project}`,
  repository: '/fixture/projects/app/.git',
}
const registered = {
  home: '/fixture/home/.codex',
  state: '/fixture/state',
  workspace: '/fixture/projects/app',
  sibling: '/fixture/projects',
  repository: '/fixture/projects/app/.git',
}

// Codex 0.161+ widens an approved escalation to "write everywhere except deny
// entries" unless the filesystem root itself is denied; then the approved command
// keeps the ordinary profile, as 0.160.1 does whenever deny entries exist.
it.each([
  ['managed worktree', managed],
  ['registered project', registered],
])('denies the filesystem root for a %s so approvals never widen writes', (_, p) => {
  const fs = filesystem(p)
  expect(fs['/']).toBe('deny')
  expect(fs[p.workspace]).toBe('write')
  expect(Object.entries(fs).filter(([, a]) => a === 'write')).toEqual([[p.workspace, 'write']])
})

it('denies node state, neighbours, the Codex home and temp folders as whole directories', () => {
  const fs = filesystem(managed)
  for (const path of [
    managed.state,
    managed.sibling,
    managed.home,
    managed.repository,
    '/private/tmp',
    '/private/var/tmp',
  ])
    expect([path, fs[path]]).toEqual([path, 'deny'])
  expect(Object.keys(fs).some((k) => /[*?[\]{}]/.test(k))).toBe(false)
})

it('keeps a registered repository Git folder read-only by an explicit entry', () => {
  const fs = filesystem(registered)
  expect(fs['/fixture/projects/app/.git']).toBe('read')
  expect(fs['/fixture/projects/app/.codex']).toBe('read')
  expect(fs['/fixture/projects']).toBe('deny')
})

it.each([
  [
    'node-created worktree (gitfile to a gitdir under the main repository)',
    {
      ...managed,
      gitdir: `/fixture/projects/app/.git/worktrees/${ws}`,
    },
    {
      [`/fixture/projects/app/.git/worktrees/${ws}`]: 'deny',
      '/fixture/projects/app/.git': 'deny',
    },
  ],
  [
    'checkout whose Git folder sits inside the workspace under another name',
    {
      ...registered,
      repository: '/fixture/projects/app/.meta/git',
      gitdir: '/fixture/projects/app/.meta/git',
    },
    { '/fixture/projects/app/.meta/git': 'read', '/fixture/projects/app/.git': 'read' },
  ],
  [
    'worktree of a repository nested inside the workspace',
    {
      ...registered,
      repository: '/fixture/projects/app/inner/.git',
      gitdir: '/fixture/projects/app/inner/.git/worktrees/app',
    },
    {
      '/fixture/projects/app/inner/.git': 'read',
      '/fixture/projects/app/inner/.git/worktrees/app': 'read',
      '/fixture/projects/app/.git': 'read',
    },
  ],
])('protects the resolved Git folders of a %s', (_, p, expected) => {
  const fs = filesystem(p)
  for (const [path, access] of Object.entries(expected))
    expect([path, fs[path]]).toEqual([path, access])
})
