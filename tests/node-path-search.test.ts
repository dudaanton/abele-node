import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
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
it('searches plain folders with bounded shared syntax, paging, content IDs and no link/metadata traversal', async () => {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/node-path-search-'))
  dirs.push(dir)
  const folder = join(dir, 'folder')
  mkdirSync(folder)
  mkdirSync(join(folder, 'nested'))
  mkdirSync(join(folder, '.git'))
  writeFileSync(join(folder, '.git', 'secret'), 'needle metadata')
  writeFileSync(join(folder, 'one'), 'Needle first\nneedle second\n')
  writeFileSync(join(folder, 'nested', 'two'), 'needle third\n')
  const outside = join(dir, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret'), 'needle outside')
  symlinkSync(outside, join(folder, 'link'))
  // Remove metadata marker before registration; it remains excluded when added later.
  rmSync(join(folder, '.git'), { recursive: true })
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let op = 0
  const request = async (method: string, params: unknown) =>
    (await core.request(actor, method, params, 'fixture-' + ++op)) as any
  const project = await request('project.register', { path: folder, trust: 'untrusted' })
  const workspace_id = (await request('workspace.list', { project_id: project.project_id }))[0]
    .workspace_id
  mkdirSync(join(folder, '.git'))
  writeFileSync(join(folder, '.git', 'secret'), 'needle metadata')
  const params = { workspace_id, query: 'needle', limit: 1 }
  const first = await request('workspace.search', params)
  expect(first.entries).toHaveLength(1)
  expect(first.cursor).not.toBeNull()
  expect(first.entries[0].content_id).toMatch(/^[a-f0-9]{64}$/)
  const rows = [...first.entries]
  let cursor = first.cursor
  while (cursor) {
    const page = await request('workspace.search', { ...params, cursor })
    rows.push(...page.entries)
    cursor = page.cursor
  }
  expect(rows.map((e: any) => e.path).sort()).toEqual(['nested/two', 'one', 'one'])
  const other = core.authority.authenticate(core.createToken('other').token)
  await expect(
    core.request(other, 'workspace.search', { ...params, cursor: first.cursor })
  ).rejects.toThrow('stale_cursor')
  expect(
    (await request('workspace.search', { workspace_id, query: 'two', mode: 'filename' })).entries[0]
  ).toMatchObject({ path: 'nested/two', line: 0, content_id: null })
  expect(
    (
      await request('workspace.search', {
        workspace_id,
        query: '^needle',
        mode: 'regex',
        case_sensitive: true,
        path_glob: 'nested/**',
      })
    ).entries
  ).toHaveLength(1)
})
