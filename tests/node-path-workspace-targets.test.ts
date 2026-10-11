import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
const dirs: string[] = [],
  cores: NodeCore[] = []
const hash = createHash('sha256').update('contents').digest('hex')
function git(cwd: string, ...args: string[]) {
  const p = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' })
  if (p.status) throw new Error(p.stderr)
}
function initialize(folder: string) {
  mkdirSync(folder)
  git(folder, 'init', '-b', 'trunk')
  git(folder, 'config', 'user.name', 'Fixture')
  git(folder, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(folder, 'source'), 'contents')
  git(folder, 'add', '.')
  git(folder, 'commit', '-m', 'initial')
}
async function setup() {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/workspace-targets-'))
  dirs.push(dir)
  const folder = join(dir, 'folder'),
    module = join(dir, 'module')
  initialize(folder)
  initialize(module)
  git(folder, '-c', 'protocol.file.allow=always', 'submodule', 'add', module, 'submodule')
  git(folder, 'commit', '-am', 'submodule')
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let op = 0
  const request = async (method: string, params: unknown) =>
    (await core.request(actor, method, params, 'fixture-' + ++op)) as any
  const project = await request('project.register', { path: folder, trust: 'untrusted' })
  const workspace_id = (await request('workspace.list', { project_id: project.project_id }))[0]
    .workspace_id
  const worktree_id = (await request('repository.v1.worktrees', { project_id: project.project_id }))
    .entries[0].worktree_id
  return { folder, core, request, project, workspace_id, worktree_id }
}
afterEach(async () => {
  for (const c of cores.splice(0)) {
    await c.resources.stop()
    c.close()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
it.each(['copy', 'move', 'remove', 'mkdir'])(
  'rejects workspace-form %s for a Git root instead of bypassing repository submodule validation',
  async (operation) => {
    const s = await setup()
    const file =
      operation === 'mkdir'
        ? { path: 'submodule/child' }
        : operation === 'remove'
          ? { path: 'submodule/source', expected_content_id: hash }
          : { from: 'submodule/source', to: 'copied', expected_content_id: hash }
    await expect(
      s.request('repository.v1.file.' + operation, { worktree_id: s.worktree_id, ...file })
    ).rejects.toThrow('unsafe_path')
    await expect(
      s.request('workspace.file.' + operation, { workspace_id: s.workspace_id, ...file })
    ).rejects.toThrow('git_required')
    expect(readFileSync(join(s.folder, 'submodule', 'source'), 'utf8')).toBe('contents')
  }
)
it('rejects managed-workspace IDs for workspace-form lifecycle operations even on regular files', async () => {
  const s = await setup()
  const created = await s.request('workspace.create', { project_id: s.project.project_id })
  await s.core.resources.jobs.drain()
  const workspace = await s.request('workspace.get', { workspace_id: created.workspace_id })
  await expect(
    s.request('workspace.file.remove', {
      workspace_id: workspace.workspace_id,
      path: 'source',
      expected_content_id: hash,
    })
  ).rejects.toThrow('git_required')
  expect(readFileSync(join(workspace.path, 'source'), 'utf8')).toBe('contents')
})
