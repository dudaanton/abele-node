import { afterEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, rmSync, renameSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { NodeCore } from '../packages/node-core/src/index.js'
import { FrameCodec, ChannelError } from '@abele/channel-protocol'
import { RelativePathSchema, type DiffSnapshot } from '../packages/node-protocol/src/files.js'

const roots: string[] = [],
  cores: NodeCore[] = []
function git(cwd: string, ...args: string[]) {
  const r = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' })
  if (r.status) throw new Error(r.stderr)
  return r.stdout.trim()
}
async function setup(managed = false) {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/files-'))
  roots.push(dir)
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  git(repo, 'init', '-b', 'main')
  git(repo, 'config', 'user.name', 'Fixture')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(repo, 'sample.txt'), 'one\ntwo\nthree\n')
  writeFileSync(join(repo, '.gitignore'), 'ignored\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'fixture')
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let op = 0
  const request = async (method: string, params: unknown = {}, id = 'op-' + ++op) =>
    Promise.resolve(core.request(actor, method, params, id))
  const project = (await request('project.register', { path: repo, trust: 'untrusted' })) as {
    project_id: string
  }
  let w = (
    (await request('workspace.list', { project_id: project.project_id })) as {
      workspace_id: string
      path: string
    }[]
  )[0]!
  if (managed) {
    const job = (await request('workspace.create', { project_id: project.project_id })) as {
      workspace_id: string
    }
    await core.resources.jobs.drain()
    w = (await request('workspace.get', { workspace_id: job.workspace_id })) as typeof w
  }
  return { core, request, dir, repo: w.path, workspace_id: w.workspace_id, actor }
}
afterEach(async () => {
  for (const c of cores.splice(0)) {
    await c.resources.stop()
    c.close()
  }
  for (const d of roots.splice(0)) rmSync(d, { recursive: true, force: true })
})
it('accepts saved review context when the current patch exceeds the capture limit', async () => {
  const s = await setup(true)
  const session = (await s.request('session.create', {
    title: 'Saved review',
    workspace_id: s.workspace_id,
  })) as { session_id: string }
  writeFileSync(join(s.repo, 'sample.txt'), 'one\nnew\nthree\n')
  const snap = (await s.request('workspace.diff.capture', {
    workspace_id: s.workspace_id,
    mode: 'head',
  })) as DiffSnapshot
  writeFileSync(join(s.repo, 'sample.txt'), 'x'.repeat(9 * 1024 * 1024))
  await expect(
    s.request('workspace.diff.capture', { workspace_id: s.workspace_id, mode: 'head' })
  ).rejects.toThrow('output_limit')
  const params = {
    session_id: session.session_id,
    observed_seq: s.core.head(session.session_id),
    anchors: [
      {
        node_id: s.core.node_id,
        workspace_id: s.workspace_id,
        diff_id: snap.diff_id,
        path: 'sample.txt',
        side: 'new',
        start_line: 2,
        end_line: 2,
        context_hash: createHash('sha256').update('new').digest('hex'),
        comment: 'Keep the saved context',
      },
    ],
  }
  const receipt = await s.request('review.submit', params, 'saved-review')
  expect(receipt).toMatchObject({ stale: [true] })
  expect(await s.request('review.submit', params, 'saved-review')).toEqual(receipt)
  expect(
    s.core.read(session.session_id, 0).filter((e) => e.type === 'input.accepted')
  ).toHaveLength(1)
  await expect(
    s.request('review.submit', {
      ...params,
      anchors: [{ ...params.anchors[0], context_hash: '0'.repeat(64) }],
    })
  ).rejects.toThrow('invalid_anchor')
  for (const code of ['unauthorized', 'storage_unavailable']) {
    vi.spyOn(s.core.resources.views, 'capture').mockRejectedValueOnce(new ChannelError(code))
    await expect(s.request('review.submit', params, 'guard-' + code)).rejects.toThrow(code)
  }
  expect(
    s.core.read(session.session_id, 0).filter((e) => e.type === 'input.accepted')
  ).toHaveLength(1)
})
it.each([1536, 2048])(
  'pages Git history by serialized bytes, including JSON escaping (%i repetitions)',
  async (repetitions) => {
    const s = await setup(),
      tree = git(s.repo, 'rev-parse', 'HEAD^{tree}')
    let parent = git(s.repo, 'rev-parse', 'HEAD')
    const subject = '"\\\\'.repeat(repetitions)
    for (let i = 0; i < 100; i++) {
      const object = `tree ${tree}\nparent ${parent}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\n${i} ${subject}\n`
      const made = spawnSync('/usr/bin/git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
        cwd: s.repo,
        input: object,
        encoding: 'utf8',
      })
      expect(made.status, made.stderr).toBe(0)
      parent = made.stdout.trim()
    }
    git(s.repo, 'update-ref', 'refs/heads/main', parent)
    let offset = 0
    const ids: string[] = []
    while (true) {
      const page = (await s.request('workspace.log', {
        workspace_id: s.workspace_id,
        offset,
        limit: 100,
      })) as { commit: string; subject: string }[]
      expect(() =>
        FrameCodec.encode({ kind: 'response', request_id: 'history-page', result: page })
      ).not.toThrow()
      if (offset === 0) {
        expect(page.length).toBeGreaterThan(0)
        expect(page.length).toBeLessThan(100)
      }
      if (!page.length) break
      ids.push(...page.map((row) => row.commit))
      offset += page.length
    }
    expect(ids).toHaveLength(101)
    expect(new Set(ids).size).toBe(101)
  }
)
it('returns a fitting history prefix even when the next subject exceeds the Git output limit', async () => {
  const s = await setup(),
    tree = git(s.repo, 'rev-parse', 'HEAD^{tree}')
  let parent = git(s.repo, 'rev-parse', 'HEAD')
  for (const subject of ['x'.repeat(600000), 'Small newest commit']) {
    const object = `tree ${tree}\nparent ${parent}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\n\n${subject}\n`
    const made = spawnSync('/usr/bin/git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
      cwd: s.repo,
      input: object,
      encoding: 'utf8',
    })
    expect(made.status, made.stderr).toBe(0)
    parent = made.stdout.trim()
  }
  git(s.repo, 'update-ref', 'refs/heads/main', parent)
  expect(await s.request('workspace.log', { workspace_id: s.workspace_id, limit: 100 })).toEqual([
    { commit: parent, subject: 'Small newest commit' },
  ])
  await expect(
    s.request('workspace.log', { workspace_id: s.workspace_id, offset: 1, limit: 100 })
  ).rejects.toThrow('output_limit')
})
it('lists, reads and reviews literal backslash names without admitting slash traversal', async () => {
  const s = await setup(true),
    path = 'report\\old.txt'
  writeFileSync(join(s.repo, path), 'before\n')
  git(s.repo, 'add', '--', path)
  git(s.repo, 'commit', '-m', 'native name')
  writeFileSync(join(s.repo, path), 'after\n')
  expect(await s.request('workspace.files', { workspace_id: s.workspace_id })).toMatchObject({
    entries: expect.arrayContaining([expect.objectContaining({ name: path, path })]),
  })
  expect(await s.request('workspace.read', { workspace_id: s.workspace_id, path })).toMatchObject({
    path,
    size: 6,
  })
  const snap = (await s.request('workspace.diff.capture', {
    workspace_id: s.workspace_id,
    mode: 'head',
  })) as DiffSnapshot
  const session = (await s.request('session.create', {
    title: 'Native name',
    workspace_id: s.workspace_id,
  })) as { session_id: string }
  expect(
    await s.request('review.submit', {
      session_id: session.session_id,
      observed_seq: 0,
      anchors: [
        {
          node_id: s.core.node_id,
          workspace_id: s.workspace_id,
          diff_id: snap.diff_id,
          path,
          side: 'new',
          start_line: 1,
          end_line: 1,
          context_hash: createHash('sha256').update('after').digest('hex'),
          comment: 'Review native name',
        },
      ],
    })
  ).toMatchObject({ stale: [false] })
  for (const hostile of ['../secret', 'a/../../secret', '/absolute', 'a/../report\\old.txt'])
    expect(RelativePathSchema.safeParse(hostile).success).toBe(false)
})
it('pages native names including ignored, untracked and dotfiles; never follows symlinks', async () => {
  const s = await setup()
  writeFileSync(join(s.repo, 'ignored'), 'hidden')
  writeFileSync(join(s.repo, '.dot'), 'dot')
  writeFileSync(join(s.repo, 'loose'), 'untracked')
  symlinkSync(s.dir, join(s.repo, 'escape'))
  let after: string | undefined,
    names: string[] = []
  do {
    const p = (await s.request('workspace.files', {
      workspace_id: s.workspace_id,
      path: '',
      limit: 2,
      ...(after ? { after } : {}),
    })) as { entries: { name: string; kind: string }[]; next: string | null }
    names.push(...p.entries.map((e) => e.name))
    after = p.next ?? undefined
    expect(p.entries.length).toBeLessThanOrEqual(2)
  } while (after)
  expect(names).toEqual([...names].sort())
  expect(names).toEqual(expect.arrayContaining(['ignored', '.dot', 'loose', 'escape']))
  expect(
    await s.request('workspace.stat', { workspace_id: s.workspace_id, path: 'escape' })
  ).toMatchObject({ kind: 'symlink' })
  for (const path of [
    '/etc/passwd',
    '../secret',
    'a/../../secret',
    'escape/repo/sample.txt',
    'escape',
    'sample.txt/..',
  ])
    await expect(
      s.request('workspace.read', { workspace_id: s.workspace_id, path })
    ).rejects.toThrow()
})
it('retains content identity with binary/large metadata and bounded artifact reads', async () => {
  const s = await setup()
  writeFileSync(join(s.repo, 'binary'), Buffer.from([0, 255, 1]))
  writeFileSync(join(s.repo, 'large'), 'x'.repeat(300000))
  const small = (await s.request('workspace.read', {
    workspace_id: s.workspace_id,
    path: 'sample.txt',
  })) as { content_id: string }
  writeFileSync(join(s.repo, 'sample.txt'), 'changed')
  const old = (await s.request('workspace.content', {
    workspace_id: s.workspace_id,
    content_id: small.content_id,
    offset: 0,
    length: 16,
  })) as { base64: string }
  expect(Buffer.from(old.base64, 'base64').toString()).toBe('one\ntwo\nthree\n')
  expect(
    await s.request('workspace.read', { workspace_id: s.workspace_id, path: 'binary' })
  ).toMatchObject({ binary: true, size: 3 })
  const large = (await s.request('workspace.read', {
    workspace_id: s.workspace_id,
    path: 'large',
  })) as { large: boolean; content_id: string }
  expect(large.large).toBe(true)
  expect(
    JSON.stringify(
      await s.request('workspace.content', {
        workspace_id: s.workspace_id,
        content_id: large.content_id,
        offset: 0,
        length: 131072,
      })
    ).length
  ).toBeLessThan(262144)
})
it('rejects a symlink replacement at the open boundary', async () => {
  const s = await setup()
  const file = join(s.repo, 'sample.txt')
  s.core.resources.files.beforeOpen = () => {
    renameSync(file, file + '.old')
    symlinkSync(join(s.repo, '.gitignore'), file)
  }
  await expect(
    s.request('workspace.read', { workspace_id: s.workspace_id, path: 'sample.txt' })
  ).rejects.toThrow('unsafe_path')
})
it('captures every diff mode, merge-base semantics, log/show and immutable review with stale detection and receipts', async () => {
  const s = await setup(true)
  const session = (await s.request('session.create', {
    title: 'Review',
    workspace_id: s.workspace_id,
  })) as { session_id: string }
  writeFileSync(join(s.repo, 'sample.txt'), 'one\nstaged\nthree\n')
  git(s.repo, 'add', 'sample.txt')
  writeFileSync(join(s.repo, 'sample.txt'), 'one\nnew\nthree\n')
  let headSnapshot: { diff_id: string } | undefined
  for (const mode of ['staged', 'unstaged', 'head', 'base']) {
    const snap = (await s.request('workspace.diff.capture', {
      workspace_id: s.workspace_id,
      mode,
    })) as { diff_id: string; merge_base: string | null }
    const p = (await s.request('workspace.diff.read', {
      workspace_id: s.workspace_id,
      diff_id: snap.diff_id,
    })) as { base64: string }
    if (mode === 'base') expect(Buffer.from(p.base64, 'base64').toString()).toBe('')
    else
      expect(Buffer.from(p.base64, 'base64').toString()).toContain(
        mode === 'staged' ? '+staged' : '+new'
      )
    if (mode === 'base') expect(snap.merge_base).toMatch(/^[a-f0-9]{40}$/)
    if (mode === 'head') headSnapshot = snap
  }
  const log = (await s.request('workspace.log', { workspace_id: s.workspace_id })) as {
    commit: string
  }[]
  expect(log.length).toBeGreaterThan(0)
  expect(
    await s.request('workspace.show', {
      workspace_id: s.workspace_id,
      commit: log[0]!.commit,
      path: 'sample.txt',
    })
  ).toMatchObject({ binary: false })
  writeFileSync(join(s.repo, 'sample.txt'), 'later\n')
  const anchor = {
    node_id: s.core.node_id,
    workspace_id: s.workspace_id,
    diff_id: headSnapshot!.diff_id,
    path: 'sample.txt',
    side: 'new',
    start_line: 2,
    end_line: 2,
    context_hash: createHash('sha256').update('new').digest('hex'),
    comment: 'Please explain this line',
  }
  const batch = {
    session_id: session.session_id,
    observed_seq: s.core.head(session.session_id),
    anchors: [anchor],
  }
  const receipt = (await s.request('review.submit', batch, 'review')) as {
    input_id: string
    stale: boolean[]
  }
  expect(receipt.stale).toEqual([true])
  expect(await s.request('review.submit', batch, 'review')).toEqual(receipt)
  expect(
    s.core.read(session.session_id, 0).filter((e) => e.type === 'input.accepted')
  ).toHaveLength(1)
  expect(
    await s.request('workspace.diff.get', {
      workspace_id: s.workspace_id,
      diff_id: headSnapshot!.diff_id,
    })
  ).toMatchObject(headSnapshot!)
  await expect(
    s.request('review.submit', { ...batch, anchors: [{ ...anchor, context_hash: '0'.repeat(64) }] })
  ).rejects.toThrow('invalid_anchor')
  await expect(
    s.request(
      'review.submit',
      { ...batch, anchors: [{ ...anchor, comment: 'different' }] },
      'review'
    )
  ).rejects.toThrow('idempotency_mismatch')
  git(s.repo, 'add', 'sample.txt')
  git(s.repo, 'commit', '-m', 'branch change')
  const commit = git(s.repo, 'rev-parse', 'HEAD')
  for (const mode of ['base', 'commit']) {
    const snap = (await s.request('workspace.diff.capture', {
      workspace_id: s.workspace_id,
      mode,
      ...(mode === 'commit' ? { commit } : {}),
    })) as { diff_id: string }
    const patch = (await s.request('workspace.diff.read', {
      workspace_id: s.workspace_id,
      diff_id: snap.diff_id,
    })) as { base64: string }
    expect(Buffer.from(patch.base64, 'base64').toString()).toContain('+later')
  }
})
