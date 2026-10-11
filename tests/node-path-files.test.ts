import { afterEach, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  renameSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { NodeCore } from '../packages/node-core/src/index.js'
const hash = (s: string) => createHash('sha256').update(s).digest('hex')
const dirs: string[] = [],
  cores: NodeCore[] = []
async function setup(repository = false) {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/node-path-files-'))
  dirs.push(dir)
  const folder = join(dir, 'folder')
  mkdirSync(folder)
  if (repository) {
    const p = spawnSync('/usr/bin/git', ['init', '-b', 'trunk'], { cwd: folder })
    if (p.status) throw new Error('git init failed')
  }
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let op = 0
  const request = async (method: string, params: unknown, operation?: string) =>
    (await core.request(actor, method, params, operation ?? 'fixture-' + ++op)) as any
  const project = await request('project.register', { path: folder, trust: 'untrusted' })
  const id = repository
    ? (await request('repository.v1.worktrees', { project_id: project.project_id })).entries[0]
        .worktree_id
    : (await request('workspace.list', { project_id: project.project_id }))[0].workspace_id
  const target = repository ? { worktree_id: id } : { workspace_id: id }
  const prefix = repository ? 'repository.v1.file.' : 'workspace.file.'
  return { dir, folder, core, actor, request, target, prefix }
}
afterEach(async () => {
  for (const c of cores.splice(0)) {
    await c.resources.stop()
    c.close()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
for (const repository of [false, true])
  it(`performs exact durable regular-file operations for ${repository ? 'Git' : 'plain'} targets without overwriting destinations`, async () => {
    const s = await setup(repository)
    writeFileSync(join(s.folder, 'source'), 'contents')
    writeFileSync(join(s.folder, 'existing'), 'valuable')
    const move = { ...s.target, from: 'source', to: 'moved', expected_content_id: hash('contents') }
    expect(await s.request(s.prefix + 'copy', { ...move, to: 'existing' })).toMatchObject({
      state: 'conflict',
    })
    expect(readFileSync(join(s.folder, 'existing'), 'utf8')).toBe('valuable')
    expect(
      await s.request(s.prefix + 'copy', {
        ...move,
        to: 'copy',
        expected_content_id: hash('wrong'),
      })
    ).toMatchObject({ state: 'conflict' })
    const copied = await s.request(s.prefix + 'copy', { ...move, to: 'copy' }, 'copy-one')
    expect(copied.state).toBe('applied')
    expect(readFileSync(join(s.folder, 'copy'), 'utf8')).toBe('contents')
    expect(await s.request(s.prefix + 'copy', { ...move, to: 'copy' }, 'copy-one')).toEqual(copied)
    const moved = await s.request(s.prefix + 'move', move, 'move-one')
    expect(moved).toMatchObject({ state: 'applied' })
    expect(existsSync(join(s.folder, 'source'))).toBe(false)
    expect(readFileSync(join(s.folder, 'moved'), 'utf8')).toBe('contents')
    expect(await s.request(s.prefix + 'move', move, 'move-one')).toEqual(moved)
    const removed = await s.request(
      s.prefix + 'remove',
      { ...s.target, path: 'moved', expected_content_id: hash('contents') },
      'remove-one'
    )
    expect(removed.state).toBe('applied')
    expect(removed.recovery_path).not.toBeNull()
    expect(existsSync(join(s.folder, 'moved'))).toBe(false)
    const recovery = await s.request(
      repository ? 'repository.v1.recovery.read' : 'workspace.recovery.read',
      { ...s.target, recovery_path: removed.recovery_path }
    )
    expect(Buffer.from(recovery.base64, 'base64').toString()).toBe('contents')
    expect(await s.request(s.prefix + 'mkdir', { ...s.target, path: 'child' })).toMatchObject({
      state: 'applied',
      recovery_path: null,
    })
    expect(
      await s.request(s.prefix + 'mkdir', { ...s.target, path: 'child/grandchild' })
    ).toMatchObject({ state: 'applied' })
    await expect(
      s.request(s.prefix + 'mkdir', { ...s.target, path: 'missing/child' })
    ).rejects.toThrow('not_found')
    await expect(
      s.request(s.prefix + 'remove', {
        ...s.target,
        path: 'child',
        expected_content_id: hash('contents'),
      })
    ).rejects.toThrow('unsafe_path')
    symlinkSync(join(s.folder, 'existing'), join(s.folder, 'link'))
    await expect(
      s.request(s.prefix + 'copy', { ...move, from: 'link', to: 'unsafe' })
    ).rejects.toThrow('unsafe_path')
    await expect(
      s.request(s.prefix + 'copy', { ...move, from: '.git/config', to: 'unsafe' })
    ).rejects.toThrow('invalid_params')
  })
it('recovers an interrupted move as unknown after restart without repeating an effect', async () => {
  const s = await setup()
  writeFileSync(join(s.folder, 'source'), 'contents')
  const params = {
    ...s.target,
    from: 'source',
    to: 'destination',
    expected_content_id: hash('contents'),
  }
  s.core.resources.mutations.operationFault = (point) => {
    if (point === 'destination_created') throw new Error('crash')
  }
  await expect(s.request(s.prefix + 'move', params, 'move-unknown')).rejects.toThrow('crash')
  expect(existsSync(join(s.folder, 'destination'))).toBe(true)
  await s.core.resources.stop()
  s.core.close()
  cores.splice(cores.indexOf(s.core), 1)
  const core = new NodeCore(join(s.dir, 'state'))
  cores.push(core)
  const result = (await core.request(s.actor, s.prefix + 'move', params, 'move-unknown')) as any
  expect(result).toMatchObject({ operation_id: 'move-unknown', state: 'outcome_unknown' })
  expect(existsSync(join(s.folder, 'source'))).toBe(true)
  expect(existsSync(join(s.folder, 'destination'))).toBe(true)
  expect(result.recovery_path).not.toBeNull()
})
it('refuses a replaced plain root rather than applying its old authority to new files', async () => {
  const s = await setup()
  writeFileSync(join(s.folder, 'source'), 'contents')
  renameSync(s.folder, s.folder + '-old')
  mkdirSync(s.folder)
  writeFileSync(join(s.folder, 'source'), 'contents')
  await expect(
    s.request(s.prefix + 'remove', {
      ...s.target,
      path: 'source',
      expected_content_id: hash('contents'),
    })
  ).rejects.toThrow('stale_resource')
  expect(readFileSync(join(s.folder, 'source'), 'utf8')).toBe('contents')
})
