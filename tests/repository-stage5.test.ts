import { afterEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  renameSync,
  symlinkSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
const dirs: string[] = [],
  cores: NodeCore[] = []
const hash = (text: string) => createHash('sha256').update(text).digest('hex')
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync('/usr/bin/git', args, { cwd, encoding: 'utf8' })
  if (r.status) throw new Error(r.stderr)
  return r.stdout.trim()
}
async function setup() {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/repository-stage5-'))
  dirs.push(dir)
  const repo = join(dir, 'repo'),
    linked = join(dir, 'linked')
  mkdirSync(repo)
  git(repo, 'init', '-b', 'trunk')
  git(repo, 'config', 'user.name', 'Fixture')
  git(repo, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(repo, 'file'), 'before\n')
  git(repo, 'add', '.')
  git(repo, 'commit', '-m', 'fixture')
  git(repo, 'worktree', 'add', '-b', 'side', linked)
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('fixture').token)
  let operation = 0
  const request = async (method: string, params: unknown = {}, id?: string) =>
    (await core.request(actor, method, params, id ?? `fixture-${++operation}`)) as any
  const project = await request('project.register', { path: repo, trust: 'untrusted' })
  await request('project.repository_settings', {
    project_id: project.project_id,
    external_read: true,
  })
  const entries = (await request('repository.v1.worktrees', { project_id: project.project_id }))
    .entries
  const root = entries.find((e: any) => e.kind === 'root').worktree_id
  const external = entries.find((e: any) => e.kind === 'external').worktree_id
  return { dir, repo, linked, core, actor, request, project, root, external }
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of cores.splice(0)) {
    await c.resources.stop()
    c.close()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
async function wait(predicate: () => boolean) {
  const end = Date.now() + 10000
  while (!predicate()) {
    if (Date.now() > end) throw new Error('watcher deadline')
    await new Promise((r) => setTimeout(r, 20))
  }
}
it('requires identity-bound owner approval for external durable saves and restore', async () => {
  const s = await setup(),
    p = {
      worktree_id: s.external,
      path: 'file',
      expected_content_id: hash('before\n'),
      text: 'after\n',
    }
  await expect(s.request('repository.v1.write', p, 'save')).rejects.toThrow('unauthorized')
  expect(await s.request('repository.v1.editing.get', { worktree_id: s.external })).toEqual({
    worktree_id: s.external,
    enabled: false,
  })
  expect(
    await s.request('repository.v1.editing', { worktree_id: s.external, enabled: true })
  ).toEqual({ worktree_id: s.external, enabled: true })
  expect(await s.request('repository.v1.editing.get', { worktree_id: s.external })).toEqual({
    worktree_id: s.external,
    enabled: true,
  })
  const saved = await s.request('repository.v1.write', p, 'save')
  expect(saved).toMatchObject({
    state: 'saved',
    worktree_id: s.external,
    predecessor_content_id: hash('before\n'),
  })
  writeFileSync(join(s.linked, 'file'), 'external\n')
  expect(await s.request('repository.v1.write', p, 'save')).toEqual(saved)
  expect(readFileSync(join(s.linked, 'file'), 'utf8')).toBe('external\n')
  expect(await s.request('repository.v1.write', p, 'conflict')).toMatchObject({ state: 'conflict' })
  const recovery = await s.request('repository.v1.recovery.read', {
    worktree_id: s.external,
    recovery_path: saved.recovery_path,
  })
  expect(Buffer.from(recovery.base64, 'base64').toString()).toBe('before\n')
  expect(
    await s.request('repository.v1.restore', {
      worktree_id: s.external,
      path: 'file',
      expected_content_id: hash('external\n'),
      recovery_path: saved.recovery_path,
    })
  ).toMatchObject({ state: 'saved' })
  await s.request('repository.v1.editing', { worktree_id: s.external, enabled: false })
  await expect(s.request('repository.v1.write', p, 'save')).rejects.toThrow('unauthorized')
  expect((await s.request('workspace.list', { project_id: s.project.project_id })).length).toBe(1)
})
it('edits registered roots and managed worktrees, and exclusively creates approved external files', async () => {
  const s = await setup()
  const created = await s.request('workspace.create', {
    project_id: s.project.project_id,
    base_ref: 'HEAD',
  })
  await s.core.resources.jobs.drain()
  expect(await s.request('job.get', { job_id: created.job_id })).toMatchObject({
    state: 'succeeded',
  })
  const entries = (await s.request('repository.v1.worktrees', { project_id: s.project.project_id }))
    .entries
  for (const entry of entries.filter((e: any) => e.kind !== 'external')) {
    expect(
      await s.request('repository.v1.editing.get', { worktree_id: entry.worktree_id })
    ).toMatchObject({ enabled: true })
    expect(
      await s.request('repository.v1.write', {
        worktree_id: entry.worktree_id,
        path: 'file',
        expected_content_id: hash('before\n'),
        text: 'owner edit\n',
      })
    ).toMatchObject({ state: 'saved' })
  }
  await s.request('repository.v1.editing', { worktree_id: s.external, enabled: true })
  const p = { worktree_id: s.external, path: 'new-file', expected_content_id: null, text: 'new\n' }
  expect(await s.request('repository.v1.write', p)).toMatchObject({
    state: 'saved',
    recovery_path: null,
  })
  expect(await s.request('repository.v1.write', p)).toMatchObject({ state: 'conflict' })
  expect(readFileSync(join(s.linked, 'new-file'), 'utf8')).toBe('new\n')
})
it('settles an interrupted external write unknown and never reapplies it on retry', async () => {
  const s = await setup()
  await s.request('repository.v1.editing', { worktree_id: s.external, enabled: true })
  const p = {
    worktree_id: s.external,
    path: 'file',
    expected_content_id: hash('before\n'),
    text: 'after\n',
  }
  s.core.resources.mutations.fault = (point) => {
    if (point === 'after_truncate') throw new Error('fixture crash')
  }
  await expect(s.request('repository.v1.write', p, 'uncertain')).rejects.toThrow('fixture crash')
  s.core.resources.mutations.fault = undefined
  writeFileSync(join(s.linked, 'file'), 'later\n')
  expect(await s.request('repository.v1.write', p, 'uncertain')).toMatchObject({
    state: 'outcome_unknown',
  })
  expect(readFileSync(join(s.linked, 'file'), 'utf8')).toBe('later\n')
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: false,
  })
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: true,
  })
  await expect(s.request('repository.v1.write', p, 'new-save')).rejects.toThrow('unauthorized')
})
it('recovers external intents after restart without replaying the effect', async () => {
  const s = await setup()
  await s.request('repository.v1.editing', { worktree_id: s.external, enabled: true })
  const p = {
    worktree_id: s.external,
    path: 'file',
    expected_content_id: hash('before\n'),
    text: 'after\n',
  }
  s.core.resources.mutations.fault = (point) => {
    if (point === 'after_write') throw new Error('fixture crash')
  }
  await expect(s.request('repository.v1.write', p, 'restart-save')).rejects.toThrow('fixture crash')
  await s.core.resources.stop()
  s.core.close()
  cores.splice(cores.indexOf(s.core), 1)
  writeFileSync(join(s.linked, 'file'), 'later\n')
  const core = new NodeCore(join(s.dir, 'state'))
  cores.push(core)
  const result = (await core.request(s.actor, 'repository.v1.write', p, 'restart-save')) as any
  expect(result.state).toBe('outcome_unknown')
  expect(readFileSync(join(s.linked, 'file'), 'utf8')).toBe('later\n')
  const recovery = (await core.request(s.actor, 'repository.v1.recovery.read', {
    worktree_id: s.external,
    recovery_path: result.recovery_path,
  })) as any
  expect(Buffer.from(recovery.base64, 'base64').toString()).toBe('before\n')
})
it('refuses historical saves and unsafe paths, and approval cannot follow a replaced worktree', async () => {
  const s = await setup()
  await s.request('repository.v1.editing', { worktree_id: s.external, enabled: true })
  const p = {
    worktree_id: s.external,
    path: 'file',
    expected_content_id: hash('before\n'),
    text: 'after\n',
  }
  const revision = await s.request('repository.v1.resolve', {
    worktree_id: s.external,
    ref: 'HEAD',
  })
  await expect(s.request('repository.v1.write', { ...p, revision })).rejects.toThrow(
    'invalid_params'
  )
  for (const path of ['../file', '.git/config', '/file'])
    await expect(s.request('repository.v1.write', { ...p, path })).rejects.toThrow('invalid_params')
  symlinkSync(join(s.repo, 'file'), join(s.linked, 'alias'))
  await expect(s.request('repository.v1.write', { ...p, path: 'alias' })).rejects.toThrow(
    'unsafe_path'
  )
  const gitfile = readFileSync(join(s.linked, '.git'))
  renameSync(s.linked, join(s.dir, 'old-linked'))
  mkdirSync(s.linked)
  writeFileSync(join(s.linked, '.git'), gitfile)
  writeFileSync(join(s.linked, 'file'), 'before\n')
  const entry = (
    await s.request('repository.v1.worktrees', { project_id: s.project.project_id })
  ).entries.find((e: any) => e.kind === 'external')
  expect(entry.worktree_id).not.toBe(s.external)
  await expect(
    s.request('repository.v1.write', { ...p, worktree_id: entry.worktree_id })
  ).rejects.toThrow('unauthorized')
  await expect(s.request('repository.v1.write', p)).rejects.toThrow('stale_resource')
})
it('returns conflict if an external editor removes the file after durable intent', async () => {
  const s = await setup()
  await s.request('repository.v1.editing', { worktree_id: s.external, enabled: true })
  s.core.resources.mutations.fault = (point) => {
    if (point === 'after_intent') rmSync(join(s.linked, 'file'))
  }
  expect(
    await s.request('repository.v1.write', {
      worktree_id: s.external,
      path: 'file',
      expected_content_id: hash('before\n'),
      text: 'must not recreate\n',
    })
  ).toMatchObject({ state: 'conflict', predecessor_content_id: null })
})
it('rechecks owner authority after durable intent and before truncation', async () => {
  const s = await setup()
  await s.request('repository.v1.editing', { worktree_id: s.external, enabled: true })
  s.core.resources.mutations.fault = (point) => {
    if (point === 'after_intent') s.core.revokeToken(s.actor.installation_id)
  }
  await expect(
    s.request('repository.v1.write', {
      worktree_id: s.external,
      path: 'file',
      expected_content_id: hash('before\n'),
      text: 'must not write\n',
    })
  ).rejects.toThrow('unauthorized')
  expect(readFileSync(join(s.linked, 'file'), 'utf8')).toBe('before\n')
})
it('caches immutable blobs across linked worktrees, not mutable working contents', async () => {
  const s = await setup(),
    revision = await s.request('repository.v1.resolve', { worktree_id: s.root, ref: 'HEAD' })
  const run = vi.spyOn(s.core.resources.git, 'run')
  for (const worktree_id of [s.root, s.external, s.root])
    await s.request('repository.v1.blob', { worktree_id, revision, path: 'file' })
  expect(run.mock.calls.filter(([, c]) => c.kind === 'blob')).toHaveLength(1)
  for (const text of ['one\n', 'two\n']) {
    writeFileSync(join(s.repo, 'file'), text)
    const working = (await s.request('repository.v1.observe', { worktree_id: s.root })).revision
    expect(
      await s.request('repository.v1.blob', {
        worktree_id: s.root,
        revision: working,
        path: 'file',
      })
    ).toMatchObject({ content_id: hash(text) })
  }
})
it('isolates object caches by repository and invalidates authority generations', async () => {
  const s = await setup()
  const other = join(s.dir, 'other-repo')
  git(s.repo, 'clone', '--local', s.repo, other)
  const project = await s.request('project.register', { path: other, trust: 'untrusted' })
  const id = (await s.request('repository.v1.worktrees', { project_id: project.project_id }))
    .entries[0].worktree_id
  const revision = await s.request('repository.v1.resolve', { worktree_id: s.root, ref: 'HEAD' })
  const run = vi.spyOn(s.core.resources.git, 'run')
  for (const worktree_id of [s.root, id, s.root, id])
    await s.request('repository.v1.blob', { worktree_id, revision, path: 'file' })
  expect(run.mock.calls.filter(([, c]) => c.kind === 'blob')).toHaveLength(2)
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: false,
  })
  await s.request('repository.v1.blob', { worktree_id: s.root, revision, path: 'file' })
  expect(run.mock.calls.filter(([, c]) => c.kind === 'blob')).toHaveLength(3)
})
it('coalesces rapid hints and reconciles index, HEAD, refs and catalogue changes', async () => {
  const s = await setup(),
    repository = s.core.resources.repository as any
  const watched = await s.request('repository.v1.watch', { worktree_id: s.external })
  const subscription = repository.subscriptions.get(watched.subscription_id)
  const invalidations = (after: number) =>
    s.core.read('catalog', after).filter((e) => e.type === 'repository.invalidated')
  let before = s.core.head('catalog')
  for (let i = 0; i < 20; i++) subscription.watchers[0].emit('change', 'change', 'file')
  await wait(() => invalidations(before).length > 0)
  await new Promise((r) => setTimeout(r, 200))
  expect(invalidations(before)).toHaveLength(1)
  for (const change of [
    () => {
      writeFileSync(join(s.linked, 'file'), 'indexed\n')
      git(s.linked, 'add', 'file')
    },
    () => {
      git(s.linked, 'commit', '-m', 'new HEAD')
    },
    () => {
      git(s.repo, 'branch', 'new-ref')
    },
    () => {
      git(s.repo, 'worktree', 'add', '-b', 'another', join(s.dir, 'another'))
    },
  ]) {
    before = s.core.head('catalog')
    change()
    await wait(() => invalidations(before).length > 0)
  }
}, 30000)
it('stops revoked subscriptions immediately and fences old external notifications', async () => {
  const s = await setup()
  await s.request('repository.v1.watch', { worktree_id: s.external })
  const event = s.core.read('catalog', 0).find((e) => e.type === 'repository.invalidated')!
  expect(s.core.canPublishEvent(s.actor, event)).toBe(true)
  await s.request('project.repository_settings', {
    project_id: s.project.project_id,
    external_read: false,
  })
  expect(s.core.canPublishEvent(s.actor, event)).toBe(false)
  await s.request('repository.v1.watch', { worktree_id: s.root })
  s.core.revokeToken(s.actor.installation_id)
  expect((s.core.resources.repository as any).subscriptions.size).toBe(0)
})
it('cannot leak watcher handles when authority is revoked during subscription setup', async () => {
  const s = await setup(),
    repository = s.core.resources.repository as any
  const original = repository.watchFingerprint.bind(repository)
  let entered = false,
    release!: () => void
  const gate = new Promise<void>((r) => {
    release = r
  })
  vi.spyOn(repository, 'watchFingerprint').mockImplementation(async (...args: any[]) => {
    entered = true
    await gate
    return original(...args)
  })
  const pending = s.request('repository.v1.watch', { worktree_id: s.root })
  await wait(() => entered)
  s.core.revokeToken(s.actor.installation_id)
  release()
  await expect(pending).rejects.toThrow('unauthorized')
  expect(repository.subscriptions.size).toBe(0)
})
it('does not lose overflow arriving during an in-flight reconciliation', async () => {
  const s = await setup(),
    repository = s.core.resources.repository as any
  const watched = await s.request('repository.v1.watch', { worktree_id: s.root })
  const subscription = repository.subscriptions.get(watched.subscription_id)
  const original = repository.watchFingerprint.bind(repository)
  let release!: () => void,
    entered = false
  const gate = new Promise<void>((r) => {
    release = r
  })
  vi.spyOn(repository, 'watchFingerprint').mockImplementation(async (...args: any[]) => {
    if (!entered) {
      entered = true
      await gate
    }
    return original(...args)
  })
  const before = s.core.head('catalog')
  subscription.watchers[0].emit('change', 'change', 'file')
  await wait(() => entered)
  subscription.watchers[0].emit('error', new Error('fixture overflow'))
  release()
  await wait(() =>
    s.core
      .read('catalog', before)
      .some((e) => e.type === 'repository.invalidated' && (e.data as any).reason === 'overflow')
  )
})
