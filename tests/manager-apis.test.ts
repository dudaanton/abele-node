import { afterEach, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  existsSync,
  rmSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
} from 'node:fs'
import { resolve, join } from 'node:path'
import { NodeCore } from '../packages/node-core/src/index.js'
import { OwnerGit } from '../packages/node-core/src/git-owner.js'
import { ChannelError } from '@abele/channel-protocol'

const roots: string[] = [],
  cores: NodeCore[] = []
const git = (cwd: string, ...args: string[]) => {
  const result = spawnSync('/usr/bin/git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  })
  if (result.status !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}
async function fixture(trust = 'trusted') {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/manager-apis-'))
  roots.push(dir)
  const folder = join(dir, 'repo')
  mkdirSync(folder)
  git(folder, 'init', '-b', 'main')
  git(folder, 'config', 'user.name', 'Fixture')
  git(folder, 'config', 'user.email', 'fixture@example.invalid')
  writeFileSync(join(folder, 'sample'), 'initial\n')
  git(folder, 'add', '.')
  git(folder, 'commit', '-m', 'initial')
  const developer = join(dir, 'developer')
  git(folder, 'worktree', 'add', '-b', 'developer', developer)
  const core = new NodeCore(join(dir, 'state'))
  cores.push(core)
  const actor = core.authority.authenticate(core.createToken('controller').token)
  const owner = core.authority.authenticate(core.createToken('other-owner-device').token)
  let seq = 0
  const request = async (method: string, params: unknown, operation?: string): Promise<any> =>
    await core.request(actor, method, params, operation ?? `op-${++seq}`)
  const project = await request('project.register', { path: folder, trust })
  await request('project.repository_settings', {
    project_id: project.project_id,
    external_read: true,
  })
  const trees = await request('repository.v1.worktrees', { project_id: project.project_id })
  const root = trees.entries.find((t: any) => t.kind === 'root').worktree_id
  const source = trees.entries.find((t: any) => t.kind === 'external').worktree_id
  const session = await request('session.create', { provider: 'fake', title: 'manager' })
  const approve = async (run: any, choice = 'allow') => {
    const prompt = core.prompt(run.prompt_id)
    return core.request(
      owner,
      'prompt.answer',
      {
        session_id: session.session_id,
        prompt_id: prompt.prompt_id,
        run_id: prompt.run_id,
        revision: prompt.revision,
        action_digest: prompt.action_digest,
        choice,
      },
      `answer-${++seq}`
    )
  }
  const base = { session_id: session.session_id, worktree_id: root }
  const wait = async (run: any) => {
    for (let i = 0; i < 300; i++) {
      const status = await request('command.v1.status', {
        session_id: session.session_id,
        run_id: run.run_id,
      })
      if (!['pending_approval', 'running'].includes(status.state)) return status
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('run did not finish')
  }
  return {
    dir,
    folder,
    developer,
    core,
    actor,
    request,
    approve,
    base,
    wait,
    root,
    source,
    session,
    project,
  }
}
afterEach(async () => {
  for (const core of cores.splice(0)) {
    await core.manager.stop()
    await core.resources.stop()
    core.close()
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})
it('preserves an empty argv argument as a literal value', async () => {
  const f = await fixture()
  const run = await f.request('command.v1.run', {
    ...f.base,
    argv: [process.execPath, '-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ''],
  })
  await f.approve(run)
  expect(await f.wait(run)).toMatchObject({ state: 'exited', stdout: '[""]\n' })
})
it('reports an uncertain integration outcome when git loses its reply after advancing the target', async () => {
  const f = await fixture()
  writeFileSync(join(f.developer, 'sample'), 'developer\n')
  git(f.developer, 'commit', '-am', 'developer')
  const params = {
    ...f.base,
    source_worktree_id: f.source,
    target_branch: 'main',
    source_branch: 'developer',
    expected_target_head: git(f.folder, 'rev-parse', 'HEAD'),
    expected_source_head: git(f.developer, 'rev-parse', 'HEAD'),
  }
  const actual = OwnerGit.prototype.run
  vi.spyOn(OwnerGit.prototype, 'run').mockImplementation(async function (
    this: OwnerGit,
    cwd,
    args,
    options
  ) {
    const result = await actual.call(this, cwd, args, options)
    if (args[0] === 'merge') throw new ChannelError('git_timeout')
    return result
  })
  const run = await f.request('git.v1.integrate', params)
  await f.approve(run)
  expect(await f.wait(run)).toMatchObject({ state: 'outcome_unknown', reason: 'git_timeout' })
  expect(git(f.folder, 'rev-parse', 'HEAD')).toBe(params.expected_source_head)
})
it('delivers a manager approval once and never executes a repeated answer twice', async () => {
  const f = await fixture()
  const run = await f.request('command.v1.run', { ...f.base, command: 'echo once >>effect' })
  await f.approve(run)
  await f.approve(run)
  await f.wait(run)
  expect(f.core.prompt(run.prompt_id).delivered).toBe(true)
  expect(
    f.core.read(f.session.session_id, 0).filter((e) => e.type === 'prompt.delivered')
  ).toHaveLength(1)
  expect(readFileSync(join(f.folder, 'effect'), 'utf8')).toBe('once\n')
})
it('stops a command if streaming output cannot be journaled', async () => {
  const f = await fixture()
  const append = f.core.append.bind(f.core)
  vi.spyOn(f.core, 'append').mockImplementation((stream, type, actor, data) => {
    if (type === 'command.output') throw new Error('fixture storage failure')
    return append(stream, type, actor, data)
  })
  const run = await f.request('command.v1.run', { ...f.base, command: 'echo output; sleep 30' })
  await f.approve(run)
  expect(await f.wait(run)).toMatchObject({ state: 'cancelled', reason: 'storage_unavailable' })
})
it('runs in a registered project root and never passes daemon secrets into a command', async () => {
  const f = await fixture()
  process.env.MANAGER_FIXTURE_SECRET = 'must-not-pass'
  try {
    const run = await f.request('command.v1.run', {
      session_id: f.session.session_id,
      project_id: f.project.project_id,
      argv: [process.execPath, '-e', "console.log(process.env.MANAGER_FIXTURE_SECRET ?? 'absent')"],
    })
    await f.approve(run)
    expect(await f.wait(run)).toMatchObject({ state: 'exited', stdout: 'absent\n' })
    await expect(
      f.request('command.v1.run', {
        ...f.base,
        command: 'true',
        env: { NODE_OPTIONS: '--require=evil' },
      })
    ).rejects.toMatchObject({ code: 'invalid_params' })
  } finally {
    delete process.env.MANAGER_FIXTURE_SECRET
  }
})
it('rechecks trust and symlink cwd identity after approval and holds a worktree lease while running', async () => {
  const f = await fixture()
  mkdirSync(join(f.folder, 'nested'))
  symlinkSync('nested', join(f.folder, 'cwd'))
  const run = await f.request('command.v1.run', { ...f.base, command: 'touch unsafe', cwd: 'cwd' })
  rmSync(join(f.folder, 'cwd'))
  symlinkSync(f.dir, join(f.folder, 'cwd'))
  await f.approve(run)
  expect(await f.wait(run)).toMatchObject({ state: 'failed', reason: 'unsafe_path' })
  expect(existsSync(join(f.dir, 'unsafe'))).toBe(false)
  const revoked = await f.request('command.v1.run', { ...f.base, command: 'touch revoked' })
  await f.request('project.trust', { project_id: f.project.project_id, trust: 'untrusted' })
  await f.approve(revoked)
  expect(await f.wait(revoked)).toMatchObject({ state: 'failed', reason: 'project_untrusted' })
  await f.request('project.trust', { project_id: f.project.project_id, trust: 'trusted' })
  const running = await f.request('command.v1.run', { ...f.base, command: 'sleep 30' })
  await f.approve(running)
  await expect
    .poll(() => f.core.resources.targets.leasedPath(f.folder), { timeout: 2000 })
    .toBe(true)
  await f.request('command.v1.cancel', { session_id: f.session.session_id, run_id: running.run_id })
  await f.core.manager.settled()
  expect(f.core.resources.targets.leasedPath(f.folder)).toBe(false)
})
it('rebases in the developer worktree and aborts conflicts back to the original clean branch', async () => {
  const f = await fixture()
  writeFileSync(join(f.folder, 'sample'), 'main edit\n')
  git(f.folder, 'commit', '-am', 'main edit')
  writeFileSync(join(f.developer, 'sample'), 'developer edit\n')
  git(f.developer, 'commit', '-am', 'developer edit')
  const params = {
    ...f.base,
    source_worktree_id: f.source,
    target_branch: 'main',
    source_branch: 'developer',
    expected_target_head: git(f.folder, 'rev-parse', 'HEAD'),
    expected_source_head: git(f.developer, 'rev-parse', 'HEAD'),
    rebase: true,
  }
  const run = await f.request('git.v1.integrate', params)
  await f.approve(run)
  expect(await f.wait(run)).toMatchObject({
    state: 'failed',
    reason: 'rebase_conflict',
    conflicting_files: ['sample'],
  })
  expect(git(f.developer, 'rev-parse', 'HEAD')).toBe(params.expected_source_head)
  expect(git(f.folder, 'rev-parse', 'HEAD')).toBe(params.expected_target_head)
  expect(git(f.developer, 'status', '--porcelain')).toBe('')
  expect(readFileSync(join(f.developer, 'sample'), 'utf8')).toBe('developer edit\n')
})
it('successfully rebases disjoint changes before fast-forward integration', async () => {
  const f = await fixture()
  writeFileSync(join(f.folder, 'main-only'), 'main\n')
  git(f.folder, 'add', '.')
  git(f.folder, 'commit', '-m', 'main')
  writeFileSync(join(f.developer, 'dev-only'), 'dev\n')
  git(f.developer, 'add', '.')
  git(f.developer, 'commit', '-m', 'dev')
  git(f.developer, 'branch', 'unrelated-alias')
  git(f.developer, 'config', 'rebase.updateRefs', 'true')
  const alias = git(f.developer, 'rev-parse', 'unrelated-alias')
  const params = {
    ...f.base,
    source_worktree_id: f.source,
    target_branch: 'main',
    source_branch: 'developer',
    expected_target_head: git(f.folder, 'rev-parse', 'HEAD'),
    expected_source_head: git(f.developer, 'rev-parse', 'HEAD'),
    rebase: true,
  }
  const run = await f.request('git.v1.integrate', params)
  await f.approve(run)
  expect(await f.wait(run)).toMatchObject({
    state: 'applied',
    head: git(f.developer, 'rev-parse', 'HEAD'),
  })
  expect(git(f.folder, 'rev-parse', 'HEAD')).toBe(git(f.developer, 'rev-parse', 'HEAD'))
  expect(existsSync(join(f.folder, 'dev-only'))).toBe(true)
  expect(git(f.developer, 'rev-parse', 'unrelated-alias')).toBe(alias)
})
it('retains receipts across restart, invalidates old approvals and never replays a command', async () => {
  const f = await fixture()
  const params = { ...f.base, command: 'touch replayed' }
  const run = await f.request('command.v1.run', params, 'restart-command')
  await f.core.resources.stop()
  f.core.close()
  cores.splice(cores.indexOf(f.core), 1)
  const restarted = new NodeCore(join(f.dir, 'state'))
  cores.push(restarted)
  const status = await restarted.request(f.actor, 'command.v1.status', {
    session_id: f.session.session_id,
    run_id: run.run_id,
  })
  expect(status).toMatchObject({ state: 'outcome_unknown', reason: 'daemon_restart' })
  expect(await restarted.request(f.actor, 'command.v1.run', params, 'restart-command')).toEqual(run)
  expect(restarted.prompt(run.prompt_id).state).toBe('invalidated')
  expect(existsSync(join(f.folder, 'replayed'))).toBe(false)
})
it('supports a trusted plain folder project and reaps a command on graceful shutdown', async () => {
  const f = await fixture()
  const folder = join(f.dir, 'plain')
  mkdirSync(folder)
  const project = await f.request('project.register', { path: folder, trust: 'trusted' })
  const run = await f.request('command.v1.run', {
    session_id: f.session.session_id,
    project_id: project.project_id,
    command: 'echo started; sleep 30',
  })
  await f.approve(run)
  await new Promise((r) => setTimeout(r, 30))
  await f.core.resources.stop()
  expect(await f.wait(run)).toMatchObject({ state: 'cancelled', reason: 'node_shutdown' })
  expect(f.core.resources.targets.leasedPath(folder)).toBe(false)
})
it('requires an exact durable approval from another device, streams bounded output and returns exit status', async () => {
  const f = await fixture()
  const params = {
    ...f.base,
    argv: [
      process.execPath,
      '-e',
      "require('fs').writeFileSync('ran','yes'); process.stdout.write('x'.repeat(10000)); process.stderr.write('err'); process.exitCode=7",
    ],
    output_bytes: 1024,
  }
  const run = await f.request('command.v1.run', params, 'run-once')
  expect(run.state).toBe('pending_approval')
  expect(existsSync(join(f.folder, 'ran'))).toBe(false)
  expect(f.core.prompt(run.prompt_id).input).toMatchObject({ method: 'command.v1.run', params })
  expect(await f.request('command.v1.run', params, 'run-once')).toEqual(run)
  await f.approve(run)
  const result = await f.wait(run)
  expect(result).toMatchObject({
    state: 'exited',
    exit_code: 7,
    stderr: 'err',
    stdout_truncated: true,
  })
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(1100)
  expect(result.stdout).toContain('[truncated]')
  expect(f.core.read(f.session.session_id, 0).some((e) => e.type === 'command.output')).toBe(true)
})
it('refuses untrusted projects and cwd escapes before opening an approval', async () => {
  const f = await fixture('untrusted')
  await expect(f.request('command.v1.run', { ...f.base, argv: ['true'] })).rejects.toMatchObject({
    code: 'project_untrusted',
  })
  await f.request('project.trust', { project_id: f.project.project_id, trust: 'trusted' })
  await expect(
    f.request('command.v1.run', { ...f.base, argv: ['true'], cwd: '..' })
  ).rejects.toMatchObject({ code: 'unsafe_path' })
})
it('denies, times out and cancels runs without automatically executing a new request', async () => {
  const f = await fixture()
  const denied = await f.request('command.v1.run', { ...f.base, command: 'touch denied' })
  await f.approve(denied, 'deny')
  expect((await f.wait(denied)).state).toBe('denied')
  expect(existsSync(join(f.folder, 'denied'))).toBe(false)
  const timed = await f.request('command.v1.run', {
    ...f.base,
    argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
    timeout_ms: 30,
  })
  await f.approve(timed)
  expect((await f.wait(timed)).state).toBe('timed_out')
  const cancelled = await f.request('command.v1.run', { ...f.base, command: 'sleep 30' })
  await f.approve(cancelled)
  await f.request('command.v1.cancel', {
    session_id: f.session.session_id,
    run_id: cancelled.run_id,
  })
  expect((await f.wait(cancelled)).state).toBe('cancelled')
})
it('fast-forwards only the approved heads and refuses divergence or stale approval', async () => {
  const f = await fixture()
  writeFileSync(join(f.developer, 'sample'), 'developer\n')
  git(f.developer, 'commit', '-am', 'developer')
  const params = {
    ...f.base,
    source_worktree_id: f.source,
    target_branch: 'main',
    source_branch: 'developer',
    expected_target_head: git(f.folder, 'rev-parse', 'HEAD'),
    expected_source_head: git(f.developer, 'rev-parse', 'HEAD'),
  }
  const run = await f.request('git.v1.integrate', params)
  expect(git(f.folder, 'rev-parse', 'HEAD')).toBe(params.expected_target_head)
  await f.approve(run)
  expect(await f.wait(run)).toMatchObject({ state: 'applied', head: params.expected_source_head })
  writeFileSync(join(f.folder, 'sample'), 'main\n')
  git(f.folder, 'commit', '-am', 'main')
  const stale = await f.request('git.v1.integrate', {
    ...params,
    expected_target_head: git(f.folder, 'rev-parse', 'HEAD'),
  })
  writeFileSync(join(f.developer, 'sample'), 'next\n')
  git(f.developer, 'commit', '-am', 'next')
  await f.approve(stale)
  expect(await f.wait(stale)).toMatchObject({ state: 'failed', reason: 'stale_revision' })
  const divergent = await f.request('git.v1.integrate', {
    ...params,
    expected_target_head: git(f.folder, 'rev-parse', 'HEAD'),
    expected_source_head: git(f.developer, 'rev-parse', 'HEAD'),
  })
  await f.approve(divergent)
  expect(await f.wait(divergent)).toMatchObject({ state: 'failed', reason: 'not_fast_forward' })
})
