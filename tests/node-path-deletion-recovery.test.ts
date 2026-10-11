import { afterEach, expect, it, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
const dirs: string[] = [],
  cores: NodeCore[] = []
async function crashed(point: 'after-effect' | 'before-effect' | 'after-evidence') {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/deletion-recovery-'))
  dirs.push(dir)
  const folder = join(dir, 'folder'),
    external = join(dir, 'external'),
    state = join(dir, 'state'),
    requestFile = join(dir, 'request.json')
  mkdirSync(folder)
  const git = (...args: string[]) => {
    const p = spawnSync('/usr/bin/git', args, { cwd: folder, encoding: 'utf8' })
    if (p.status) throw new Error(p.stderr)
    return p.stdout.trim()
  }
  git('init', '-b', 'trunk')
  git('config', 'user.name', 'Fixture')
  git('config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(folder, 'source'), 'contents')
  git('add', '.')
  git('commit', '-m', 'initial')
  git('worktree', 'add', '-b', 'side', external)
  const core = new NodeCore(state),
    token = core.createToken('fixture'),
    actor = core.authority.authenticate(token.token)
  await (core.resources as any).ready
  const project = (await core.request(
    actor,
    'project.register',
    { path: folder, trust: 'untrusted' },
    'register'
  )) as any
  await core.request(
    actor,
    'project.repository_settings',
    { project_id: project.project_id, external_read: true },
    'settings'
  )
  const worktree = (
    (await core.request(actor, 'repository.v1.worktrees', {
      project_id: project.project_id,
    })) as any
  ).entries.find((e: any) => e.kind === 'external')
  await core.resources.stop()
  core.close()
  const child = spawn(
    process.execPath,
    [
      resolve('tests/fixtures/worktree-delete-crash.mjs'),
      state,
      worktree.worktree_id,
      requestFile,
      point,
    ],
    { env: { ...process.env, FIXTURE_OWNER_TOKEN: token.token }, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let stderr = ''
  child.stderr.on('data', (b) => {
    stderr += b.toString()
  })
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject)
      child.once('close', (code, signal) => resolve({ code, signal }))
    }
  )
  expect(result, stderr).toEqual({ code: null, signal: 'SIGKILL' })
  const db = new DatabaseSync(join(state, 'node.sqlite'))
  expect(db.prepare('SELECT count(*) AS n FROM execution_target_reservations').get()).toEqual({
    n: 1,
  })
  expect(db.prepare('SELECT count(*) AS n FROM repository_deletions').get()).toEqual({ n: 1 })
  db.close()
  return {
    dir,
    state,
    external,
    project,
    token,
    params: JSON.parse(readFileSync(requestFile, 'utf8')),
    git,
  }
}
it('keeps an unconfirmed/live-process fence, exposes its reason and lets the protected owner CLI check again without replay', async () => {
  const s = await crashed('after-evidence'),
    core = new NodeCore(s.state)
  cores.push(core)
  const probe = {
    identity: vi.fn(() => {
      throw new Error('process_inventory_unavailable')
    }),
    groupMembers: vi.fn(() => {
      throw new Error('process_inventory_unavailable')
    }),
  }
  core.resources.repository.deletionProbe = probe
  await core.resources.ready
  const actor = core.authority.authenticate(s.token.token)
  const unknown = (await core.request(
    actor,
    'repository.v1.worktree.delete',
    s.params,
    'crash-delete'
  )) as any
  expect(unknown).toMatchObject({
    state: 'outcome_unknown',
    reconciliation: 'unresolved',
    reason: 'git_process_unconfirmed',
  })
  expect(core.db.prepare('SELECT count(*) AS n FROM execution_target_reservations').get()).toEqual({
    n: 1,
  })
  const intent = JSON.parse(
    (core.db.prepare('SELECT body FROM repository_deletions').get() as { body: string }).body
  )
  core.resources.repository.deletionProbe = {
    identity: () => intent.process,
    groupMembers: () => [intent.process],
  }
  expect(
    await core.request(actor, 'repository.v1.worktree.delete', s.params, 'crash-delete')
  ).toMatchObject({ state: 'outcome_unknown', reason: 'git_process_live' })
  await expect(
    Promise.resolve().then(() =>
      core.request(actor, 'project.remove', { project_id: s.project.project_id }, 'blocked-remove')
    )
  ).rejects.toThrow('resource_busy')
  await core.resources.stop()
  core.close()
  cores.splice(cores.indexOf(core), 1)
  const cli = spawnSync(
    process.execPath,
    [
      resolve('packages/node-daemon/dist/cli.js'),
      '--state-dir',
      s.state,
      'recover-worktree-deletion',
      'crash-delete',
      '--json',
    ],
    { encoding: 'utf8', timeout: 15000 }
  )
  expect(cli.status, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout)).toEqual([
    expect.objectContaining({
      operation_id: 'crash-delete',
      state: 'not_applied',
      reconciliation: 'not_applied',
    }),
  ])
  expect(existsSync(s.external)).toBe(true)
  const db = new DatabaseSync(join(s.state, 'node.sqlite'))
  expect(db.prepare('SELECT count(*) AS n FROM execution_target_reservations').get()).toEqual({
    n: 0,
  })
  expect(db.prepare('SELECT count(*) AS n FROM repository_deletions').get()).toEqual({ n: 0 })
  db.close()
})
it.each(['rpc', 'repository'] as const)(
  'reconciles a legacy unknown receipt with a surviving intent on retained-ID %s retry under the repository lock',
  async (entry) => {
    const s = await crashed('after-evidence'),
      core = new NodeCore(s.state)
    cores.push(core)
    const body = JSON.parse(
      (core.db.prepare('SELECT body FROM repository_deletions').get() as { body: string }).body
    )
    core.resources.repository.deletionProbe = {
      identity: () => body.process,
      groupMembers: () => [body.process],
    }
    await core.resources.ready
    const actor = core.authority.authenticate(s.token.token)
    core.db
      .prepare(
        'INSERT INTO operations(principal_id,operation_id,request_hash,receipt) SELECT principal_id,operation_id,request_hash,? FROM repository_deletions'
      )
      .run(JSON.stringify({ worktree_id: s.params.worktree_id, state: 'outcome_unknown' }))
    const retry = () =>
      entry === 'rpc'
        ? core.request(actor, 'repository.v1.worktree.delete', s.params, 'crash-delete')
        : core.resources.repository.deleteWorktree(actor, s.params, 'crash-delete')
    expect(await retry()).toMatchObject({
      state: 'outcome_unknown',
      reason: 'git_process_live',
      reservation_retained: true,
    })
    let locked = false
    const serialize = core.resources.git.serialize.bind(core.resources.git)
    vi.spyOn(core.resources.git, 'serialize').mockImplementation((key, work) =>
      serialize(key, async () => {
        locked = true
        try {
          return await work()
        } finally {
          locked = false
        }
      })
    )
    core.resources.repository.deletionProbe = {
      identity: () => {
        expect(locked).toBe(true)
        return undefined
      },
      groupMembers: () => {
        expect(locked).toBe(true)
        return []
      },
    }
    const calls = vi.spyOn(core.resources.git, 'run')
    expect(await retry()).toMatchObject({
      state: 'not_applied',
      reconciliation: 'not_applied',
      reservation_retained: false,
    })
    expect(calls.mock.calls.some(([, command]) => command.kind === 'worktree.remove')).toBe(false)
    expect(
      core.db.prepare('SELECT count(*) AS n FROM execution_target_reservations').get()
    ).toEqual({ n: 0 })
    expect(core.db.prepare('SELECT count(*) AS n FROM repository_deletions').get()).toEqual({
      n: 0,
    })
    expect(await retry()).toMatchObject({ state: 'not_applied' })
  }
)
afterEach(async () => {
  vi.restoreAllMocks()
  for (const c of cores.splice(0)) {
    await c.resources.stop()
    c.close()
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
it.each(['after-effect', 'before-effect'] as const)(
  'reconciles a real hard kill %s without replaying removal or retaining an orphan fence',
  async (point) => {
    const s = await crashed(point),
      core = new NodeCore(s.state)
    cores.push(core)
    const run = vi.spyOn(core.resources.git, 'run')
    await (core.resources as any).ready
    const actor = core.authority.authenticate(s.token.token)
    const result = (await core.request(
      actor,
      'repository.v1.worktree.delete',
      s.params,
      'crash-delete'
    )) as any
    expect(result).toMatchObject({
      worktree_id: s.params.worktree_id,
      state: point === 'after-effect' ? 'deleted' : 'not_applied',
      reconciliation: point === 'after-effect' ? 'applied_as_observed' : 'not_applied',
    })
    expect(run.mock.calls.some(([, command]) => command.kind === 'worktree.remove')).toBe(false)
    expect(
      core.db.prepare('SELECT count(*) AS n FROM execution_target_reservations').get()
    ).toEqual({ n: 0 })
    expect(core.db.prepare('SELECT count(*) AS n FROM repository_deletions').get()).toEqual({
      n: 0,
    })
    expect(existsSync(s.external)).toBe(point === 'before-effect')
    await core.request(
      actor,
      'project.trust',
      { project_id: s.project.project_id, trust: 'trusted' },
      'trust-after-recovery'
    )
    await core.request(
      actor,
      'project.claude_permissions',
      { project_id: s.project.project_id, use_repository_permissions: true },
      'permissions-after-recovery'
    )
    expect(
      await core.request(
        actor,
        'project.remove',
        { project_id: s.project.project_id },
        'remove-after-recovery'
      )
    ).toMatchObject({ removed: true })
  }
)
