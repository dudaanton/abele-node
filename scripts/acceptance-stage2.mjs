// Disposable real CLI + node-client stage 2 acceptance. No plugin, providers or shared vaults.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeClient, MemoryClientStore } from '@abele/node-client'
import {
  processStepDeadlineMs,
  waitForProcessCondition,
  withProcessDeadline,
} from './process-test-budget.mjs'

mkdirSync('.scratch', { recursive: true })
const evidence = mkdtempSync(resolve('.scratch/acceptance-stage2-'))
const state = join(evidence, 'state')
const cli = resolve('packages/node-daemon/dist/cli.js')
const processes = new Set(),
  clients = new Set()
const until = (test) => waitForProcessCondition(test, 'stage 2 acceptance phase')
function run(cwd, executable, args) {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    timeout: processStepDeadlineMs,
    killSignal: 'SIGKILL',
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
function git(cwd, ...args) {
  return run(cwd, '/usr/bin/git', args)
}
async function start() {
  const child = spawn(
    process.execPath,
    [cli, '--json', 'start', '--state-dir', state, '--port', '0'],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  )
  processes.add(child)
  let text = '',
    error = ''
  child.stdout.on('data', (d) => {
    text += d
  })
  child.stderr.on('data', (d) => {
    error += d
  })
  await until(() => {
    if (child.exitCode !== null) throw new Error(error)
    return text.includes('"listening"')
  })
  return {
    child,
    ...JSON.parse(
      text
        .trim()
        .split('\n')
        .find((l) => l.includes('"listening"'))
    ),
  }
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((r) => child.once('exit', r))
  child.kill('SIGTERM')
  try {
    await withProcessDeadline(() => exited, 'stage 2 daemon exit')
  } catch (error) {
    child.kill('SIGKILL')
    await withProcessDeadline(() => exited, 'stage 2 daemon forced exit')
    throw error
  }
  processes.delete(child)
}
function connect(daemon, token, store) {
  const client = new NodeClient(
    {
      url: `ws://127.0.0.1:${daemon.port}/channel`,
      profile: 'local-token-v1',
      token,
      expected_node_id: daemon.node_id,
    },
    store
  )
  clients.add(client)
  return client
}
async function complete(client, job_id) {
  await until(async () => {
    const job = await client.getJob(job_id)
    if (['failed', 'needs_attention'].includes(job.state)) throw new Error(JSON.stringify(job))
    return job.state === 'succeeded'
  })
}
try {
  const repos = ['project one', 'project two'].map((name) => {
    const repo = join(evidence, name)
    mkdirSync(repo)
    git(repo, 'init', '-b', 'main')
    git(repo, 'config', 'user.name', 'Acceptance')
    git(repo, 'config', 'user.email', 'acceptance@example.invalid')
    writeFileSync(join(repo, '.fixture'), 'original\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'fixture')
    return repo
  })
  const original = repos.map((repo) => ({
    branch: git(repo, 'branch', '--show-current'),
    head: git(repo, 'rev-parse', 'HEAD'),
    status: git(repo, 'status', '--porcelain'),
    contents: readFileSync(join(repo, '.fixture'), 'utf8'),
  }))
  const credential = JSON.parse(
    run(process.cwd(), process.execPath, [
      cli,
      '--json',
      'token',
      'create',
      'stage2-acceptance',
      '--state-dir',
      state,
    ])
  )
  let daemon = await start(),
    store = new MemoryClientStore(),
    client = connect(daemon, credential.token, store)
  await client.connect()
  await client.subscribe('catalog')
  const projects = await Promise.all(repos.map((repo) => client.registerProject(repo, 'untrusted')))
  assert.equal((await client.listProjects()).length, 2)
  const jobs = await Promise.all([
    client.createWorkspace(projects[0].project_id),
    client.createWorkspace(projects[1].project_id),
    client.createWorkspace(projects[0].project_id),
  ])
  await Promise.all(jobs.map((j) => complete(client, j.job_id)))
  const workspaces = await Promise.all(jobs.map((j) => client.getWorkspace(j.workspace_id)))
  assert.equal(new Set(workspaces.map((w) => w.branch)).size, 3)
  const sessions = await Promise.all(
    workspaces.slice(0, 2).map((w, i) => client.createSession('Attached fake ' + i, w.workspace_id))
  )
  await Promise.all(sessions.map((s) => client.send(s.session_id, 'non-executing fixture', 0)))
  await assert.rejects(client.removeWorkspace(workspaces[0].workspace_id), /resource_busy/)
  writeFileSync(join(workspaces[0].path, '.fixture'), 'isolated change\n')
  writeFileSync(join(workspaces[0].path, 'untracked with spaces'), 'valuable')
  const status = await client.workspaceStatus(workspaces[0].workspace_id)
  const diff = await client.workspaceDiff(workspaces[0].workspace_id)
  assert.ok(status.entries.some((e) => e.path === '.fixture'))
  assert.ok(status.entries.some((e) => e.path === 'untracked with spaces'))
  assert.match(diff.diff, /\+isolated change/)
  const node_id = daemon.node_id
  await client.disconnect()
  await stop(daemon.child)
  daemon = await start()
  assert.equal(daemon.node_id, node_id)
  client = connect(daemon, credential.token, store)
  await client.connect()
  assert.deepEqual(
    await client.listProjects(),
    [...projects].sort((a, b) => a.project_id.localeCompare(b.project_id))
  )
  for (const workspace of workspaces)
    assert.deepEqual(await client.getWorkspace(workspace.workspace_id), workspace)
  for (const session of sessions)
    assert.ok(
      (await client.listSessions()).some(
        (s) => s.session_id === session.session_id && s.workspace_id === session.workspace_id
      )
    )
  assert.deepEqual(await client.workspaceStatus(workspaces[0].workspace_id), status)
  assert.deepEqual(await client.workspaceDiff(workspaces[0].workspace_id), diff)
  await assert.rejects(client.removeWorkspace(workspaces[0].workspace_id), /resource_busy/)
  const removal = await client.removeWorkspace(workspaces[2].workspace_id)
  await complete(client, removal.job_id)
  assert.equal(existsSync(workspaces[2].path), false)
  assert.match(
    git(repos[0], 'show-ref', '--verify', 'refs/heads/' + workspaces[2].branch),
    new RegExp(workspaces[2].base_commit)
  )
  assert.deepEqual(
    repos.map((repo) => ({
      branch: git(repo, 'branch', '--show-current'),
      head: git(repo, 'rev-parse', 'HEAD'),
      status: git(repo, 'status', '--porcelain'),
      contents: readFileSync(join(repo, '.fixture'), 'utf8'),
    })),
    original
  )
  await until(async () =>
    (await client.history('catalog')).some(
      (e) =>
        e.type === 'workspace.changed' &&
        e.data.workspace_id === workspaces[2].workspace_id &&
        e.data.state === 'removed'
    )
  )
  const report = {
    passed: true,
    node_id,
    projects: projects.length,
    provisioned_workspaces: workspaces.length,
    attached_fake_sessions: sessions.length,
    catalog_events: (await client.history('catalog')).length,
    status_and_diff_survived_restart: true,
    clean_workspace_removed: true,
    branch_retained: true,
    original_checkouts_untouched: true,
    evidence,
  }
  writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2) + '\n', {
    mode: 0o600,
  })
  console.log(JSON.stringify(report))
} finally {
  for (const client of clients) await client.disconnect()
  for (const child of processes) await stop(child)
}
