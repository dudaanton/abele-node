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
import { CommandContextSchema, CommandContextRunSchema } from '@abele/node-protocol'
import {
  processScenarioDeadline,
  waitForProcessCondition,
} from '../scripts/process-test-budget.mjs'

const roots: string[] = [],
  cores: NodeCore[] = []
it('creates a command-only parent context, prepares Ask and executes only its exact approval', async () => {
  const f = await fixture()
  const count = () => f.core.db.prepare('SELECT count(*) AS n FROM sessions').get()!.n
  const before = count()
  const params = { parent_chat_id: 'ordinary-chat', project_id: f.project.project_id }
  const context = await f.request('command.context.v1.create', params, 'create-context')
  CommandContextSchema.parse(context)
  const [reused, concurrent] = await Promise.all([
    f.request('command.context.v1.create', params),
    f.request('command.context.v1.create', params),
  ])
  expect(reused).toEqual(context)
  expect(concurrent).toEqual(context)
  expect(await f.request('command.context.v1.create', params, 'create-context')).toEqual(context)
  expect(await f.request('command.context.v1.create', params)).toEqual(context)
  expect(count()).toBe(before)
  const binding = { context_id: context.context_id, parent_chat_id: params.parent_chat_id }
  const p = {
    ...binding,
    argv: [process.execPath, '--version'],
    permission_mode: 'ask',
    justification: 'Check runtime',
  }
  const prepared = await f.request('command.context.v1.prepare', p, 'prepare-command')
  CommandContextRunSchema.parse(prepared)
  expect(prepared.justification).toBe(p.justification)
  expect(prepared.approval.input).not.toHaveProperty('justification')
  expect(await f.request('command.context.v1.prepare', p, 'prepare-command')).toEqual(prepared)
  await expect(
    f.request('command.context.v1.prepare', { ...p, permission_mode: 'bypass' }, 'prepare-command')
  ).rejects.toThrow('idempotency_mismatch')
  expect(prepared.approval.input).toMatchObject({ argv: p.argv, cwd: f.folder })
  expect(prepared.state).toBe('pending_approval')
  await f.core.manager.settled()
  const approval = {
    ...binding,
    run_id: prepared.run_id,
    action_digest: prepared.approval.action_digest,
    choice: 'allow',
  }
  await expect(
    f.request('command.context.v1.execute', { ...approval, action_digest: 'wrong' })
  ).rejects.toThrow('stale_approval')
  await f.request('command.context.v1.execute', approval, 'approve-command')
  await f.request('command.context.v1.execute', approval, 'approve-command')
  await f.core.manager.settled()
  expect(
    await f.request('command.context.v1.status', { ...binding, run_id: prepared.run_id })
  ).toMatchObject({ state: 'exited', stdout: process.version + '\n' })
  await expect(
    f.request('command.context.v1.status', {
      ...binding,
      parent_chat_id: 'another-chat',
      run_id: prepared.run_id,
    })
  ).rejects.toThrow('unauthorized')
})

it('executes bypass directly and diagnoses missing context resources', async () => {
  const f = await fixture()
  await expect(
    f.request('command.v1.run', {
      session_id: 'missing',
      project_id: f.project.project_id,
      command: 'true',
    })
  ).rejects.toMatchObject({ details: { resource: 'session' } })
  await expect(
    f.request('command.context.v1.create', { parent_chat_id: 'chat', project_id: 'missing' })
  ).rejects.toThrow('project')
  await expect(
    f.request('command.context.v1.create', { parent_chat_id: 'chat', worktree_id: 'missing' })
  ).rejects.toThrow('worktree')
  const context = await f.request('command.context.v1.create', {
    parent_chat_id: 'chat',
    worktree_id: f.root,
  })
  const binding = { context_id: context.context_id, parent_chat_id: 'chat' }
  await expect(
    f.request('command.context.v1.prepare', { ...binding, command: 'true' })
  ).rejects.toThrow('permission_mode')
  await expect(
    f.request('command.context.v1.prepare', {
      ...binding,
      command: 'true',
      cwd: 'missing',
      permission_mode: 'ask',
    })
  ).rejects.toThrow('cwd')
  await expect(
    f.request('command.context.v1.prepare', {
      ...binding,
      context_id: 'missing',
      command: 'true',
      permission_mode: 'ask',
    })
  ).rejects.toThrow('context')
  const run = await f.request(
    'command.context.v1.prepare',
    { ...binding, argv: [process.execPath, '--version'], permission_mode: 'bypass' },
    'bypass-command'
  )
  expect(run.approval).toBeNull()
  expect(run.state).toBe('running')
  CommandContextRunSchema.parse(run)
  await f.core.manager.settled()
  expect(
    await f.request('command.context.v1.status', { ...binding, run_id: run.run_id })
  ).toMatchObject({ state: 'exited' })
  expect(f.core.read(context.stream_id, 0, 256).filter((e) => e.type === 'prompt.opened')).toEqual(
    []
  )
})

it('keeps bypass commands visible, cancellable and idempotent after a restart', async () => {
  const f = await fixture()
  const context = await f.request('command.context.v1.create', {
    parent_chat_id: 'bypass-chat',
    project_id: f.project.project_id,
  })
  const binding = { context_id: context.context_id, parent_chat_id: 'bypass-chat' }
  const p = {
    ...binding,
    permission_mode: 'bypass',
    argv: [
      process.execPath,
      '-e',
      "require('node:fs').appendFileSync('bypass-effects', 'once\\n'); console.log('ready'); setInterval(() => {}, 1000)",
    ],
    justification: '$(touch metadata-must-not-execute)',
  }
  const run = await f.request('command.context.v1.prepare', p, 'bypass-restart')
  await waitForProcessCondition(async () => {
    const status = await f.request('command.context.v1.status', { ...binding, run_id: run.run_id })
    return status.stdout.includes('ready')
  }, 'bypass command output')
  expect(f.core.read(context.stream_id, 0, 256).some((e) => e.type === 'command.output')).toBe(true)
  await f.request('command.context.v1.cancel', { ...binding, run_id: run.run_id })
  await f.core.manager.settled()
  expect(
    await f.request('command.context.v1.status', { ...binding, run_id: run.run_id })
  ).toMatchObject({ state: 'cancelled' })
  expect(readFileSync(join(f.folder, 'bypass-effects'), 'utf8')).toBe('once\n')
  expect(existsSync(join(f.folder, 'metadata-must-not-execute'))).toBe(false)
  await f.core.resources.stop()
  f.core.close()
  cores.splice(cores.indexOf(f.core), 1)
  const restarted = new NodeCore(join(f.dir, 'state'))
  cores.push(restarted)
  expect(
    await restarted.request(f.actor, 'command.context.v1.prepare', p, 'bypass-restart')
  ).toEqual(run)
  await restarted.manager.settled()
  expect(readFileSync(join(f.folder, 'bypass-effects'), 'utf8')).toBe('once\n')
})

it('retains exact Ask approval and effect receipts across restarts without replay', async () => {
  const f = await fixture()
  const params = { parent_chat_id: 'restart-chat', project_id: f.project.project_id }
  const context = await f.request('command.context.v1.create', params, 'restart-create')
  const binding = { context_id: context.context_id, parent_chat_id: params.parent_chat_id }
  const marker = join(f.folder, 'effects')
  const command = {
    ...binding,
    argv: [process.execPath, '-e', "require('node:fs').appendFileSync('effects', 'once\\n')"],
    permission_mode: 'ask',
  }
  const prepared = await f.request('command.context.v1.prepare', command, 'restart-prepare')
  expect(existsSync(marker)).toBe(false)
  let current = f.core
  const restart = async () => {
    await current.manager.stop()
    await current.resources.stop()
    current.close()
    cores.splice(cores.indexOf(current), 1)
    current = new NodeCore(join(f.dir, 'state'))
    cores.push(current)
  }
  const request = (method: string, p: unknown, op = method): Promise<any> =>
    Promise.resolve(current.request(f.actor, method, p, op))
  await restart()
  expect(await request('command.context.v1.create', params, 'restart-create')).toEqual(context)
  expect(await request('command.context.v1.prepare', command, 'restart-prepare')).toEqual(prepared)
  expect(
    await request('command.context.v1.status', { ...binding, run_id: prepared.run_id })
  ).toMatchObject({ state: 'pending_approval', approval: { state: 'pending' } })
  const approval = {
    ...binding,
    run_id: prepared.run_id,
    action_digest: prepared.approval.action_digest,
    choice: 'allow',
  }
  const receipt = await request('command.context.v1.execute', approval, 'restart-approve')
  await current.manager.settled()
  expect(readFileSync(marker, 'utf8')).toBe('once\n')
  await restart()
  expect(await request('command.context.v1.execute', approval, 'restart-approve')).toEqual(receipt)
  await current.manager.settled()
  expect(readFileSync(marker, 'utf8')).toBe('once\n')
  await expect(
    request(
      'command.context.v1.prepare',
      { ...command, command: 'false', argv: undefined },
      'restart-prepare'
    )
  ).rejects.toThrow('idempotency_mismatch')
})

it('denies or cancels context commands and rechecks trust after preparation', async () => {
  const f = await fixture()
  const context = await f.request('command.context.v1.create', {
    parent_chat_id: 'chat',
    worktree_id: f.root,
  })
  const binding = { context_id: context.context_id, parent_chat_id: 'chat' }
  const prepare = () =>
    f.request('command.context.v1.prepare', {
      ...binding,
      command: 'touch must-not-exist',
      permission_mode: 'ask',
    })
  const denied = await prepare()
  await f.request('command.context.v1.execute', {
    ...binding,
    run_id: denied.run_id,
    action_digest: denied.approval.action_digest,
    choice: 'deny',
  })
  expect(
    await f.request('command.context.v1.status', { ...binding, run_id: denied.run_id })
  ).toMatchObject({ state: 'denied' })
  const cancelled = await prepare()
  await expect(
    f.request('command.context.v1.cancel', {
      ...binding,
      parent_chat_id: 'wrong',
      run_id: cancelled.run_id,
    })
  ).rejects.toThrow('unauthorized')
  const other = f.core.authority.authenticate(f.core.createToken('other-installation').token)
  await expect(
    f.core.request(
      other,
      'command.context.v1.cancel',
      { ...binding, run_id: cancelled.run_id },
      'foreign-cancel'
    )
  ).rejects.toThrow('unauthorized')
  await f.request(
    'command.context.v1.cancel',
    { ...binding, run_id: cancelled.run_id },
    'cancel-command'
  )
  await f.request(
    'command.context.v1.cancel',
    { ...binding, run_id: cancelled.run_id },
    'cancel-command'
  )
  await expect(
    f.request('command.context.v1.execute', {
      ...binding,
      run_id: cancelled.run_id,
      action_digest: cancelled.approval.action_digest,
      choice: 'allow',
    })
  ).rejects.toThrow('stale_approval')
  const stale = await prepare()
  await f.request('project.trust', { project_id: f.project.project_id, trust: 'untrusted' })
  await f.request('command.context.v1.execute', {
    ...binding,
    run_id: stale.run_id,
    action_digest: stale.approval.action_digest,
    choice: 'allow',
  })
  await f.core.manager.settled()
  expect(
    await f.request('command.context.v1.status', { ...binding, run_id: stale.run_id })
  ).toMatchObject({ state: 'failed', reason: 'project_untrusted' })
  expect(existsSync(join(f.folder, 'must-not-exist'))).toBe(false)
  await expect(prepare()).rejects.toThrow('project_untrusted')
})
it('explains a workspace ID supplied in a worktree field before asking for approval', async () => {
  const f = await fixture()
  const row = f.core.db.prepare('SELECT workspace_id FROM workspaces LIMIT 1').get()!
  await expect(
    f.request('command.v1.run', {
      session_id: f.session.session_id,
      worktree_id: row.workspace_id,
      argv: ['true'],
    })
  ).rejects.toThrow('workspace_id')
})
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
    // Await child reaping / git completion, not a three-second polling allowance.
    // Vitest's deadline remains the hang guard if the operation never settles.
    await core.manager.settled()
    const status = await request('command.v1.status', {
      session_id: session.session_id,
      run_id: run.run_id,
    })
    expect(['pending_approval', 'running']).not.toContain(status.state)
    return status
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
it('publishes the exact shell command and argv directly in its single approval', async () => {
  const f = await fixture()
  const command = 'printf "%s\\n" "a  b"\n# retain whitespace and quoting'
  const shell = await f.request('command.v1.run', { ...f.base, command })
  expect(f.core.prompt(shell.prompt_id).input).toMatchObject({ command })
  const argv = ['printf', '%s\n', 'a  b']
  const direct = await f.request('command.v1.run', { ...f.base, argv })
  expect(f.core.prompt(direct.prompt_id).input).toMatchObject({ argv })
  expect(f.core.prompts(f.session.session_id)).toHaveLength(2)
  expect(f.core.prompt(shell.prompt_id).state).toBe('pending')
})
// Child startup and reaping may be slow on CI; completion evidence drives the test.
it(
  'stops a command if streaming output cannot be journaled',
  { timeout: processScenarioDeadline(1) },
  async () => {
    const f = await fixture()
    const append = f.core.append.bind(f.core)
    vi.spyOn(f.core, 'append').mockImplementation((stream, type, actor, data) => {
      if (type === 'command.output') throw new Error('fixture storage failure')
      return append(stream, type, actor, data)
    })
    const run = await f.request('command.v1.run', {
      ...f.base,
      // Keep the output producer alive without racing a shell spawning sleep against SIGKILL.
      argv: [process.execPath, '-e', 'console.log("output"); setInterval(() => {}, 30_000)'],
    })
    await f.approve(run)
    // Wait for the child to be reaped, without the fixture's shorter status-polling budget.
    // The child stays alive indefinitely, so failing to kill it still hits the test deadline.
    await f.core.manager.settled()
    expect(
      await f.request('command.v1.status', {
        session_id: f.session.session_id,
        run_id: run.run_id,
      })
    ).toMatchObject({ state: 'cancelled', reason: 'storage_unavailable', signal: 'SIGKILL' })
  }
)
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
  const head = f.core.head(f.session.session_id)
  await expect(f.request('command.v1.run', { ...f.base, argv: ['true'] })).rejects.toMatchObject({
    code: 'resource_busy',
  })
  expect(f.core.read(f.session.session_id, head).some((e) => e.type === 'prompt.opened')).toBe(
    false
  )
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
// Child startup and reaping may be slow on CI; completion evidence drives the test.
it(
  'supports a trusted plain folder project and reaps a command on graceful shutdown',
  { timeout: processScenarioDeadline(1) },
  async () => {
    const f = await fixture()
    const folder = join(f.dir, 'plain')
    mkdirSync(folder)
    const project = await f.request('project.register', { path: folder, trust: 'trusted' })
    const run = await f.request('command.v1.run', {
      session_id: f.session.session_id,
      project_id: project.project_id,
      argv: [
        process.execPath,
        '-e',
        'setTimeout(() => console.log("started"), 100); setInterval(() => {}, 30_000)',
      ],
    })
    await f.approve(run)
    // Exercise shutdown after the child actually produces output, even with a slow spawn.
    await waitForProcessCondition(async () => {
      const status = await f.request('command.v1.status', {
        session_id: f.session.session_id,
        run_id: run.run_id,
      })
      return status.stdout === 'started\n'
    }, 'manager command startup')
    expect(
      await f.request('command.v1.status', {
        session_id: f.session.session_id,
        run_id: run.run_id,
      })
    ).toMatchObject({ state: 'running', stdout: 'started\n' })
    await f.core.resources.stop()
    expect(await f.wait(run)).toMatchObject({ state: 'cancelled', reason: 'node_shutdown' })
    expect(f.core.resources.targets.leasedPath(folder)).toBe(false)
  }
)
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
