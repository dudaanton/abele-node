import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, renameSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
import { diffLines, selectedContext, decodePatchPath } from '../packages/node-protocol/src/files.js'
import { decodeGit } from '../packages/node-core/src/git.js'
const dirs: string[] = [],
  cores: NodeCore[] = []
afterEach(async () => {
  for (const c of cores.splice(0)) {
    await c.resources.stop()
    c.close()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
async function setup() {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/file-bounds-'))
  dirs.push(dir)
  const folder = join(dir, 'folder')
  mkdirSync(folder)
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  const token = core.createToken('fixture').token,
    actor = core.authority.authenticate(token)
  const p = (await core.request(
    actor,
    'project.register',
    { path: folder, trust: 'untrusted' },
    'register'
  )) as { project_id: string }
  const w = (
    (await core.request(actor, 'workspace.list', { project_id: p.project_id })) as {
      workspace_id: string
    }[]
  )[0]!
  const request = async (method: string, p: object = {}) =>
    core.request(actor, method, { workspace_id: w.workspace_id, ...p })
  return { dir, folder, core, token, actor, workspace_id: w.workspace_id, request }
}
it('checks parent directory swaps and refuses oversized files without allocating their contents', async () => {
  const s = await setup(),
    parent = join(s.folder, 'sub')
  mkdirSync(parent)
  writeFileSync(join(parent, 'sample'), 'inside')
  const outside = join(s.dir, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'sample'), 'private')
  s.core.resources.files.beforeOpen = () => {
    renameSync(parent, parent + '-old')
    symlinkSync(outside, parent)
  }
  await expect(s.request('workspace.read', { path: 'sub/sample' })).rejects.toThrow('unsafe_path')
  s.core.resources.files.beforeOpen = undefined
  writeFileSync(join(s.folder, 'huge'), 'x'.repeat(17 * 1024 * 1024))
  expect(await s.request('workspace.read', { path: 'huge' })).toMatchObject({
    too_large: true,
    content_id: null,
  })
})
it('persists retained content through restart; fences cross-workspace and revoked reads', async () => {
  const s = await setup()
  writeFileSync(join(s.folder, 'sample'), 'retained')
  const content = (await s.request('workspace.read', { path: 'sample' })) as { content_id: string }
  s.core.close()
  cores.splice(cores.indexOf(s.core), 1)
  const core = new NodeCore(join(s.dir, 'state'))
  cores.push(core)
  const actor = core.authority.authenticate(s.token)
  expect(
    await core.request(actor, 'workspace.content', {
      workspace_id: s.workspace_id,
      content_id: content.content_id,
    })
  ).toMatchObject({ total: 8 })
  await expect(
    core.request(actor, 'workspace.content', {
      workspace_id: 'other',
      content_id: content.content_id,
    })
  ).rejects.toThrow('not_found')
  core.revokeToken(actor.installation_id)
  expect(() =>
    core.request(actor, 'workspace.content', {
      workspace_id: s.workspace_id,
      content_id: content.content_id,
    })
  ).toThrow('unauthorized')
})
it('preserves a leading BOM in native names', async () => {
  const s = await setup(),
    name = '\ufeffsample file.txt'
  writeFileSync(join(s.folder, name), 'fixture')
  expect(decodeGit(Buffer.from(name))).toBe(name)
  expect(await s.request('workspace.files')).toMatchObject({ entries: [{ name, path: name }] })
})
it('strips only Git header tab separators', () => {
  expect(decodePatchPath('a/sample file.txt\t')).toBe('sample file.txt')
  const patch =
    'diff --git a/sample file.txt b/sample file.txt\n--- a/sample file.txt\t\n+++ b/sample file.txt\t\n@@ -1 +1 @@\n-old\n+new\n'
  expect(
    selectedContext(patch, { path: 'sample file.txt', side: 'new', start_line: 1, end_line: 1 })
  ).toBe('new')
})
it('counts prefix-free empty context lines within hunks but not a trailing patch newline', () => {
  const patch =
    'diff --git a/sample b/sample\n--- a/sample\n+++ b/sample\n@@ -1,3 +1,3 @@\n first\n\n-old\n+new\n'
  expect(selectedContext(patch, { path: 'sample', side: 'new', start_line: 1, end_line: 3 })).toBe(
    'first\n\nnew'
  )
  expect(diffLines(patch).filter((l) => l.side === 'new')).toHaveLength(3)
})
it('decodes quoted native paths, keeps both sides and refuses ranges outside hunks', () => {
  const patch =
    'diff --git "a/a\\nb.txt" "b/a\\nb.txt"\n--- "a/a\\nb.txt"\n+++ "b/a\\nb.txt"\n@@ -1,2 +1,2 @@\n same\n-old\n+new\n'
  expect(diffLines(patch)).toEqual([
    { path: 'a\nb.txt', side: 'old', line: 1, text: 'same' },
    { path: 'a\nb.txt', side: 'new', line: 1, text: 'same' },
    { path: 'a\nb.txt', side: 'old', line: 2, text: 'old' },
    { path: 'a\nb.txt', side: 'new', line: 2, text: 'new' },
  ])
  expect(
    selectedContext(patch, { path: 'a\nb.txt', side: 'old', start_line: 1, end_line: 2 })
  ).toBe('same\nold')
  expect(() =>
    selectedContext(patch, { path: 'a\nb.txt', side: 'new', start_line: 2, end_line: 3 })
  ).toThrow('invalid_anchor')
})
