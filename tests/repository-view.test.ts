import { afterEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  renameSync,
  symlinkSync,
  existsSync,
} from 'node:fs'
import { resolve, join } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'

const dirs: string[] = [],
  cores: NodeCore[] = []
function git(cwd: string, ...args: string[]) {
  const r = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' })
  if (r.status) throw new Error(r.stderr)
  return r.stdout.trim()
}
async function setup() {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/repository-'))
  dirs.push(dir)
  const repo = join(dir, 'repo'),
    linked = join(dir, 'linked')
  mkdirSync(repo)
  git(repo, 'init', '-b', 'trunk')
  git(repo, 'config', 'user.name', 'Fixture')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(repo, 'sample.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(repo, '.gitignore'), 'ignored\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'initial')
  git(repo, 'worktree', 'add', '-b', 'side', linked)
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let op = 0
  const request = async (method: string, params: unknown = {}) =>
    (await core.request(actor, method, params, 'fixture-' + ++op)) as any
  const project = await request('project.register', { path: repo, trust: 'untrusted' })
  const catalog = () => request('repository.v1.worktrees', { project_id: project.project_id })
  return { dir, repo, linked, core, actor, request, project, catalog }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const core of cores.splice(0)) {
    await core.resources.stop()
    core.close()
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
it('discovers external worktrees only after opt-in without adopting them for execution', async () => {
  const s = await setup()
  expect((await s.catalog()).entries.map((e: any) => e.kind)).toEqual(['root'])
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: true,
  })
  const entries = (await s.catalog()).entries
  expect(entries).toHaveLength(2)
  const external = entries.find((e: any) => e.kind === 'external')
  expect(external).toMatchObject({
    branch: 'refs/heads/side',
    availability: 'available',
    dirty: false,
  })
  expect((await s.catalog()).entries.find((e: any) => e.kind === 'external').worktree_id).toBe(
    external.worktree_id
  )
  await expect(s.request('workspace.get', { workspace_id: external.worktree_id })).rejects.toThrow(
    'not_found'
  )
  git(s.repo, 'worktree', 'lock', '--reason', 'fixture', s.linked)
  expect((await s.catalog()).entries.find((e: any) => e.kind === 'external').locked).toBe(true)
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: false,
  })
  await expect(
    s.request('repository.v1.resolve', { worktree_id: external.worktree_id, ref: 'HEAD' })
  ).rejects.toThrow('unauthorized')
})
it('freezes revisions, bounds blobs, preserves staged/unstaged/untracked and rejects stale working observations', async () => {
  const s = await setup(),
    target = (await s.catalog()).entries[0].worktree_id
  const revision = await s.request('repository.v1.resolve', { worktree_id: target, ref: 'HEAD' })
  writeFileSync(join(s.repo, 'sample.txt'), 'one\nstaged\nthree\n')
  git(s.repo, 'add', 'sample.txt')
  writeFileSync(join(s.repo, 'sample.txt'), 'one\nworking\nthree\n')
  writeFileSync(join(s.repo, 'new.txt'), 'new content\n')
  writeFileSync(join(s.repo, 'ignored'), 'secret ignored\n')
  const working = await s.request('repository.v1.observe', { worktree_id: target })
  expect(working.revision.kind).toBe('working')
  const status = await s.request('repository.v1.status', {
    worktree_id: target,
    revision: working.revision,
  })
  expect(status.entries.find((e: any) => e.path === 'sample.txt')).toMatchObject({
    index: 'M',
    worktree: 'M',
  })
  expect(status.entries.find((e: any) => e.path === 'new.txt')).toMatchObject({
    index: '?',
    worktree: '?',
  })
  expect(status.entries.some((e: any) => e.path === 'ignored')).toBe(false)
  const blob = await s.request('repository.v1.blob', {
    worktree_id: target,
    revision,
    path: 'sample.txt',
  })
  const chunk = await s.request('repository.v1.content', {
    worktree_id: target,
    content_id: blob.content_id,
  })
  expect(Buffer.from(chunk.base64, 'base64').toString()).toBe('one\ntwo\nthree\n')
  const current = await s.request('repository.v1.blob', {
    worktree_id: target,
    revision: working.revision,
    path: 'sample.txt',
  })
  expect(current.content_id).not.toBe(blob.content_id)
  writeFileSync(join(s.repo, 'sample.txt'), 'changed again\n')
  await expect(
    s.request('repository.v1.blob', {
      worktree_id: target,
      revision: working.revision,
      path: 'sample.txt',
    })
  ).rejects.toThrow('stale_revision')
  expect(
    Buffer.from(
      (
        await s.request('repository.v1.content', {
          worktree_id: target,
          content_id: current.content_id,
        })
      ).base64,
      'base64'
    ).toString()
  ).toContain('working')
})
it('supports frozen tree/history/comparison/blame/search and prevents metadata and link traversal', async () => {
  const s = await setup(),
    target = (await s.catalog()).entries[0].worktree_id
  const base = await s.request('repository.v1.resolve', { worktree_id: target, ref: 'HEAD' })
  writeFileSync(join(s.repo, 'sample.txt'), 'one\nsecond\nthree\n')
  git(s.repo, 'commit', '-am', 'second')
  const head = await s.request('repository.v1.resolve', { worktree_id: target, ref: 'HEAD' })
  const p = { worktree_id: target, revision: head }
  expect(
    (await s.request('repository.v1.tree', p)).entries.some((e: any) => e.path === 'sample.txt')
  ).toBe(true)
  expect(
    (await s.request('repository.v1.history', { ...p, path: 'sample.txt' })).entries
  ).toHaveLength(2)
  expect((await s.request('repository.v1.commit', { ...p })).subject).toBe('second')
  const comparison = await s.request('repository.v1.compare', { worktree_id: target, base, head })
  expect(comparison.entries.map((e: any) => e.path)).toEqual(['sample.txt'])
  const patch = await s.request('repository.v1.patch', {
    worktree_id: target,
    comparison_id: comparison.comparison_id,
    path: 'sample.txt',
  })
  expect(
    Buffer.from(
      (
        await s.request('repository.v1.content', {
          worktree_id: target,
          content_id: patch.content_id,
        })
      ).base64,
      'base64'
    ).toString()
  ).toContain('+second')
  const blame = await s.request('repository.v1.blame', {
    ...p,
    path: 'sample.txt',
    start: 1,
    count: 3,
  })
  expect(blame.entries[1].commit).toBe(head.commit)
  const search = await s.request('repository.v1.search', { ...p, query: 'second' })
  expect(search.entries[0]).toMatchObject({ path: 'sample.txt', line: 2, text: 'second' })
  await expect(s.request('repository.v1.blob', { ...p, path: '.git/config' })).rejects.toThrow(
    'invalid_params'
  )
  symlinkSync(join(s.repo, '.git'), join(s.repo, 'escape'))
  const working = await s.request('repository.v1.observe', { worktree_id: target })
  await expect(
    s.request('repository.v1.blob', { ...p, revision: working.revision, path: 'escape/config' })
  ).rejects.toThrow()
})
it('invalidates identities on replacement and registration removal', async () => {
  const s = await setup()
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: true,
  })
  const external = (await s.catalog()).entries.find((e: any) => e.kind === 'external')
  renameSync(s.linked, join(s.dir, 'old-linked'))
  expect(
    (await s.catalog()).entries.find((e: any) => e.worktree_id === external.worktree_id)
      .availability
  ).toBe('missing')
  mkdirSync(s.linked)
  await expect(
    s.request('repository.v1.resolve', { worktree_id: external.worktree_id, ref: 'HEAD' })
  ).rejects.toThrow()
  await s.request('project.remove', { project_id: s.project.project_id })
  await expect(
    s.request('repository.v1.content', {
      worktree_id: external.worktree_id,
      content_id: '0'.repeat(64),
    })
  ).rejects.toThrow()
})

it('resolves owner/default refs without guessing or fetching and preserves frozen history continuations', async () => {
  const s = await setup(),
    worktree_id = (await s.catalog()).entries[0].worktree_id
  const refs = () => s.request('repository.v1.refs', { worktree_id })
  expect((await refs()).default_branch).toBeNull()
  git(s.repo, 'update-ref', 'refs/remotes/origin/trunk', git(s.repo, 'rev-parse', 'HEAD'))
  git(s.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/trunk')
  expect((await refs()).default_branch).toBe('refs/remotes/origin/trunk')
  git(s.repo, 'update-ref', 'refs/remotes/other/side', git(s.repo, 'rev-parse', 'HEAD'))
  git(s.repo, 'symbolic-ref', 'refs/remotes/other/HEAD', 'refs/remotes/other/side')
  expect((await refs()).default_branch).toBeNull()
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: false,
    default_branch: 'refs/heads/trunk',
  })
  expect((await refs()).default_branch).toBe('refs/heads/trunk')
  git(s.repo, 'tag', '-a', 'v1', '-m', 'tag')
  expect((await refs()).entries.find((e: any) => e.name === 'refs/tags/v1').commit).toBe(
    git(s.repo, 'rev-parse', 'HEAD')
  )
  writeFileSync(join(s.repo, 'sample.txt'), 'second\n')
  git(s.repo, 'commit', '-am', 'second')
  const revision = await s.request('repository.v1.resolve', { worktree_id, ref: 'HEAD' })
  const params = { worktree_id, revision, limit: 1 }
  const first = await s.request('repository.v1.history', params)
  expect(first.cursor).toBeTruthy()
  writeFileSync(join(s.repo, 'sample.txt'), 'third\n')
  git(s.repo, 'commit', '-am', 'third')
  expect(
    (await s.request('repository.v1.history', { ...params, cursor: first.cursor })).entries[0]
      .subject
  ).toBe('initial')
  await expect(
    s.request('repository.v1.history', { ...params, path: 'sample.txt', cursor: first.cursor })
  ).rejects.toThrow('stale_cursor')
})

it('bounds trees and blobs, excludes submodules and metadata, and isolates continuations by owner and query', async () => {
  const s = await setup(),
    worktree_id = (await s.catalog()).entries[0].worktree_id
  for (let i = 0; i < 270; i++)
    writeFileSync(join(s.repo, `file-${String(i).padStart(3, '0')}`), 'match\n')
  writeFileSync(join(s.repo, 'binary'), Buffer.from([0, 1, 2]))
  writeFileSync(join(s.repo, 'large'), 'x'.repeat(1024 * 1024 + 1))
  writeFileSync(join(s.repo, 'too-large'), Buffer.alloc(16 * 1024 * 1024 + 1))
  git(s.repo, 'add', '.')
  git(s.repo, 'commit', '-m', 'bounds')
  const revision = await s.request('repository.v1.resolve', { worktree_id, ref: 'HEAD' }),
    params = { worktree_id, revision }
  const page = await s.request('repository.v1.tree', params)
  expect(page.entries).toHaveLength(256)
  const next = await s.request('repository.v1.tree', { ...params, cursor: page.cursor })
  expect(next.entries).toHaveLength(19)
  const other = s.core.authority.authenticate(s.core.createToken('other').token)
  await expect(
    s.core.request(other, 'repository.v1.tree', { ...params, cursor: page.cursor })
  ).rejects.toThrow('stale_cursor')
  const blob = await s.request('repository.v1.blob', { ...params, path: 'large' })
  expect(blob).toMatchObject({ content_id: null, requires_larger_load: true, too_large: false })
  const loaded = await s.request('repository.v1.blob', { ...params, path: 'large', larger: true })
  expect(loaded.content_id).toBeTruthy()
  expect(
    (await s.request('repository.v1.content', { worktree_id, content_id: loaded.content_id }))
      .base64.length
  ).toBeLessThan(180000)
  expect(
    await s.request('repository.v1.blob', { ...params, path: 'too-large', larger: true })
  ).toMatchObject({ content_id: null, too_large: true })
  const search = await s.request('repository.v1.search', {
    ...params,
    query: 'match',
    path_glob: 'file-*',
  })
  expect(search.entries).toHaveLength(100)
  expect(search.cursor).toBeTruthy()
  expect(Buffer.byteLength(JSON.stringify(search))).toBeLessThanOrEqual(32768)
  expect(
    (
      await s.request('repository.v1.search', {
        ...params,
        query: 'match',
        path_glob: 'file-*',
        cursor: search.cursor,
      })
    ).entries
  ).toHaveLength(100)
  await expect(
    s.request('repository.v1.search', { ...params, query: 'different', cursor: search.cursor })
  ).rejects.toThrow('stale_cursor')
  expect(
    (await s.request('repository.v1.search', { ...params, query: 'FILE-269', mode: 'filename' }))
      .entries[0].path
  ).toBe('file-269')
  await expect(
    s.request('repository.v1.search', { ...params, query: '[', mode: 'regex' })
  ).rejects.toThrow('unsupported_search_syntax')
  const head = revision.commit
  git(s.repo, 'update-index', '--add', '--cacheinfo', `160000,${head},module`)
  git(s.repo, 'commit', '-m', 'gitlink')
  mkdirSync(join(s.repo, 'module'))
  writeFileSync(join(s.repo, 'module', 'secret'), 'match secret\n')
  const working = await s.request('repository.v1.observe', { worktree_id })
  const firstWorkingPage = await s.request('repository.v1.tree', {
    worktree_id,
    revision: working.revision,
  })
  const secondWorkingPage = await s.request('repository.v1.tree', {
    worktree_id,
    revision: working.revision,
    cursor: firstWorkingPage.cursor,
  })
  expect(secondWorkingPage.entries.find((e: any) => e.path === 'module').kind).toBe('submodule')
  await expect(
    s.request('repository.v1.tree', { worktree_id, revision: working.revision, path: 'module' })
  ).rejects.toThrow('unsafe_path')
})

it('blames retained working content and terminates hostile regex without blocking unrelated reads', async () => {
  const s = await setup(),
    worktree_id = (await s.catalog()).entries[0].worktree_id
  writeFileSync(join(s.repo, 'sample.txt'), 'one\nnew\nthree\n')
  writeFileSync(join(s.repo, 'new-file'), 'untracked\n')
  let revision = (await s.request('repository.v1.observe', { worktree_id })).revision
  const blame = await s.request('repository.v1.blame', {
    worktree_id,
    revision,
    path: 'sample.txt',
    count: 3,
  })
  expect(blame.entries.map((e: any) => e.commit === null)).toEqual([false, true, false])
  expect(
    (await s.request('repository.v1.blame', { worktree_id, revision, path: 'new-file' })).entries[0]
      .commit
  ).toBeNull()
  writeFileSync(join(s.repo, 'attack'), 'a'.repeat(64000) + '!')
  revision = (await s.request('repository.v1.observe', { worktree_id })).revision
  const pending = s.request('repository.v1.search', {
    worktree_id,
    revision,
    query: '(a+)+$',
    mode: 'regex',
    path_glob: 'attack',
  })
  expect((await s.request('repository.v1.resolve', { worktree_id, ref: 'HEAD' })).kind).toBe(
    'commit'
  )
  const result = await pending
  expect(result.incomplete).toBe(true)
  expect(result.omissions.join(' ')).toContain('deadline')
}, 15000)

it('rejects delivery after opt-out or revocation and keeps captured comparison bytes frozen', async () => {
  const s = await setup()
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: true,
  })
  const worktree_id = (await s.catalog()).entries.find(
    (e: any) => e.kind === 'external'
  ).worktree_id
  const base = await s.request('repository.v1.resolve', { worktree_id, ref: 'HEAD' })
  writeFileSync(join(s.linked, 'sample.txt'), 'captured\n')
  const head = (await s.request('repository.v1.observe', { worktree_id })).revision
  const comparison = await s.request('repository.v1.compare', { worktree_id, base, head })
  const params = { worktree_id, comparison_id: comparison.comparison_id, path: 'sample.txt' }
  const patch = await s.request('repository.v1.patch', params)
  writeFileSync(join(s.linked, 'sample.txt'), 'later\n')
  expect(await s.request('repository.v1.patch', params)).toEqual(patch)
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: false,
  })
  expect(() =>
    s.core.checkPublication(s.actor, 'repository.v1.content', {
      worktree_id,
      content_id: patch.content_id,
    })
  ).toThrow('unauthorized')
  await expect(
    s.request('repository.v1.content', { worktree_id, content_id: patch.content_id })
  ).rejects.toThrow('unauthorized')
  s.core.revokeToken(s.actor.installation_id)
  await expect(
    s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  ).rejects.toThrow('unauthorized')
})

it('never executes custom filters, textconv, diff or fsmonitor during new reads', async () => {
  const s = await setup(),
    worktree_id = (await s.catalog()).entries[0].worktree_id
  const marker = join(s.dir, 'executed'),
    program = join(s.dir, 'customization')
  writeFileSync(program, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o700 })
  writeFileSync(join(s.repo, '.gitattributes'), 'sample.txt filter=evil diff=evil\n')
  git(s.repo, 'config', 'filter.evil.clean', program)
  git(s.repo, 'config', 'filter.evil.required', 'true')
  git(s.repo, 'config', 'diff.evil.textconv', program)
  git(s.repo, 'config', 'diff.external', program)
  git(s.repo, 'config', 'core.fsmonitor', program)
  writeFileSync(join(s.repo, 'sample.txt'), 'changed\n')
  const base = await s.request('repository.v1.resolve', { worktree_id, ref: 'HEAD' })
  const head = (await s.request('repository.v1.observe', { worktree_id })).revision
  await s.request('repository.v1.blame', { worktree_id, revision: head, path: 'sample.txt' })
  const comparison = await s.request('repository.v1.compare', { worktree_id, base, head })
  await s.request('repository.v1.patch', {
    worktree_id,
    comparison_id: comparison.comparison_id,
    path: 'sample.txt',
  })
  expect(existsSync(marker)).toBe(false)
})
