// Explicit paid-model acceptance. Settings isolated so inherited allow rules cannot fake node approval.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { NodeClient, MemoryClientStore } from '@abele/node-client'
import { identity } from '../packages/provider-claude/dist/supervisor.js'
if (!process.argv.includes('--live-final-acceptance'))
  throw new Error(
    'Live Claude costs owner limits. Only one final acceptance per branch; pass --live-final-acceptance explicitly. Never retry a failed live run.'
  )
const pathOption = process.argv.indexOf('--claude-path')
const configuredClaude = pathOption < 0 ? undefined : process.argv[pathOption + 1]
const interruptFixture = `import {spawn} from 'node:child_process'; import {writeFileSync} from 'node:fs'; const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)']); writeFileSync('interrupt.pid',String(child.pid)); console.log('CHILD_READY'); setTimeout(()=>child.kill(),30000);`
if (pathOption >= 0 && !configuredClaude)
  throw new Error('--claude-path requires an absolute executable')
mkdirSync('.scratch', { recursive: true })
const branch = spawnSync('/usr/bin/git', ['branch', '--show-current'], {
  encoding: 'utf8',
}).stdout.trim()
if (!branch) throw new Error('Live acceptance requires a named branch')
// Exclusive marker is deliberately retained on failure: prove the fix with the fake.
writeFileSync(
  resolve('.scratch/live-claude-' + Buffer.from(branch).toString('hex') + '.json'),
  JSON.stringify({ branch, started_at: new Date().toISOString() }),
  { flag: 'wx', mode: 0o600 }
)
const evidence = mkdtempSync('/tmp/abele-node-acceptance-stage3-'),
  state = join(evidence, 'state'),
  repo = join(evidence, 'repo')
const cli = resolve('packages/node-daemon/dist/cli.js'),
  children = new Set(),
  clients = new Set()
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
let permissionFailure
const watchPermissions = (client, sessions) =>
  permissions(client, sessions).catch((error) => {
    permissionFailure = error
    answering = false
  })
async function until(test, ms = 120000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (permissionFailure) throw permissionFailure
    const r = await test()
    if (r) return r
    await delay(30)
  }
  throw new Error('acceptance deadline: ' + evidence)
}
function command(cwd, exe, args) {
  const r = spawnSync(exe, args, { cwd, encoding: 'utf8', timeout: 15000 })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}
const git = (...args) => command(repo, '/usr/bin/git', args)
async function start() {
  const child = spawn(
    process.execPath,
    [
      cli,
      '--json',
      'start',
      '--state-dir',
      state,
      '--port',
      '0',
      '--claude-profile',
      'isolated',
      '--claude-budget',
      '0.12',
      '--claude-deadline-ms',
      '90000',
      '--permission-ttl-ms',
      '1800',
      ...(configuredClaude ? ['--claude-path', configuredClaude] : []),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  children.add(child)
  let output = '',
    error = ''
  child.stdout.on('data', (d) => (output += d))
  child.stderr.on('data', (d) => (error += d))
  const info = await until(() => {
    if (child.exitCode !== null) throw new Error(error)
    return (
      output.includes('"listening"') &&
      JSON.parse(
        output
          .trim()
          .split('\n')
          .find((l) => l.includes('"listening"'))
      )
    )
  }, 15000)
  return { child, ...info }
}
async function stop(child, signal = 'SIGTERM') {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((r) => child.once('exit', r))
  child.kill(signal)
  await exited
  children.delete(child)
}
function clientFor(daemon, token, store) {
  const c = new NodeClient(
    {
      url: `ws://127.0.0.1:${daemon.port}/channel`,
      profile: 'local-token-v1',
      token,
      expected_node_id: daemon.node_id,
    },
    store
  )
  clients.add(c)
  return c
}
let answering = true,
  denied = 0,
  allowed = 0,
  timeouts = 0
const handled = new Set()
async function permissions(client, sessions) {
  while (answering) {
    if (client.connected)
      for (const session of sessions) {
        const prompts = await client
          .prompts(session.session_id, undefined, 'pending')
          .catch(() => [])
        for (const p of prompts)
          if (p.state === 'pending' && !handled.has(p.prompt_id)) {
            handled.add(p.prompt_id)
            const command = p.input?.command
            if (p.tool_name === 'Bash' && command === 'printf timeout > timeout.txt') {
              timeouts++
              continue
            }
            const approvedCommands = new Set([
              'printf session-one > tracked.txt',
              'printf session-two > tracked.txt',
              'node interrupt-child.mjs',
            ])
            const safeInput =
              Object.keys(p.input ?? {}).every((k) =>
                [
                  'command',
                  'description',
                  'timeout',
                  'run_in_background',
                  'dangerouslyDisableSandbox',
                ].includes(k)
              ) &&
              p.input?.run_in_background !== true &&
              p.input?.dangerouslyDisableSandbox !== true
            const choice =
              p.tool_name === 'Bash' && safeInput && approvedCommands.has(command)
                ? 'allow'
                : 'deny'
            await client.answerPrompt(p, choice)
            if (choice === 'allow') allowed++
            else denied++
          }
      }
    await delay(30)
  }
}
async function send(client, session, text) {
  const receipt = await client.send(
    session.session_id,
    text,
    await client.cursor(session.session_id)
  )
  const result = await client.operationResult(receipt.operation_id)
  assert.ok(result?.result?.input_id, JSON.stringify(result))
  return result.result.input_id
}
async function completed(client, session, input_id, expected = 'completed') {
  return until(async () => {
    const history = await client.history(session.session_id)
    const terminal = history.find(
      (e) =>
        e.data.input_id === input_id &&
        ['input.completed', 'input.failed', 'input.delivery_unknown'].includes(e.type)
    )
    if (!terminal) return false
    assert.equal(terminal.data.state, expected, JSON.stringify(terminal))
    return terminal
  })
}
async function nativeResult(client, session, input_id) {
  const history = await client.history(session.session_id)
  const run = history.find((e) => e.type === 'run.started' && e.data.input_id === input_id)
  const event = history.find(
    (e) => e.type === 'claude.result' && e.data.run_id === run?.data.run_id
  )
  assert.ok(event, 'missing terminal evidence')
  let data = event.data
  if (data.artifact_id) {
    const chunks = []
    let offset = 0,
      total
    do {
      const part = await client.request('artifact.read', {
        session_id: session.session_id,
        artifact_id: data.artifact_id,
        offset,
        length: 131072,
      })
      const bytes = Buffer.from(part.base64, 'base64')
      assert.ok(bytes.length)
      chunks.push(bytes)
      offset += bytes.length
      total = part.total
    } while (offset < total)
    data = JSON.parse(Buffer.concat(chunks).toString())
  }
  return data.result
}
let permissionTask, failure
try {
  mkdirSync(repo)
  git('init', '-b', 'main')
  git('config', 'user.name', 'Acceptance')
  git('config', 'user.email', 'acceptance@example.invalid')
  writeFileSync(join(repo, 'tracked.txt'), 'original\n')
  writeFileSync(join(repo, 'interrupt-child.mjs'), interruptFixture)
  git('add', '.')
  git('commit', '-m', 'fixture')
  const credential = JSON.parse(
    command(process.cwd(), process.execPath, [
      cli,
      '--json',
      'token',
      'create',
      'stage3',
      '--state-dir',
      state,
    ])
  )
  let daemon = await start(),
    store = new MemoryClientStore(),
    client = clientFor(daemon, credential.token, store)
  await client.connect()
  const describe = await client.describe()
  assert.equal(describe.providers.find((p) => p.provider === 'claude').provider_version, '2.1.291')
  const project = await client.registerProject(repo, 'trusted')
  const jobs = await Promise.all([
    client.createWorkspace(project.project_id),
    client.createWorkspace(project.project_id),
  ])
  for (const j of jobs)
    await until(async () => {
      const job = await client.getJob(j.job_id)
      assert.notEqual(job.state, 'needs_attention', JSON.stringify(job))
      return job.state === 'succeeded'
    })
  const workspaces = await Promise.all(jobs.map((j) => client.getWorkspace(j.workspace_id)))
  const sessions = await Promise.all(
    workspaces.map((w, i) => client.createSession('Claude ' + i, w.workspace_id, 'claude'))
  )
  for (const s of sessions) await client.subscribe(s.session_id)
  permissionTask = watchPermissions(client, sessions)
  const one = await send(
    client,
    sessions[0],
    'In this disposable workspace ONLY, run exactly one Bash tool command: printf session-one > tracked.txt. Then respond ONE_DONE. If permission is denied do not retry or use alternatives. Do not inspect anything else.'
  )
  const two = await send(
    client,
    sessions[1],
    'In this disposable workspace ONLY, use Bash to run printf session-two > tracked.txt. Then in a SEPARATE Bash tool call run printf forbidden > forbidden.txt. If that second call is denied, do not retry or use alternatives; respond TWO_DONE. Do not inspect anything else.'
  )
  const follow = await send(
    client,
    sessions[0],
    'Queued followup: do not use tools. Reply QUEUED_OK and recall your previous ONE_DONE response.'
  )
  await Promise.all([
    completed(client, sessions[0], one),
    completed(client, sessions[1], two),
    completed(client, sessions[0], follow),
  ])
  assert.match((await nativeResult(client, sessions[0], follow)).result, /QUEUED_OK/)
  assert.equal(readFileSync(join(workspaces[0].path, 'tracked.txt'), 'utf8'), 'session-one')
  assert.equal(readFileSync(join(workspaces[1].path, 'tracked.txt'), 'utf8'), 'session-two')
  assert.equal(existsSync(join(workspaces[1].path, 'forbidden.txt')), false)
  assert.ok(allowed >= 2)
  assert.equal(denied, 1)
  const native = (await client.getSession(sessions[0].session_id)).native_session_id
  assert.ok(native)
  const history = await client.history(sessions[0].session_id)
  const firstEnd = history.find((e) => e.type === 'input.completed' && e.data.input_id === one)
  const nextStart = history.find((e) => e.type === 'run.started' && e.data.input_id === follow)
  assert.ok(nextStart.seq > firstEnd.seq)
  answering = false
  await permissionTask
  await client.disconnect()
  await stop(daemon.child)
  daemon = await start()
  client = clientFor(daemon, credential.token, store)
  await client.connect()
  answering = true
  permissionTask = watchPermissions(client, sessions)
  const resumed = await send(
    client,
    sessions[0],
    'After daemon restart: no tools. Recall the exact earlier queued marker and reply RESTART_OK with that marker.'
  )
  await completed(client, sessions[0], resumed)
  assert.match((await nativeResult(client, sessions[0], resumed)).result, /RESTART_OK/)
  assert.match((await nativeResult(client, sessions[0], resumed)).result, /QUEUED_OK/)
  assert.equal((await client.getSession(sessions[0].session_id)).native_session_id, native)
  const timeout = await send(
    client,
    sessions[0],
    'Use exactly one Bash call printf timeout > timeout.txt in this disposable workspace. If denied, do not retry or use alternatives; reply TIMEOUT_DENIED. No other tools.'
  )
  await completed(client, sessions[0], timeout)
  assert.equal(existsSync(join(workspaces[0].path, 'timeout.txt')), false)
  assert.ok(timeouts >= 1)
  const interrupted = await send(
    client,
    sessions[1],
    'Use exactly one FOREGROUND Bash call with command node interrupt-child.mjs in this disposable workspace. Set run_in_background to false and timeout to 40000. This fixture is already provided. Do not inspect files or run anything else. Wait for it to finish.'
  )
  await until(() => existsSync(join(workspaces[1].path, 'interrupt.pid')))
  const sleeper = Number(readFileSync(join(workspaces[1].path, 'interrupt.pid'), 'utf8'))
  assert.ok(identity(sleeper))
  await delay(650)
  const current = (await client.history(sessions[1].session_id)).find(
    (e) => e.type === 'run.started' && e.data.input_id === interrupted
  )
  assert.ok(current)
  await client.interrupt(sessions[1].session_id, current.data.run_id)
  // Abrupt loss immediately after the durable interrupt: worker must stop itself and descendants.
  answering = false
  await permissionTask
  await client.disconnect()
  await stop(daemon.child, 'SIGKILL')
  await until(() => !identity(sleeper), 15000)
  daemon = await start()
  client = clientFor(daemon, credential.token, store)
  await client.connect()
  await completed(client, sessions[1], interrupted, 'delivery_unknown')
  const afterInterrupt = await send(
    client,
    sessions[1],
    'Do not execute any tools or replay work. Reply RECOVERED and recall the exact previously interrupted Bash command.'
  )
  await completed(client, sessions[1], afterInterrupt)
  const recovered = await nativeResult(client, sessions[1], afterInterrupt)
  assert.match(recovered.result, /RECOVERED/)
  assert.match(recovered.result, /node interrupt-child\.mjs/)
  const recoveryHistory = await client.history(sessions[1].session_id)
  const recoveryStart = recoveryHistory.find(
    (e) => e.type === 'run.started' && e.data.input_id === afterInterrupt
  )
  assert.ok(
    !recoveryHistory.some((e) => e.seq > recoveryStart.seq && e.type === 'claude.tool.call'),
    'recovery must not replay shell work'
  )
  const all = (await Promise.all(sessions.map((s) => client.history(s.session_id)))).flat()
  assert.ok(!all.some((e) => e.type === 'run.completed' && e.data.run_id === current.data.run_id))
  const diffs = await Promise.all(workspaces.map((w) => client.workspaceDiff(w.workspace_id)))
  for (const d of diffs) assert.match(d.diff, /\+session-/)
  assert.equal(git('status', '--porcelain'), '')
  const resultEvents = all.filter((e) => e.type === 'claude.result')
  const sessionCosts = new Map()
  for (const event of resultEvents) {
    let data = event.data
    if (data.artifact_id) {
      const artifact = await client.request('artifact.read', {
        session_id: event.stream_id,
        artifact_id: data.artifact_id,
        offset: 0,
        length: 131072,
      })
      data = JSON.parse(Buffer.from(artifact.base64, 'base64').toString())
    }
    const result = data.result
    if (result?.session_id)
      sessionCosts.set(
        result.session_id,
        Math.max(sessionCosts.get(result.session_id) ?? 0, result.total_cost_usd ?? 0)
      )
  }
  const cost = [...sessionCosts.values()].reduce((sum, value) => sum + value, 0)
  const report = {
    passed: true,
    cli_version: '2.1.291',
    profile: 'isolated',
    sessions: 2,
    invocations: 7,
    approved: allowed,
    denied,
    expired: timeouts,
    explicit_native_resume: true,
    abrupt_restart_descendant_cleanup: true,
    interrupted_outcome: 'unknown',
    reported_cost_usd_native_session_maxima: cost,
    cost_note:
      'Claude resume reports cumulative native-session costs; maxima are summed, not individual turn totals',
    interrupted_cost_unknown: true,
    maximum_budget_usd_per_invocation: 0.12,
    diff: diffs.map((d) => d.diff),
    evidence,
  }
  writeFileSync(join(evidence, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(JSON.stringify(report, null, 2))
} catch (error) {
  failure = error
  throw error
} finally {
  answering = false
  if (permissionTask) await permissionTask.catch(() => {})
  for (const c of clients) await c.disconnect().catch(() => {})
  for (const child of children) await stop(child)
  if (failure && existsSync(join(state, 'node.sqlite'))) {
    const db = new DatabaseSync(join(state, 'node.sqlite'), { readOnly: true })
    try {
      const results = db
        .prepare("SELECT body FROM events WHERE json_extract(body,'$.type')='claude.result'")
        .all()
        .map((r) => JSON.parse(r.body).data.result)
        .filter(Boolean)
      const report = {
        passed: false,
        reason: String(failure),
        cli_version: '2.1.291',
        profile: 'isolated',
        approved: allowed,
        denied,
        expired: timeouts,
        terminal_results: results.map((r) => ({
          is_error: r.is_error,
          api_error_status: r.api_error_status,
          result: r.result,
          total_cost_usd: r.total_cost_usd,
        })),
        reported_cost_usd: [
          ...results
            .reduce(
              (costs, r) =>
                costs.set(
                  r.session_id,
                  Math.max(costs.get(r.session_id) ?? 0, r.total_cost_usd ?? 0)
                ),
              new Map()
            )
            .values(),
        ].reduce((sum, value) => sum + value, 0),
        real_permission_compatibility_verified: allowed >= 2 && denied >= 1 && timeouts >= 1,
        evidence,
      }
      writeFileSync(join(evidence, 'failure-report.json'), JSON.stringify(report, null, 2), {
        mode: 0o600,
      })
      console.error(JSON.stringify(report, null, 2))
    } finally {
      db.close()
    }
  }
}
