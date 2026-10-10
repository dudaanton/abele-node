import { afterEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
import { GitRunner } from '../packages/node-core/src/git.js'
import { MemoryClientStore, NodeClient } from '../packages/node-client/src/index.js'

const dirs: string[] = [],
  cores: NodeCore[] = []
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
function git(cwd: string, ...args: string[]) {
  const result = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
async function setup() {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/repository-security-'))
  dirs.push(dir)
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-b', 'trunk')
  git(repo, 'config', 'user.name', 'Fixture')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(repo, 'file'), 'invented content\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'invented fixture')
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let operation = 0
  const request = async (method: string, params: unknown = {}, id?: string) =>
    (await core.request(actor, method, params, id ?? `fixture-${++operation}`)) as any
  const project = await request('project.register', { path: repo, trust: 'untrusted' })
  const worktree_id = (await request('repository.v1.worktrees', { project_id: project.project_id }))
    .entries[0].worktree_id
  const revision = await request('repository.v1.resolve', { worktree_id, ref: 'HEAD' })
  const p = { worktree_id, revision }
  return { dir, repo, core, actor, request, project, worktree_id, revision, p }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const core of cores.splice(0)) {
    await core.resources.stop()
    core.close()
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function trap(dir: string) {
  const marker = join(dir, 'executed'),
    program = join(dir, 'trap')
  writeFileSync(program, `#!/bin/sh\nprintf invoked > '${marker}'\ncat\n`, { mode: 0o700 })
  return { marker, program }
}

it('rejects traversal, absolute and Git-metadata paths at every path-taking read/write boundary', async () => {
  const s = await setup()
  const comparison = await s.request('repository.v1.compare', {
    worktree_id: s.worktree_id,
    base: s.revision,
    head: s.revision,
  })
  for (const path of [
    '../file',
    'dir/../../file',
    '/etc/passwd',
    '.git',
    '.git/config',
    'dir/.GiT/config',
    'file\0--help',
    './file',
    'dir//file',
  ]) {
    for (const method of ['tree', 'blob', 'history', 'blame'])
      await expect(s.request(`repository.v1.${method}`, { ...s.p, path })).rejects.toThrow(
        'invalid_params'
      )
    await expect(
      s.request('repository.v1.patch', {
        worktree_id: s.worktree_id,
        comparison_id: comparison.comparison_id,
        path,
      })
    ).rejects.toThrow('invalid_params')
    await expect(
      s.request('repository.v1.write', {
        worktree_id: s.worktree_id,
        path,
        expected_content_id: null,
        text: 'must not write',
      })
    ).rejects.toThrow('invalid_params')
    await expect(
      s.request('repository.v1.restore', {
        worktree_id: s.worktree_id,
        path,
        expected_content_id: null,
        recovery_path: 'file-recovery/absent',
      })
    ).rejects.toThrow('invalid_params')
  }
  expect(readFileSync(join(s.repo, 'file'), 'utf8')).toBe('invented content\n')
})

it('treats leading-dash filenames literally while refusing ref and revision option injection', async () => {
  const s = await setup(),
    path = '--upload-pack=trap'
  writeFileSync(join(s.repo, path), 'dash content\n')
  git(s.repo, 'add', '--', path)
  git(s.repo, 'commit', '-m', 'dash filename')
  const revision = await s.request('repository.v1.resolve', {
    worktree_id: s.worktree_id,
    ref: 'HEAD',
  })
  const p = { worktree_id: s.worktree_id, revision, path }
  const blob = await s.request('repository.v1.blob', p)
  expect(
    Buffer.from(
      (
        await s.request('repository.v1.content', {
          worktree_id: s.worktree_id,
          content_id: blob.content_id,
        })
      ).base64,
      'base64'
    ).toString()
  ).toBe('dash content\n')
  expect((await s.request('repository.v1.history', p)).entries[0].subject).toBe('dash filename')
  expect((await s.request('repository.v1.blame', p)).entries[0].text).toBe('dash content')
  expect(
    await s.request('repository.v1.write', {
      worktree_id: s.worktree_id,
      path,
      expected_content_id: hash('dash content\n'),
      text: 'literal edit\n',
    })
  ).toMatchObject({ state: 'saved' })
  for (const ref of ['--upload-pack=trap', '-HEAD', 'HEAD:../file', 'HEAD^{tree}', 'HEAD\0--help'])
    await expect(
      s.request('repository.v1.resolve', { worktree_id: s.worktree_id, ref })
    ).rejects.toThrow('invalid_params')
  for (const commit of ['--upload-pack=trap', '-HEAD', 'HEAD', 'a'.repeat(40) + ':file'])
    await expect(
      s.request('repository.v1.tree', {
        worktree_id: s.worktree_id,
        revision: { kind: 'commit', commit },
      })
    ).rejects.toThrow('invalid_params')
})

it('never dereferences in-root, out-of-root or metadata symlinks in working or historical reads and writes', async () => {
  const s = await setup()
  mkdirSync(join(s.repo, 'ordinary'))
  writeFileSync(join(s.repo, 'ordinary', 'child'), 'inside sentinel\n')
  mkdirSync(join(s.dir, 'outside'))
  writeFileSync(join(s.dir, 'outside', 'child'), 'outside sentinel\n')
  for (const [name, target] of [
    ['inside-file', 'file'],
    ['outside-file', join(s.dir, 'outside', 'child')],
    ['inside-dir', 'ordinary'],
    ['outside-dir', join(s.dir, 'outside')],
    ['metadata', '.git'],
  ])
    symlinkSync(target!, join(s.repo, name!))
  git(s.repo, 'add', '.')
  git(s.repo, 'commit', '-m', 'link traps')
  const committed = await s.request('repository.v1.resolve', {
    worktree_id: s.worktree_id,
    ref: 'HEAD',
  })
  const working = (await s.request('repository.v1.observe', { worktree_id: s.worktree_id }))
    .revision
  for (const revision of [committed, working]) {
    const entries = (
      await s.request('repository.v1.tree', { worktree_id: s.worktree_id, revision })
    ).entries
    expect(entries.filter((e: any) => e.kind === 'symlink')).toHaveLength(5)
    for (const path of [
      'inside-file',
      'outside-file',
      'inside-dir/child',
      'outside-dir/child',
      'metadata/config',
    ]) {
      await expect(
        s.request('repository.v1.blob', { worktree_id: s.worktree_id, revision, path })
      ).rejects.toThrow('unsafe_path')
      await expect(
        s.request('repository.v1.blame', { worktree_id: s.worktree_id, revision, path })
      ).rejects.toThrow('unsafe_path')
    }
    for (const path of ['inside-dir', 'outside-dir', 'metadata'])
      await expect(
        s.request('repository.v1.tree', { worktree_id: s.worktree_id, revision, path })
      ).rejects.toThrow('unsafe_path')
    const page = await s.request('repository.v1.search', {
      worktree_id: s.worktree_id,
      revision,
      query: 'outside sentinel',
    })
    expect(page.entries).toEqual([])
  }
  for (const path of [
    'inside-file',
    'outside-file',
    'inside-dir/child',
    'outside-dir/child',
    'metadata/config',
    'outside-dir/new',
  ])
    await expect(
      s.request('repository.v1.write', {
        worktree_id: s.worktree_id,
        path,
        expected_content_id: null,
        text: 'escape',
      })
    ).rejects.toThrow('unsafe_path')
  expect(readFileSync(join(s.dir, 'outside', 'child'), 'utf8')).toBe('outside sentinel\n')
  expect(existsSync(join(s.dir, 'outside', 'new'))).toBe(false)
})

it('does not recurse into a real submodule even when repository configuration requests inspection', async () => {
  const s = await setup(),
    module = join(s.repo, 'module'),
    t = trap(s.dir)
  mkdirSync(module)
  git(module, 'init', '-b', 'trunk')
  git(module, 'config', 'user.name', 'Fixture')
  git(module, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(module, 'secret'), 'submodule sentinel\n')
  writeFileSync(join(module, '.gitattributes'), 'secret filter=evil\n')
  git(module, 'add', '.')
  git(module, 'commit', '-m', 'submodule fixture')
  const head = git(module, 'rev-parse', 'HEAD')
  git(s.repo, 'update-index', '--add', '--cacheinfo', `160000,${head},module`)
  writeFileSync(
    join(s.repo, '.gitmodules'),
    '[submodule "module"]\n\tpath = module\n\turl = https://example.invalid/module\n\tignore = none\n'
  )
  git(s.repo, 'add', '.gitmodules')
  git(s.repo, 'commit', '-m', 'gitlink fixture')
  git(s.repo, 'config', 'submodule.module.ignore', 'none')
  git(s.repo, 'config', 'submodule.recurse', 'true')
  git(module, 'config', 'filter.evil.clean', t.program)
  git(module, 'config', 'filter.evil.required', 'true')
  writeFileSync(join(module, 'secret'), 'modified submodule sentinel\n')
  const committed = await s.request('repository.v1.resolve', {
    worktree_id: s.worktree_id,
    ref: 'HEAD',
  })
  const working = (await s.request('repository.v1.observe', { worktree_id: s.worktree_id }))
    .revision
  expect(existsSync(t.marker)).toBe(false)
  for (const revision of [committed, working]) {
    expect(
      (
        await s.request('repository.v1.tree', { worktree_id: s.worktree_id, revision })
      ).entries.find((e: any) => e.path === 'module').kind
    ).toBe('submodule')
    for (const method of ['tree', 'blob', 'blame'])
      await expect(
        s.request(`repository.v1.${method}`, {
          worktree_id: s.worktree_id,
          revision,
          path: method === 'tree' ? 'module' : 'module/secret',
        })
      ).rejects.toThrow('unsafe_path')
    expect(
      (
        await s.request('repository.v1.search', {
          worktree_id: s.worktree_id,
          revision,
          query: 'submodule sentinel',
        })
      ).entries
    ).toEqual([])
  }
  expect(
    (await s.request('repository.v1.status', { worktree_id: s.worktree_id, revision: working }))
      .entries
  ).toEqual([])
  await expect(
    s.request('repository.v1.write', {
      worktree_id: s.worktree_id,
      path: 'module/secret',
      expected_content_id: hash('modified submodule sentinel\n'),
      text: 'escape',
    })
  ).rejects.toThrow('unsafe_path')
  expect(existsSync(t.marker)).toBe(false)
})

it('never exposes linked-worktree shared metadata through trees, blobs, search or saves', async () => {
  const s = await setup(),
    linked = join(s.dir, 'linked')
  git(s.repo, 'worktree', 'add', '-b', 'side', linked)
  writeFileSync(join(s.repo, '.git', 'private-sentinel'), 'shared metadata sentinel\n')
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: true,
  })
  const worktree_id = (
    await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  ).entries.find((e: any) => e.kind === 'external').worktree_id
  await s.request('repository.v1.editing', { worktree_id, enabled: true })
  const working = (await s.request('repository.v1.observe', { worktree_id })).revision
  for (const revision of [s.revision, working]) {
    expect(
      (await s.request('repository.v1.tree', { worktree_id, revision })).entries.some((e: any) =>
        e.path.toLowerCase().includes('.git')
      )
    ).toBe(false)
    for (const path of [
      '.git',
      '.git/commondir',
      '../repo/.git/private-sentinel',
      join(s.repo, '.git', 'private-sentinel'),
    ])
      await expect(
        s.request('repository.v1.blob', { worktree_id, revision, path })
      ).rejects.toThrow('invalid_params')
    expect(
      (
        await s.request('repository.v1.search', {
          worktree_id,
          revision,
          query: 'shared metadata sentinel',
        })
      ).entries
    ).toEqual([])
  }
  await expect(
    s.request('repository.v1.write', {
      worktree_id,
      path: '.git/private-sentinel',
      expected_content_id: null,
      text: 'escape',
    })
  ).rejects.toThrow('invalid_params')
  expect(readFileSync(join(s.repo, '.git', 'private-sentinel'), 'utf8')).toBe(
    'shared metadata sentinel\n'
  )
})

it('disables hooks, aliases, fsmonitor and included filter/diff programs across repository reads without index writes', async () => {
  const s = await setup(),
    t = trap(s.dir),
    hooks = join(s.dir, 'hooks'),
    include = join(s.dir, 'included-config')
  mkdirSync(hooks)
  for (const hook of ['post-index-change', 'post-checkout', 'pre-commit'])
    writeFileSync(join(hooks, hook), readFileSync(t.program), { mode: 0o700 })
  writeFileSync(
    include,
    `[core]\n\tfsmonitor = ${t.program}\n\thooksPath = ${hooks}\n[filter "evil"]\n\tclean = ${t.program}\n\tsmudge = ${t.program}\n\tprocess = ${t.program}\n\trequired = true\n[diff "evil"]\n\ttextconv = ${t.program}\n[diff]\n\texternal = ${t.program}\n[alias]\n\tstatus = !${t.program}\n\tlog = !${t.program}\n\tshow = !${t.program}\n`
  )
  git(s.repo, 'config', `includeIf.gitdir:${s.repo}/.git.path`, include)
  writeFileSync(join(s.repo, '.gitattributes'), 'file filter=evil diff=evil\n')
  writeFileSync(join(s.repo, 'file'), 'modified content\n')
  const index = readFileSync(join(s.repo, '.git', 'index'))
  const working = (await s.request('repository.v1.observe', { worktree_id: s.worktree_id }))
    .revision
  await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  await s.request('repository.v1.refs', { worktree_id: s.worktree_id })
  for (const revision of [s.revision, working]) {
    await s.request('repository.v1.tree', { worktree_id: s.worktree_id, revision })
    await s.request('repository.v1.blob', { worktree_id: s.worktree_id, revision, path: 'file' })
    await s.request('repository.v1.history', { worktree_id: s.worktree_id, revision })
    await s.request('repository.v1.blame', { worktree_id: s.worktree_id, revision, path: 'file' })
    await s.request('repository.v1.search', {
      worktree_id: s.worktree_id,
      revision,
      query: 'content',
    })
  }
  for (const mode of ['endpoint', 'staged', 'unstaged']) {
    const comparison = await s.request('repository.v1.compare', {
      worktree_id: s.worktree_id,
      base: s.revision,
      head: working,
      mode,
    })
    for (const entry of comparison.entries)
      await s.request('repository.v1.patch', {
        worktree_id: s.worktree_id,
        comparison_id: comparison.comparison_id,
        path: entry.path,
      })
  }
  expect(readFileSync(join(s.repo, '.git', 'index'))).toEqual(index)
  expect(existsSync(t.marker)).toBe(false)
  // Sensitivity control: the condition really includes the malicious settings, and the trap is executable.
  expect(git(s.repo, 'config', '--get', 'filter.evil.clean')).toBe(t.program)
  expect(spawnSync(t.program, { input: '' }).status).toBe(0)
  expect(existsSync(t.marker)).toBe(true)
})

it('blocks lazy promisor fetch even on Git versions that ignore GIT_NO_LAZY_FETCH', async () => {
  const s = await setup(),
    t = trap(s.dir)
  writeFileSync(t.program, `#!/bin/sh\nprintf invoked > '${t.marker}'\nexit 1\n`, { mode: 0o700 })
  const oid = git(s.repo, 'rev-parse', 'HEAD:file')
  git(s.repo, 'config', 'remote.evil.url', `ext::${t.program}`)
  git(s.repo, 'config', 'remote.evil.promisor', 'true')
  git(s.repo, 'config', 'remote.evil.partialclonefilter', 'blob:none')
  git(s.repo, 'config', 'protocol.ext.allow', 'always')
  rmSync(join(s.repo, '.git', 'objects', oid.slice(0, 2), oid.slice(2)))
  // Git 2.31+ is supported; older releases do not implement the no-lazy-fetch environment pin.
  const wrapper = join(s.dir, 'old-git')
  writeFileSync(wrapper, '#!/bin/sh\nunset GIT_NO_LAZY_FETCH\nexec /usr/bin/git "$@"\n', {
    mode: 0o700,
  })
  const runner = new GitRunner(2000, 512 * 1024, wrapper)
  await expect(runner.run(s.repo, { kind: 'blob', object: oid })).rejects.toThrow('git_failed')
  expect(existsSync(t.marker)).toBe(false)
  // Without hardening this missing object does attempt to execute the configured transport.
  spawnSync(wrapper, ['cat-file', 'blob', oid], { cwd: s.repo, timeout: 2000 })
  expect(existsSync(t.marker)).toBe(true)
})

it('bounds huge trees before publication, huge blobs before loading, and skips binary search inputs', async () => {
  const s = await setup()
  writeFileSync(join(s.repo, 'huge'), Buffer.alloc(16 * 1024 * 1024 + 1, 120))
  writeFileSync(join(s.repo, 'binary'), Buffer.from([0, 110, 101, 101, 100, 108, 101]))
  writeFileSync(join(s.repo, 'invalid-utf8'), Buffer.from([255, 110, 101, 101, 100, 108, 101]))
  git(s.repo, 'add', '.')
  git(s.repo, 'commit', '-m', 'large and binary inputs')
  const revision = await s.request('repository.v1.resolve', {
    worktree_id: s.worktree_id,
    ref: 'HEAD',
  })
  for (const rev of [
    revision,
    (await s.request('repository.v1.observe', { worktree_id: s.worktree_id })).revision,
  ]) {
    const p = { worktree_id: s.worktree_id, revision: rev }
    expect(
      await s.request('repository.v1.blob', { ...p, path: 'huge', larger: true })
    ).toMatchObject({ content_id: null, too_large: true })
    for (const path of ['binary', 'invalid-utf8'])
      expect(await s.request('repository.v1.blob', { ...p, path })).toMatchObject({ binary: true })
    const page = await s.request('repository.v1.search', { ...p, query: 'needle' })
    expect(page.entries).toEqual([])
    expect(page.incomplete).toBe(true)
    expect(page.omissions).toContain('binary files skipped')
    expect(page.omissions).toContain('files over 1 MiB skipped')
  }
  // A real oversized Git tree, generated without thousands of on-disk files.
  const oid = git(s.repo, 'rev-parse', 'HEAD:file')
  const tree = spawnSync('/usr/bin/git', ['mktree'], {
    cwd: s.repo,
    encoding: 'utf8',
    input: Array.from(
      { length: 6000 },
      (_, i) => `100644 blob ${oid}\t${String(i).padStart(5, '0')}-${'x'.repeat(80)}\n`
    ).join(''),
  })
  expect(tree.status, tree.stderr).toBe(0)
  await expect(
    s.request('repository.v1.tree', {
      worktree_id: s.worktree_id,
      revision: { kind: 'commit', commit: tree.stdout.trim() },
    })
  ).rejects.toThrow('output_limit')
})

it('retains at most 1000 matches and returns byte-bounded pages with explicit truncation', async () => {
  const s = await setup()
  writeFileSync(
    join(s.repo, 'file'),
    Array.from({ length: 1100 }, (_, i) => `needle ${i}`).join('\n') + '\n'
  )
  git(s.repo, 'commit', '-am', 'search flood')
  const revision = await s.request('repository.v1.resolve', {
    worktree_id: s.worktree_id,
    ref: 'HEAD',
  })
  const params = { worktree_id: s.worktree_id, revision, query: 'needle' }
  let page = await s.request('repository.v1.search', params),
    matches = 0
  const lines: number[] = []
  for (;;) {
    expect(page.entries.length).toBeLessThanOrEqual(100)
    expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(32768)
    expect(page.incomplete).toBe(true)
    expect(page.omissions).toContain('matches or line text truncated')
    matches += page.entries.length
    lines.push(...page.entries.map((e: any) => e.line))
    if (!page.cursor) break
    page = await s.request('repository.v1.search', { ...params, cursor: page.cursor })
  }
  expect(matches).toBe(1000)
  expect(new Set(lines).size).toBe(1000)
})

it('fences cached reads and isolates observations, comparisons, continuations and retained bytes across targets/authorities', async () => {
  const s = await setup(),
    other = s.core.authority.authenticate(s.core.createToken('other').token)
  const working = (await s.request('repository.v1.observe', { worktree_id: s.worktree_id }))
    .revision
  const page = await s.request('repository.v1.tree', { ...s.p, limit: 1 })
  writeFileSync(join(s.repo, 'file'), 'changed\n')
  const changed = (await s.request('repository.v1.observe', { worktree_id: s.worktree_id }))
    .revision
  const comparison = await s.request('repository.v1.compare', {
    worktree_id: s.worktree_id,
    base: s.revision,
    head: changed,
  })
  await expect(
    s.core.request(other, 'repository.v1.tree', { worktree_id: s.worktree_id, revision: working })
  ).rejects.toThrow('stale_revision')
  await expect(
    s.core.request(other, 'repository.v1.patch', {
      worktree_id: s.worktree_id,
      comparison_id: comparison.comparison_id,
      path: 'file',
    })
  ).rejects.toThrow('comparison_expired')
  // Add a second committed path for a real continuation.
  writeFileSync(join(s.repo, 'second'), 'second\n')
  git(s.repo, 'add', '.')
  git(s.repo, 'commit', '-m', 'cursor paths')
  const revision = await s.request('repository.v1.resolve', {
    worktree_id: s.worktree_id,
    ref: 'HEAD',
  })
  const continuation = await s.request('repository.v1.tree', {
    worktree_id: s.worktree_id,
    revision,
    limit: 1,
  })
  expect(continuation.cursor).toBeTruthy()
  await expect(
    s.core.request(other, 'repository.v1.tree', {
      worktree_id: s.worktree_id,
      revision,
      cursor: continuation.cursor,
    })
  ).rejects.toThrow('stale_cursor')
  expect(page.cursor).toBeNull()
  const blob = await s.request('repository.v1.blob', { ...s.p, path: 'file' })
  const clone = join(s.dir, 'clone')
  git(s.repo, 'clone', '--local', s.repo, clone)
  const project = await s.request('project.register', { path: clone, trust: 'untrusted' })
  const worktree_id = (
    await s.request('repository.v1.worktrees', { project_id: project.project_id })
  ).entries[0].worktree_id
  await expect(
    s.request('repository.v1.content', { worktree_id, content_id: blob.content_id })
  ).rejects.toThrow('content_expired')
  s.core.revokeToken(s.actor.installation_id)
  await expect(s.request('repository.v1.blob', { ...s.p, path: 'file' })).rejects.toThrow(
    'unauthorized'
  )
  // Both active owner installations intentionally have node-wide read authority.
  expect(await s.core.request(other, 'repository.v1.blob', { ...s.p, path: 'file' })).toMatchObject(
    { content_id: blob.content_id }
  )
})

it('revocation during an immutable cache miss refuses publication and cannot repopulate the old cache generation', async () => {
  const s = await setup(),
    run = s.core.resources.git.run.bind(s.core.resources.git)
  let revoked = false
  vi.spyOn(s.core.resources.git, 'run').mockImplementation(
    async (cwd, command, before, deadline) => {
      const bytes = await run(cwd, command, before, deadline)
      if (command.kind === 'blob' && !revoked) {
        revoked = true
        s.core.revokeToken(s.actor.installation_id)
      }
      return bytes
    }
  )
  await expect(s.request('repository.v1.blob', { ...s.p, path: 'file' })).rejects.toThrow(
    'unauthorized'
  )
  const other = s.core.authority.authenticate(s.core.createToken('other').token)
  const spy = vi.spyOn(s.core.resources.git, 'run')
  spy.mockClear()
  await s.core.request(other, 'repository.v1.blob', { ...s.p, path: 'file' })
  expect(spy.mock.calls.filter(([, command]) => command.kind === 'blob')).toHaveLength(1)
})

it('refuses external writes before approval, after revocation and when approval is revoked after durable intent', async () => {
  const s = await setup(),
    linked = join(s.dir, 'linked')
  git(s.repo, 'worktree', 'add', '-b', 'side', linked)
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: true,
  })
  const worktree_id = (
    await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  ).entries.find((e: any) => e.kind === 'external').worktree_id
  const p = {
    worktree_id,
    path: 'file',
    expected_content_id: hash('invented content\n'),
    text: 'must not write\n',
  }
  await expect(s.request('repository.v1.write', p)).rejects.toThrow('unauthorized')
  await s.request('repository.v1.editing', { worktree_id, enabled: true })
  await s.request('repository.v1.editing', { worktree_id, enabled: false })
  await expect(s.request('repository.v1.write', p)).rejects.toThrow('unauthorized')
  await s.request('repository.v1.editing', { worktree_id, enabled: true })
  s.core.resources.mutations.fault = (point) => {
    if (point === 'after_intent')
      s.core.db
        .prepare('UPDATE repository_edit_permissions SET enabled=0 WHERE worktree_id=?')
        .run(worktree_id)
  }
  await expect(s.request('repository.v1.write', p)).rejects.toThrow('unauthorized')
  expect(readFileSync(join(linked, 'file'), 'utf8')).toBe('invented content\n')
})

it('rechecks installation revocation after durable intent and before write effects', async () => {
  const s = await setup()
  s.core.resources.mutations.fault = (point) => {
    if (point === 'after_intent') s.core.revokeToken(s.actor.installation_id)
  }
  await expect(
    s.request('repository.v1.write', {
      worktree_id: s.worktree_id,
      path: 'file',
      expected_content_id: hash('invented content\n'),
      text: 'must not write\n',
    })
  ).rejects.toThrow('unauthorized')
  expect(readFileSync(join(s.repo, 'file'), 'utf8')).toBe('invented content\n')
})

it('keeps an outcome_unknown client receipt terminal without allocating or queueing a replacement operation', async () => {
  const store = new MemoryClientStore(),
    client = new NodeClient(
      { url: 'ws://127.0.0.1:7777/channel', profile: 'local-token-v1', token: 'a'.repeat(64) },
      store
    )
  await store.transaction((state) => {
    state.node_id = 'fixture'
    state.installation_id = 'fixture'
  })
  const params = {
    worktree_id: 'fixture',
    path: 'file',
    expected_content_id: hash('before'),
    text: 'after',
  }
  await client.repository.write(params, 'uncertain-save')
  await store.transaction((state) => {
    const { method, params: normalizedParams } = state.outbox[0]!
    state.outbox = []
    state.results['uncertain-save'] = {
      request: { method, params: normalizedParams },
      result: {
        operation_id: 'uncertain-save',
        worktree_id: 'fixture',
        path: 'file',
        state: 'outcome_unknown',
        expected_content_id: params.expected_content_id,
        content_id: hash('after'),
        predecessor_content_id: params.expected_content_id,
        recovery_path: null,
      },
    }
  })
  expect((await client.repository.mutationResult('uncertain-save'))?.state).toBe('outcome_unknown')
  expect(await client.repository.write(params, 'uncertain-save')).toEqual({
    operation_id: 'uncertain-save',
  })
  expect(await client.pending()).toEqual([])
  await expect(
    client.repository.write({ ...params, text: 'different' }, 'uncertain-save')
  ).rejects.toThrow('idempotency_mismatch')
  expect(await client.pending()).toEqual([])
})
