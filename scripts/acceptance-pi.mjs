// Fake by default. Explicit manual consent and a hard six-prompt budget for live runs.
import { spawn, spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  cpSync,
  chmodSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { NodeClient, MemoryClientStore } from '../packages/node-client/dist/index.js'
import { PiAcceptanceBudget } from './pi-acceptance-budget.mjs'
import { waitForPiPrompt } from './pi-prompt-wait.mjs'
import { systemProcessProbe } from '@abele/provider-claude'
import {
  processStepDeadlineMs,
  waitForProcessCondition,
  withProcessDeadline,
} from './process-test-budget.mjs'
const live = process.argv.includes('--live-final-acceptance')
const repeat = process.argv.includes('--live-repeat')
const fixtureError = process.argv.includes('--fixture-provider-error')
const fixtureRetries = process.argv.includes('--fixture-5xx-retries')
if (live && (fixtureError || fixtureRetries))
  throw Error('fixture flags are unavailable in live acceptance')
if (repeat && !live) throw Error('repeat acceptance requires explicit live consent')
const cli = resolve('packages/node-daemon/dist/cli.js'),
  evidenceRoot = resolve('.scratch')
mkdirSync(evidenceRoot, { recursive: true })
const branch = spawnSync('/usr/bin/git', ['branch', '--show-current'], {
  encoding: 'utf8',
}).stdout.trim()
const revision = spawnSync('/usr/bin/git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).stdout.trim()
if (live)
  writeFileSync(
    join(
      evidenceRoot,
      'pi-live-' + branch.replaceAll('/', '_') + (repeat ? '-repeat' : '') + '.json'
    ),
    JSON.stringify({ at: new Date().toISOString(), branch, revision, max_turns: 6 }),
    { flag: 'wx', mode: 0o600 }
  )
const root = mkdtempSync('/tmp/abele-node-pi-'),
  repo = join(root, 'repo'),
  state = join(root, 'state')
const reportFile = join(evidenceRoot, 'pi-' + (live ? 'live' : 'fake') + '-' + Date.now() + '.json')
const env = { ...process.env }
for (const [source, key] of [
  ['claude.mjs', 'ABELE_CLAUDE_PATH'],
  ['tailscale.mjs', 'ABELE_TAILSCALE_PATH'],
]) {
  const file = join(root, source)
  cpSync(resolve('tests/fixtures', source), file)
  chmodSync(file, 0o700)
  env[key] = file
}
if (live) delete env.ABELE_PI_HOST
else env.ABELE_PI_HOST = resolve('tests/fixtures/pi-host.mjs')
const command = (exe, args, cwd) => {
  const p = spawnSync(exe, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: processStepDeadlineMs,
    killSignal: 'SIGKILL',
    maxBuffer: 1024 * 1024,
  })
  if (p.status !== 0)
    throw Error(`acceptance command failed: ${args.join(' ')}: ${p.error?.message ?? p.stderr}`)
  return p.stdout.trim()
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const until = (fn, ms = live ? 100000 : processStepDeadlineMs) =>
  waitForProcessCondition(fn, 'acceptance phase', ms)
const budget = new PiAcceptanceBudget(),
  store = new MemoryClientStore()
let child,
  client,
  session,
  workspace,
  token,
  currentInput,
  providerTurns = 0,
  nodeId
let fixtureFailures = fixtureRetries ? 2 : 0
const report = {
  branch,
  revision,
  live,
  root,
  max_pi_turns: 6,
  claude_live_turns: 0,
  checks: [],
  retries: [],
}
const start = async () => {
  child = spawn(
    process.execPath,
    [
      cli,
      'start',
      '--state-dir',
      state,
      '--port',
      '0',
      '--pi-profile',
      'isolated',
      '--pi-max-tokens',
      '1024',
      '--pi-deadline-ms',
      '90000',
      '--permission-ttl-ms',
      '1500',
      ...(process.env.PI_ACCEPTANCE_PROVIDER
        ? ['--pi-provider', process.env.PI_ACCEPTANCE_PROVIDER]
        : []),
      ...(process.env.PI_ACCEPTANCE_MODEL ? ['--pi-model', process.env.PI_ACCEPTANCE_MODEL] : []),
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let output = ''
  child.stdout.on('data', (d) => (output += d))
  child.stderr.on('data', () => {})
  const ready = await until(() => {
    if (child.exitCode !== null) throw Error('daemon failed before ready')
    const line = output.split('\n').find((s) => s.includes('"listening"'))
    return line ? JSON.parse(line) : null
  }, processStepDeadlineMs)
  if (nodeId) assert.equal(ready.node_id, nodeId)
  nodeId = ready.node_id
  client = new NodeClient(
    {
      url: `ws://127.0.0.1:${ready.port}/channel`,
      profile: 'local-token-v1',
      token,
      expected_node_id: nodeId,
    },
    store
  )
  await client.connect()
  client.onEvent((e) => {
    if (e.type === 'pi.turn_start') providerTurns++
  })
  assert.equal(
    JSON.parse(command(process.execPath, [cli, 'status', '--state-dir', state])).pi.configuration
      .sdk_version,
    '0.87.0'
  )
  report.doctor = JSON.parse(command(process.execPath, [cli, 'doctor', '--state-dir', state]))
  assert.equal(report.doctor.pi.configuration.profile, 'isolated')
}
const stop = async () => {
  await client?.disconnect()
  client = undefined
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  const process = child,
    exited = new Promise((r) => process.once('exit', r))
  process.kill('SIGTERM')
  try {
    await withProcessDeadline(() => exited, 'daemon cleanup')
  } catch (error) {
    process.kill('SIGKILL')
    await withProcessDeadline(() => exited, 'daemon forced exit')
    throw error // Forced cleanup is never successful graceful shutdown.
  }
  assert.equal(process.exitCode, 0, 'daemon must confirm worker cleanup')
  child = undefined
}
async function terminalFailure(id) {
  const history = await client.history(session.session_id)
  const terminal = history.find(
    (e) => e.data.input_id === id && ['input.failed', 'input.delivery_unknown'].includes(e.type)
  )
  if (!terminal) return undefined
  const run = terminal.data.run_id,
    events = history.filter((e) => e.data.run_id === run)
  return {
    state: terminal.type.slice('input.'.length),
    http_status: events.filter((e) => e.type === 'pi.message.final').at(-1)?.data.http_status,
    granted: events.some((e) => e.type === 'prompt.delivered' && e.data.choice === 'allow'),
    tool_succeeded: events.some((e) => e.type === 'pi.tool.result' && e.data.is_error === false),
  }
}
async function failIfTerminal(id, message) {
  const failure = await terminalFailure(id)
  if (failure) {
    const error = Error(message)
    error.failure = failure
    throw error
  }
}
const pending = () =>
  waitForPiPrompt(
    {
      prompt: async () => (await client.prompts(session.session_id, undefined, 'pending'))[0],
      failIfTerminal: () => failIfTerminal(currentInput, 'provider_failed_before_prompt'),
      completed: async () =>
        (await client.history(session.session_id)).some(
          (e) => e.data.input_id === currentInput && e.type === 'input.completed'
        ),
    },
    live ? 100000 : processStepDeadlineMs
  )
const finished = (id, state = 'completed') =>
  until(async () => {
    const terminal = (await client.history(session.session_id)).find(
      (e) => e.type === 'input.' + state && e.data.input_id === id
    )
    if (terminal) return terminal
    await failIfTerminal(id, 'provider_failed')
  })
async function turn(text, work) {
  for (;;) {
    budget.beginTurn()
    const actualText = fixtureError
      ? 'providererror'
      : fixtureFailures-- > 0
        ? 'providererror'
        : text
    const op = await client.send(
      session.session_id,
      actualText,
      await client.cursor(session.session_id)
    )
    currentInput = (await client.operationResult(op.operation_id)).result.input_id
    try {
      return await work(currentInput)
    } catch (error) {
      report.last_failure = error.failure
      if (!(live || fixtureRetries) || !error.failure || !budget.retry(error.failure)) throw error
      report.retries.push({ attempt: budget.turns, http_status: error.failure.http_status })
      // Only classified 5xx failures before a grant/effect are eligible. SDK
      // automatic retries are disabled; no uncertain shell work is replayed.
      if (live) await delay(30000)
    }
  }
}
try {
  mkdirSync(repo)
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.name', 'Fixture'],
    ['config', 'user.email', 'fixture@example.invalid'],
  ])
    command('/usr/bin/git', args, repo)
  writeFileSync(join(repo, 'tracked.txt'), 'original\n')
  command('/usr/bin/git', ['add', '.'], repo)
  command('/usr/bin/git', ['commit', '-m', 'disposable fixture'], repo)
  token = JSON.parse(
    command(process.execPath, [cli, 'token', 'create', 'acceptance', '--state-dir', state])
  ).token
  await start()
  const project = await client.registerProject(repo, 'trusted'),
    reservation = await client.createWorkspace(project.project_id)
  await until(
    async () => (await client.getJob(reservation.job_id)).state === 'succeeded',
    processStepDeadlineMs
  )
  workspace = await client.getWorkspace(reservation.workspace_id)
  session = await client.createSession('Pi acceptance', workspace.workspace_id, 'pi')
  await client.subscribe(session.session_id)
  const alongside = await client.createWorkspace(project.project_id)
  await until(
    async () => (await client.getJob(alongside.job_id)).state === 'succeeded',
    processStepDeadlineMs
  )
  const claude = await client.createSession('Fixture provider', alongside.workspace_id, 'claude')
  await client.subscribe(claude.session_id)
  await client.send(claude.session_id, 'echo', await client.cursor(claude.session_id))
  const marker = 'PI_OK_' + randomUUID().replaceAll('-', '')
  // Combining two individually gated actions keeps all five checks within six
  // attempted prompts even if two requests receive a retryable 5xx response.
  await turn(
    live
      ? `Use write to create proof.txt with content ${marker}, then use write to create denied.txt with content forbidden. Request each action exactly once. Do not use other tools. If the second action is denied, stop.`
      : 'allow-deny',
    async (id) => {
      const allow = await pending()
      assert.equal(allow.tool_name, 'write')
      if (live) {
        assert.equal(resolve(workspace.path, allow.input.path), join(workspace.path, 'proof.txt'))
        assert.equal(allow.input.content.trim(), marker)
      }
      await client.answerPrompt(allow, 'allow')
      const deny = await pending()
      assert.equal(deny.tool_name, 'write')
      if (live)
        assert.equal(resolve(workspace.path, deny.input.path), join(workspace.path, 'denied.txt'))
      await client.answerPrompt(deny, 'deny')
      await finished(id)
      assert.equal(
        readFileSync(join(workspace.path, live ? 'proof.txt' : 'pi-allowed.txt'), 'utf8').trim(),
        live ? marker : 'approved'
      )
      assert.equal(existsSync(join(workspace.path, live ? 'denied.txt' : 'pi-denied.txt')), false)
    }
  )
  await until(
    async () => (await client.history(claude.session_id)).some((e) => e.type === 'run.completed'),
    processStepDeadlineMs
  )
  report.checks.push('allow and disposable edit; fixture CLI concurrently', 'deny never executed')
  await turn(
    live
      ? 'Use write exactly once to create expired.txt containing forbidden. Do not use any other tool. If denied, stop.'
      : 'expiry',
    async (id) => {
      const expiry = await pending()
      await finished(id)
      assert.equal(
        (await client.prompts(session.session_id)).find((p) => p.prompt_id === expiry.prompt_id)
          .state,
        'expired'
      )
      assert.equal(existsSync(join(workspace.path, live ? 'expired.txt' : 'pi-expired.txt')), false)
    }
  )
  report.checks.push('expiry never executed')
  const interruptCommand = 'sleep 30 & echo $! > acceptance-child.pid; wait'
  let interruptedChild
  await turn(
    live
      ? `Use bash exactly once to run this exact command: ${interruptCommand}. Do not use any other tool.`
      : 'descendants',
    async (id) => {
      const wait = await pending()
      if (live) {
        assert.equal(wait.tool_name, 'bash')
        assert.equal(wait.input.command.trim(), interruptCommand)
      }
      await client.answerPrompt(wait, 'allow')
      await until(async () =>
        (await client.history(session.session_id)).some(
          (e) => e.type === 'prompt.delivered' && e.data.prompt_id === wait.prompt_id
        )
      )
      const pidFile = join(workspace.path, live ? 'acceptance-child.pid' : 'pi-child.pid')
      await until(() => existsSync(pidFile))
      interruptedChild = systemProcessProbe.identity(Number(readFileSync(pidFile, 'utf8')))
      assert.ok(interruptedChild, 'interrupt must exercise a live descendant, not just a grant')
      await client.interrupt(session.session_id, wait.run_id)
      await finished(id, 'delivery_unknown')
    }
  )
  report.checks.push('interrupt remains unknown; shutdown confirms process cleanup')
  const native = await client.getSession(session.session_id)
  report.session = {
    session_id: native.session_id,
    native_session_id: native.native_session_id,
    native_session_file: native.native_session_file,
    workspace_id: workspace.workspace_id,
  }
  await stop()
  await until(() => !systemProcessProbe.identity(interruptedChild.pid))
  report.interrupted_child_reaped = true
  await start()
  assert.equal(
    (await client.getSession(session.session_id)).native_session_file,
    native.native_session_file
  )
  await turn(
    live
      ? 'Without using tools, repeat exactly the text you wrote to proof.txt earlier.'
      : 'resume',
    async (id) => {
      await finished(id)
      if (live) {
        const finals = (await client.history(session.session_id)).filter(
          (e) => e.type === 'pi.message.final' && e.data.message?.role === 'assistant'
        )
        assert.ok(
          finals
            .at(-1)
            .data.message.content.some((b) => b.type === 'text' && b.text.includes(marker))
        )
      } else
        assert.equal(
          readFileSync(join(workspace.path, 'pi-resumed.txt'), 'utf8'),
          native.native_session_id
        )
    }
  )
  report.checks.push('exact native file reopen with resumed context')
  await stop()
  report.outcome = 'passed'
} catch (error) {
  report.outcome = 'failed'
  report.error = error instanceof Error ? error.message : 'acceptance_failed'
  process.exitCode = 1
} finally {
  try {
    await stop()
  } catch {
    report.cleanup = 'unconfirmed'
    process.exitCode = 1
  }
  report.live_pi_user_turns = live ? budget.turns : 0
  report.user_prompt_attempts = budget.turns
  report.inference_retries = budget.retries
  report.observed_pi_provider_turn_starts = providerTurns
  writeFileSync(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(
    JSON.stringify({
      report: reportFile,
      outcome: report.outcome,
      live_pi_user_turns: report.live_pi_user_turns,
      observed_pi_provider_turn_starts: providerTurns,
      claude_live_turns: 0,
    })
  )
}
