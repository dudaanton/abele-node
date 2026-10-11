import { afterEach, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
const dirs: string[] = [],
  cores: NodeCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) {
    await c.resources.stop()
    c.close()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
it('compares staged, unstaged and untracked files against an explicit empty base only for an unborn head', async () => {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/node-path-unborn-'))
  dirs.push(dir)
  const folder = join(dir, 'folder')
  mkdirSync(folder)
  const git = (...args: string[]) => {
    const p = spawnSync('/usr/bin/git', args, { cwd: folder, encoding: 'utf8' })
    if (p.status) throw new Error(p.stderr)
  }
  git('init', '-b', 'trunk')
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let op = 0
  const request = async (method: string, params: unknown) =>
    (await core.request(actor, method, params, 'fixture-' + ++op)) as any
  const project = await request('project.register', { path: folder, trust: 'untrusted' })
  const worktree_id = (await request('repository.v1.worktrees', { project_id: project.project_id }))
    .entries[0].worktree_id
  writeFileSync(join(folder, 'sample'), 'staged\n')
  git('add', 'sample')
  writeFileSync(join(folder, 'sample'), 'working\n')
  writeFileSync(join(folder, 'new'), 'untracked\n')
  const head = (await request('repository.v1.observe', { worktree_id })).revision
  for (const mode of ['staged', 'unstaged', 'endpoint']) {
    const comparison = await request('repository.v1.compare', {
      worktree_id,
      base: { kind: 'empty' },
      head,
      mode,
    })
    expect(comparison.base).toEqual({ kind: 'empty' })
    expect(comparison.entries.map((e: any) => e.path).sort()).toEqual(
      mode === 'staged' ? ['sample'] : ['new', 'sample']
    )
    const patch = await request('repository.v1.patch', {
      worktree_id,
      comparison_id: comparison.comparison_id,
      path: 'sample',
    })
    const contents = await request('repository.v1.content', {
      worktree_id,
      content_id: patch.content_id,
    })
    expect(Buffer.from(contents.base64, 'base64').toString()).toContain(
      mode === 'staged' ? '+staged' : '+working'
    )
  }
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  git('commit', '-m', 'initial')
  const born = (await request('repository.v1.observe', { worktree_id })).revision
  await expect(
    request('repository.v1.compare', { worktree_id, base: { kind: 'empty' }, head: born })
  ).rejects.toThrow('invalid_revision')
  await expect(
    request('repository.v1.blob', { worktree_id, revision: { kind: 'empty' }, path: 'sample' })
  ).rejects.toThrow('invalid_params')
})
