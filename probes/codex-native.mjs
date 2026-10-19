// Manual installed-binary checks using deterministic loopback Responses fixtures.
// No model inference, credentials or upstream model endpoint is used.
import { createServer } from 'node:http'
import { deflateSync } from 'node:zlib'
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  renameSync,
  realpathSync,
  copyFileSync,
  lstatSync,
} from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { discoverCodex, requireManagedFile } from '../packages/provider-codex/dist/discovery.js'
import { RpcPeer } from '../packages/provider-codex/dist/rpc.js'
import {
  launchOverrides,
  checkEffective,
  policyFingerprint,
} from '../packages/provider-codex/dist/policy.js'
import { CodexEventMapper } from '../packages/provider-codex/dist/mapper.js'
import { CodexApprovalBridge } from '../packages/provider-codex/dist/approval.js'
import { NodeCore } from '../packages/node-core/dist/index.js'
import { ProcessSupervisor, systemProcessProbe } from '../packages/provider-claude/dist/index.js'
import { assertReplayProgress, assertChainIntact } from './codex-probe-checks.mjs'

function png() {
  const crc = (bytes) => {
    let c = 0xffffffff
    for (const b of bytes) {
      c ^= b
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0)
    }
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const t = Buffer.from(type),
      n = Buffer.alloc(4),
      end = Buffer.alloc(4)
    n.writeUInt32BE(data.length)
    end.writeUInt32BE(crc(Buffer.concat([t, data])))
    return Buffer.concat([n, t, data, end])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.from([0, 255, 0, 0, 255]))),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const json = process.argv.includes('--json'),
  binary = process.argv.slice(2).find((a) => a !== '--json')
if (!binary) throw new Error('Explicit absolute Codex executable required')
const executable = discoverCodex({ executable: binary })
requireManagedFile()
mkdirSync('.scratch', { recursive: true, mode: 0o700 })
const root = mkdtempSync(resolve('.scratch/codex-native-')),
  state = join(root, 'state'),
  home = join(root, 'replay-home'),
  repo = join(root, 'repo')
mkdirSync(home, { mode: 0o700 })
mkdirSync(repo, { mode: 0o700 })
const env = {
  PATH: '/usr/bin:/bin',
  HOME: home,
  CODEX_HOME: home,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
}
for (const args of [
  ['init', '-b', 'main'],
  ['config', 'user.name', 'Fixture'],
  ['config', 'user.email', 'fixture@example.invalid'],
])
  execFileSync('/usr/bin/git', args, { cwd: repo, env, stdio: 'ignore' })
writeFileSync(join(repo, 'file'), 'synthetic original\n')
execFileSync('/usr/bin/git', ['add', '.'], { cwd: repo, env, stdio: 'ignore' })
execFileSync('/usr/bin/git', ['commit', '-m', 'fixture'], { cwd: repo, env, stdio: 'ignore' })
const queue = [],
  outputs = new Map(),
  measured = [],
  failures = []
let replayRequests = 0,
  engineTurns = 0
const server = createServer(async (req, res) => {
  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (body.length > 2 * 1024 * 1024) {
      res.writeHead(413)
      res.end()
      return
    }
  }
  if (req.method !== 'POST' || req.url !== '/v1/responses') {
    res.writeHead(403)
    res.end()
    return
  }
  const request = JSON.parse(body)
  if (req.headers.authorization) {
    res.writeHead(403)
    res.end()
    return
  }
  for (const item of request.input ?? [])
    if (item.type === 'function_call_output') outputs.set(item.call_id, item.output)
  const item = queue.shift()
  if (!item) {
    res.writeHead(409)
    res.end()
    return
  }
  const id = `replay-${++replayRequests}`
  res.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const ev of [
    { type: 'response.created', response: { id } },
    { type: 'response.output_item.done', item },
    {
      type: 'response.completed',
      response: { id, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } },
    },
  ])
    res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`)
  res.end()
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const final = (text = 'synthetic final') => ({
  type: 'message',
  role: 'assistant',
  id: `message-${randomUUID()}`,
  content: [{ type: 'output_text', text }],
})
const call = (id, name, args) => ({
  type: 'function_call',
  call_id: id,
  name,
  arguments: JSON.stringify(args),
})
const peers = new Set(),
  pids = []
let core, detachedEvidence
const adapter = {
  available: true,
  configuration: { model: 'gpt-5.4', permission_ttl_ms: 10000 },
  configurationForTurn: () => ({}),
  capabilities: () => ({ provider: 'codex', available: true }),
  reconcile: (p) => ProcessSupervisor.cleanup(p, 100),
  startTurn: async (turn, sink) => {
    // The same paths the provider adapter derives for a launch.
    const [commonDir, gitDir] = execFileSync(
      '/usr/bin/git',
      ['rev-parse', '--git-common-dir', '--absolute-git-dir'],
      { cwd: turn.cwd, env, encoding: 'utf8' }
    )
      .trim()
      .split('\n')
    const paths = {
      state,
      home,
      workspace: turn.cwd,
      sibling: dirname(turn.cwd),
      repository: realpathSync(resolve(turn.cwd, commonDir)),
      gitdir: realpathSync(gitDir),
    }
    const mapper = new CodexEventMapper(turn.run_id, (e) => sink.event(e))
    if (turn.native_session_id) mapper.bind(turn.native_session_id)
    let finishTerminal
    const terminal = new Promise((r) => (finishTerminal = r)),
      abort = new AbortController()
    let bridge
    const peer = await RpcPeer.start({
      executable,
      cwd: turn.cwd,
      home,
      configArgs: [
        ...launchOverrides(paths),
        '-c',
        'model_provider="abele_replay"',
        '-c',
        `model_providers.abele_replay={name="Local deterministic replay",base_url="http://127.0.0.1:${port}/v1",wire_api="responses",requires_openai_auth=false,supports_websockets=false,request_max_retries=0,stream_max_retries=0}`,
      ],
      processes: (p) => {
        sink.processes(p)
        pids.push(...p)
      },
      notification: (msg) => {
        try {
          mapper.notification(msg)
        } catch (error) {
          writeFileSync(
            join(root, 'mapper-error.json'),
            JSON.stringify({
              method: msg.method,
              reason: error.message,
              thread_matches: msg.params?.threadId === mapper.threadId,
              turn_matches: msg.params?.turnId === mapper.turnId,
              turn_bound: !!mapper.turnId,
            }),
            { mode: 0o600 }
          )
          throw error
        }
        if (mapper.result) finishTerminal()
      },
      serverRequest: (msg, signal) => {
        if (msg.method === 'item/tool/requestUserInput')
          writeFileSync(
            join(root, 'question-contract.json'),
            JSON.stringify(
              msg.params.questions?.map((q) => ({
                keys: Object.keys(q),
                isOther: q.isOther,
                isSecret: q.isSecret,
                options: q.options?.map((o) => ({
                  keys: Object.keys(o),
                  label: o.label,
                  description: o.description,
                })),
              })),
              null,
              2
            ),
            { mode: 0o600 }
          )
        return bridge.handle(msg, AbortSignal.any([signal, abort.signal]))
      },
    })
    peers.add(peer)
    const interrupt = async () => {
      abort.abort()
      if (mapper.turnId && !peer.signal.aborted)
        await Promise.race([
          peer
            .request('turn/interrupt', { threadId: mapper.threadId, turnId: mapper.turnId })
            .catch(() => {}),
          new Promise((r) => setTimeout(r, 200)),
        ])
      await peer.close()
    }
    bridge = new CodexApprovalBridge({
      generation: randomUUID(),
      workspace: turn.cwd,
      mapper,
      ask: (a, s) => (a.kind === 'permission' ? sink.permission(a, s) : sink.question(a, s)),
      cancel: interrupt,
    })
    const done = (async () => {
      let reason
      try {
        const init = await peer.request('initialize', {
          clientInfo: { name: 'abele-native-replay', version: '0.0.0' },
          capabilities: { experimentalApi: true },
        })
        if (init.codexHome !== home) throw new Error('wrong_home')
        await peer.initialized()
        const cfg = await peer.request('config/read', { cwd: turn.cwd, includeLayers: true }),
          req = await peer.request('configRequirements/read')
        // The only probe exception is the unauthenticated local response fixture.
        if (
          cfg.config.model_provider !== 'abele_replay' ||
          Object.keys(cfg.config.model_providers).join() !== 'abele_replay' ||
          cfg.config.model_providers.abele_replay.base_url !== `http://127.0.0.1:${port}/v1`
        )
          throw new Error('replay_endpoint_mismatch')
        checkEffective({ ...cfg.config, model_provider: 'openai', model_providers: {} }, req, paths)
        const params = {
          model: 'gpt-5.4',
          modelProvider: 'abele_replay',
          cwd: turn.cwd,
          runtimeWorkspaceRoots: [turn.cwd],
          permissions: 'abele',
          approvalPolicy: 'on-request',
          approvalsReviewer: 'user',
        }
        const native = await peer.request(
          turn.native_session_id ? 'thread/resume' : 'thread/start',
          turn.native_session_id
            ? { ...params, threadId: turn.native_session_id, excludeTurns: true }
            : { ...params, ephemeral: false }
        )
        if (
          native.modelProvider !== 'abele_replay' ||
          native.cwd !== turn.cwd ||
          native.activePermissionProfile?.id !== 'abele' ||
          (turn.native_session_id && native.thread.id !== turn.native_session_id)
        )
          throw new Error('native_binding_mismatch')
        mapper.bind(native.thread.id)
        sink.event({
          type: 'codex.session.bound',
          data: {
            native_session_id: native.thread.id,
            workspace_path: turn.cwd,
            policy_fingerprint: policyFingerprint(paths),
            model: 'gpt-5.4',
          },
        })
        if (abort.signal.aborted) throw new Error('interrupted')
        const accepted = await peer.request('turn/start', {
          threadId: native.thread.id,
          input: [{ type: 'text', text: turn.text, text_elements: [] }],
          permissions: 'abele',
          model: 'gpt-5.4',
          effort: 'low',
          collaborationMode: {
            mode: turn.text === 'Native question fixture' ? 'plan' : 'default',
            settings: { model: 'gpt-5.4', reasoning_effort: 'low', developer_instructions: null },
          },
        })
        engineTurns++
        mapper.accepted(accepted.turn.id)
        await Promise.race([
          terminal,
          peer.lost.then((r) => {
            throw new Error(r)
          }),
        ])
      } catch (e) {
        reason = abort.signal.aborted ? 'interrupted' : e.message
      } finally {
        abort.abort()
        await peer.close()
        peers.delete(peer)
      }
      return { ...(mapper.result ? { result: mapper.result } : {}), ...(reason ? { reason } : {}) }
    })()
    return { done, interrupt }
  },
}
const wait = async (condition, label, assertProgress = () => {}) => {
  const end = Date.now() + 15000
  while (!condition() && Date.now() < end) {
    assertProgress()
    await new Promise((r) => setTimeout(r, 10))
  }
  if (!condition()) throw new Error(`timeout:${label}`)
}
try {
  core = new NodeCore(state, { codex: adapter })
  const token = core.createToken('fixture'),
    actor = core.authority.authenticate(token.token)
  const request = (m, p) => core.request(actor, m, p, randomUUID())
  const project = await request('project.register', { path: repo, trust: 'trusted' }),
    job = await request('workspace.create', { project_id: project.project_id })
  await core.resources.jobs.drain()
  const workspace = core.resources.workspaces.get(job.workspace_id).path,
    session = request('session.create', {
      title: 'Native replay',
      provider: 'codex',
      workspace_id: job.workspace_id,
    })
  const send = async (text, target = session) => {
    const input = request('session.send', {
      session_id: target.session_id,
      text,
      observed_seq: core.head(target.session_id),
    })
    await core.execution.drain()
    return input.input_id
  }
  const stateOf = (id) => core.db.prepare('SELECT state FROM inputs WHERE input_id=?').get(id).state
  for (const choice of ['allow', 'deny']) {
    const marker = join(workspace, `${choice}.txt`)
    queue.push(
      call(`approval-${choice}`, 'exec_command', {
        cmd: `printf synthetic > ${JSON.stringify(marker)}`,
        workdir: workspace,
        sandbox_permissions: 'require_escalated',
        justification: 'Synthetic approval dispatch fixture.',
      }),
      final()
    )
    const input = await send(`Approval fixture ${choice}`)
    await wait(
      () => core.prompts(session.session_id).some((p) => p.state === 'pending'),
      'approval',
      () => {
        const run = core.db.prepare('SELECT run_id FROM inputs WHERE input_id=?').get(input)
        const events = core.db
          .prepare('SELECT body FROM events WHERE stream_id=? ORDER BY seq DESC LIMIT 16')
          .all(session.session_id)
        assertReplayProgress(
          run.run_id,
          events.map((event) => JSON.parse(event.body))
        )
      }
    )
    if (existsSync(marker)) throw new Error('effect_before_approval')
    const prompt = core.prompts(session.session_id).find((p) => p.state === 'pending')
    request('prompt.answer', {
      session_id: prompt.session_id,
      prompt_id: prompt.prompt_id,
      run_id: prompt.run_id,
      revision: 1,
      action_digest: prompt.action_digest,
      choice,
    })
    await wait(() => stateOf(input) === 'completed', 'approval terminal')
    if (existsSync(marker) !== (choice === 'allow') || !core.prompt(prompt.prompt_id).delivered)
      throw new Error('approval_effect_mismatch')
    measured.push(`native ${choice} through durable approval API`)
  }
  // One explicitly escalated command, answered allow through the durable API.
  const approvedEscalation = async (id, cmd, cwd = workspace, target = session) => {
    queue.push(
      call(id, 'exec_command', {
        cmd,
        workdir: cwd,
        sandbox_permissions: 'require_escalated',
        justification: 'Synthetic approved escalation fixture.',
      }),
      final()
    )
    const input = await send(`Approved escalation fixture ${id}`, target)
    await wait(
      () => core.prompts(target.session_id).some((p) => p.state === 'pending'),
      id,
      () => {
        const run = core.db.prepare('SELECT run_id FROM inputs WHERE input_id=?').get(input)
        const events = core.db
          .prepare('SELECT body FROM events WHERE stream_id=? ORDER BY seq DESC LIMIT 16')
          .all(target.session_id)
        assertReplayProgress(
          run.run_id,
          events.map((event) => JSON.parse(event.body))
        )
      }
    )
    const prompt = core.prompts(target.session_id).find((p) => p.state === 'pending')
    request('prompt.answer', {
      session_id: prompt.session_id,
      prompt_id: prompt.prompt_id,
      run_id: prompt.run_id,
      revision: 1,
      action_digest: prompt.action_digest,
      choice: 'allow',
    })
    await wait(() => stateOf(input) === 'completed', `${id} terminal`)
    return JSON.stringify(outputs.get(id) ?? '')
  }
  // An approved escalation must not reach past the workspace: not the node's state,
  // not neighbouring worktrees, and not any other writable-looking location.
  const neighbour = join(dirname(workspace), 'neighbour-fixture'),
    stateSecret = join(state, 'escalation-fixture-secret'),
    outside = join(root, 'escalation-outside')
  mkdirSync(neighbour, { mode: 0o700 })
  writeFileSync(join(neighbour, 'secret'), 'synthetic-neighbour-secret', { mode: 0o600 })
  writeFileSync(stateSecret, 'synthetic-state-secret', { mode: 0o600 })
  for (const [id, cmd, target] of [
    ['escalated-state-read', `cat ${JSON.stringify(stateSecret)}`],
    ['escalated-neighbour-read', `cat ${JSON.stringify(join(neighbour, 'secret'))}`],
    ['escalated-state-write', `printf bad > ${JSON.stringify(join(state, 'escalation-write'))}`],
    ['escalated-outside-write', `printf bad > ${JSON.stringify(outside)}`, outside],
  ]) {
    const output = await approvedEscalation(id, cmd)
    assertChainIntact(id, {
      chainIntact: true,
      escapedPaths: [target ?? join(state, 'escalation-write')].filter((p) => existsSync(p)),
      output,
    })
  }
  measured.push(
    'approved escalation writes only inside the workspace and keeps node state and neighbouring worktrees denied'
  )
  // The registered repository itself: its Git metadata and policy folder stay
  // protected when an approved command runs there.
  await request('project.repository_settings', {
    project_id: project.project_id,
    external_read: true,
  })
  const checkout = (
      await request('repository.v1.worktrees', { project_id: project.project_id })
    ).entries.find((e) => e.kind === 'root'),
    checkoutTarget = { kind: 'worktree', worktree_id: checkout.worktree_id }
  await request('project.execution', {
    project_id: project.project_id,
    target: checkoutTarget,
    enabled: true,
  })
  const repoSession = await request('session.create', {
      title: 'Native replay repository',
      provider: 'codex',
      target: checkoutTarget,
    }),
    gitConfig = readFileSync(join(repo, '.git/config'), 'utf8')
  for (const [id, cmd, target] of [
    ['escalated-git-config', 'printf bad >> .git/config'],
    [
      'escalated-git-hook',
      'printf bad > .git/hooks/escalation-hook',
      join(repo, '.git/hooks/escalation-hook'),
    ],
    [
      'escalated-codex-policy',
      'mkdir -p .codex && printf bad > .codex/escalation',
      join(repo, '.codex'),
    ],
  ]) {
    const output = await approvedEscalation(id, cmd, repo, repoSession)
    assertChainIntact(id, {
      chainIntact: readFileSync(join(repo, '.git/config'), 'utf8') === gitConfig,
      escapedPaths: target && existsSync(target) ? [target] : [],
      output,
    })
  }
  measured.push('approved escalation in a registered repository keeps .git and .codex read-only')
  // Git metadata in every layout the node can bind: neither an ordinary nor an
  // approved command may write the gitfile, the resolved gitdir or the common dir.
  const ordinaryCommand = async (id, cmd, cwd, target) => {
    queue.push(call(id, 'exec_command', { cmd, workdir: cwd }), final())
    const input = await send(`Ordinary fixture ${id}`, target)
    await wait(() => stateOf(input) === 'completed', `${id} terminal`)
    return JSON.stringify(outputs.get(id) ?? '')
  }
  const snapshot = (paths) =>
    paths.map((path) => (existsSync(path) ? readFileSync(path, 'utf8') : null)).join('\0')
  const gitLayout = async (label, target, cwd) => {
    const [commonDir, gitDir] = execFileSync(
      '/usr/bin/git',
      ['rev-parse', '--git-common-dir', '--absolute-git-dir'],
      { cwd, env, encoding: 'utf8' }
    )
      .trim()
      .split('\n')
    const common = realpathSync(resolve(cwd, commonDir)),
      gitdir = realpathSync(gitDir),
      watched = [
        join(cwd, '.git'),
        join(common, 'config'),
        join(gitdir, 'HEAD'),
        join(common, 'hooks/escalation-hook'),
        join(gitdir, 'config.worktree'),
      ],
      before = snapshot(watched)
    const commands = [
      ['gitfile', `printf 'gitdir: /tmp/elsewhere' > ${JSON.stringify(join(cwd, '.git'))}`],
      ['common-config', `printf bad >> ${JSON.stringify(join(common, 'config'))}`],
      ['gitdir-head', `printf bad >> ${JSON.stringify(join(gitdir, 'HEAD'))}`],
      ['common-hook', `printf bad > ${JSON.stringify(join(common, 'hooks/escalation-hook'))}`],
      ['gitdir-config', `printf bad > ${JSON.stringify(join(gitdir, 'config.worktree'))}`],
    ]
    for (const [name, cmd] of commands)
      for (const [mode, run] of [
        ['ordinary', ordinaryCommand],
        ['escalated', (id, c, w, t) => approvedEscalation(id, c, w, t)],
      ]) {
        const id = `git-${label.replace(/[^a-z]+/g, '-')}-${name}-${mode}`
        const output = await run(id, cmd, cwd, target)
        assertChainIntact(id, {
          chainIntact: snapshot(watched) === before,
          escapedPaths: [],
          output,
        })
      }
    measured.push(`ordinary and approved commands cannot write Git metadata of a ${label}`)
  }
  await gitLayout('node-created worktree', session, workspace)
  // The workspace as a worktree of a repository nested inside it: gitdir and common
  // dir both inside the workspace. (A --separate-git-dir checkout is not offered as
  // an execution target by the node, so it cannot reach Codex.)
  const layoutSession = async (folder) => {
    const registered = await request('project.register', { path: folder, trust: 'trusted' })
    await request('project.repository_settings', {
      project_id: registered.project_id,
      external_read: true,
    })
    const entry = (
        await request('repository.v1.worktrees', { project_id: registered.project_id })
      ).entries.find((e) => e.kind === 'root'),
      target = { kind: 'worktree', worktree_id: entry.worktree_id }
    await request('project.execution', {
      project_id: registered.project_id,
      target,
      enabled: true,
    })
    return request('session.create', { title: `Native ${folder}`, provider: 'codex', target })
  }
  const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, env, stdio: 'ignore' })
  const outer = join(root, 'outer-worktree'),
    inner = join(root, 'inner-repository')
  git(root, 'init', '-q', '-b', 'main', inner)
  writeFileSync(join(inner, 'file'), 'synthetic\n')
  git(inner, 'add', 'file')
  git(
    inner,
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-q',
    '-m',
    'fixture'
  )
  git(inner, 'worktree', 'add', '-q', '-b', 'outer', outer)
  renameSync(inner, join(outer, 'inner'))
  git(join(outer, 'inner'), 'worktree', 'repair', outer)
  await gitLayout('worktree of a repository nested inside it', await layoutSession(outer), outer)
  queue.push(
    call('question-native', 'request_user_input', {
      questions: [
        {
          id: 'choice',
          header: 'Fixture',
          question: 'Select the fixture answer',
          options: [
            { label: 'One', description: 'First option' },
            { label: 'Two', description: 'Second option' },
          ],
        },
      ],
    }),
    final()
  )
  const questionInput = await send('Native question fixture')
  await wait(
    () =>
      core
        .prompts(session.session_id)
        .some((p) => p.state === 'pending' && ['select', 'input'].includes(p.kind)),
    'question prompt'
  )
  const question = core.prompts(session.session_id).find((p) => p.state === 'pending')
  request('prompt.answer', {
    session_id: question.session_id,
    prompt_id: question.prompt_id,
    run_id: question.run_id,
    revision: 1,
    action_digest: question.action_digest,
    choice: 'allow',
    value: 'One',
  })
  await wait(() => stateOf(questionInput) === 'completed', 'question terminal')
  if (!String(outputs.get('question-native')).includes('One'))
    throw new Error('native_question_answer_missing')
  measured.push(
    'native question through durable answer API with free-text semantics and no default selection'
  )
  writeFileSync(join(workspace, 'allowed.png'), png(), { mode: 0o600 })
  const deniedImage = join(dirname(workspace), 'denied-fixture', 'secret.png')
  mkdirSync(dirname(deniedImage), { mode: 0o700 })
  writeFileSync(deniedImage, png(), { mode: 0o600 })
  queue.push(
    call('read-allowed', 'view_image', { path: join(workspace, 'allowed.png') }),
    call('read-denied', 'view_image', { path: deniedImage }),
    final()
  )
  const readInput = await send('Native reader fixture')
  await wait(() => stateOf(readInput) === 'completed', 'reader terminal')
  if (
    typeof outputs.get('read-allowed') === 'string' ||
    !JSON.stringify(outputs.get('read-allowed')).includes('input_image')
  )
    throw new Error('allowed_image_not_read')
  if (
    !/Operation not permitted|Permission denied/.test(String(outputs.get('read-denied'))) ||
    JSON.stringify(outputs.get('read-denied')).includes('data:')
  )
    throw new Error('denied_image_read')
  measured.push(
    'native built-in view_image allowed workspace image and denied synthetic credential image'
  )
  await core.execution.stop()
  await core.resources.stop()
  core.close()
  core = new NodeCore(state, { codex: adapter })
  await core.execution.reconcile()
  const before = core.session(session.session_id).native_session_id
  queue.push(final('native exact resume'))
  const resumed = await send('Explicit native resume fixture')
  await wait(() => stateOf(resumed) === 'completed', 'resume terminal')
  if (core.session(session.session_id).native_session_id !== before)
    throw new Error('resumed_wrong_thread')
  measured.push('native exact-thread resume after core restart without input replay')
  const grant = request('delegation.grant.create', {
    parent_id: 'fixture-controller',
    project_ids: [project.project_id],
    providers: ['codex'],
  })
  queue.push(final('native delegated result'))
  const child = await request('delegation.create', {
    grant_id: grant.grant_id,
    delegation_key: 'native-child',
    project_id: project.project_id,
    title: 'Native child',
    provider: 'codex',
    text: 'Synthetic delegated task',
  })
  await core.resources.jobs.drain()
  await core.execution.drain()
  await wait(
    () =>
      core.db.prepare('SELECT state FROM inputs WHERE session_id=?').get(child.session_id).state ===
      'completed',
    'delegation terminal'
  )
  core.tick()
  if (
    core.read(child.mailbox_stream_id, 0).find((e) => e.type === 'delegation.result')?.data.text !==
    'native delegated result'
  )
    throw new Error('delegation_report_missing')
  measured.push('native delegated isolated workspace and mailbox result')
  const waitingMarker = join(workspace, 'interrupt-started')
  queue.push(
    call('interrupt-native', 'exec_command', {
      cmd: `printf started > ${JSON.stringify(waitingMarker)}; sleep 20`,
      workdir: workspace,
      yield_time_ms: 10000,
    }),
    final()
  )
  const interruptedInput = await send('Native interruption fixture')
  await wait(() => existsSync(waitingMarker), 'running command')
  const active = core.db.prepare('SELECT run_id FROM inputs WHERE input_id=?').get(interruptedInput)
  request('session.interrupt', { session_id: session.session_id, run_id: active.run_id })
  await core.execution.drain()
  if (
    stateOf(interruptedInput) !== 'delivery_unknown' ||
    core.db.prepare("SELECT count(*) n FROM provider_runs WHERE state='active'").get().n !== 0
  )
    throw new Error('native_interrupt_cleanup_failed')
  queue.length = 0
  measured.push('native interrupt preserves unknown outcome and confirms supervised cleanup')
  // Detached-process probe is deliberately workspace-only and short lived.
  const clang = '/Library/Developer/CommandLineTools/usr/bin/clang',
    sdk = '/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk'
  const source = join(root, 'detach.c'),
    program = join(workspace, 'detach'),
    pidfile = join(workspace, 'detached.pid')
  writeFileSync(
    source,
    '#include <unistd.h>\n#include <stdio.h>\nint main(int c,char**v){if(c!=2)return 64;int p=fork();if(p<0)return 70;if(p>0)return 0;if(setsid()<0)return 71;FILE*f=fopen(v[1],"w");if(!f)return 72;fprintf(f,"%d\\n",getpid());fclose(f);close(0);close(1);close(2);sleep(20);return 0;}\n',
    { mode: 0o600 }
  )
  const temp = join(root, 'compiler-tmp')
  mkdirSync(temp, { mode: 0o700 })
  execFileSync(clang, ['-isysroot', sdk, source, '-o', program], {
    env: { ...env, TMPDIR: temp },
    stdio: 'ignore',
  })
  queue.push(
    call('detach', 'exec_command', {
      cmd: `./detach ${JSON.stringify(pidfile)}`,
      workdir: workspace,
      yield_time_ms: 1000,
    }),
    final()
  )
  const detached = await send('Native detached-process fixture')
  await wait(() => existsSync(pidfile), 'detached fixture pid')
  detachedEvidence = systemProcessProbe.identity(Number(readFileSync(pidfile, 'utf8')))
  await wait(() => stateOf(detached) === 'completed', 'detached terminal')
  if (detachedEvidence && systemProcessProbe.identity(detachedEvidence.pid)) {
    failures.push('codex_detached_descendant_cleanup_failed')
    await ProcessSupervisor.cleanup([detachedEvidence], 100)
  } else measured.push('native detached child cleanup confirmed')
  // Destructive, so last: the directories from the node state down to the workspace
  // must not be moved, removed or replaced by an approved command, and no moved or
  // linked path may reach denied content or write into the state.
  const projectDir = dirname(workspace),
    worktrees = dirname(projectDir),
    chain = [state, worktrees, projectDir, workspace]
  const intact = () =>
    chain.every((dir) => {
      const stat = existsSync(dir) && lstatSync(dir)
      return stat && stat.isDirectory() && !stat.isSymbolicLink()
    })
  const q = JSON.stringify
  for (const [id, cmd, escaped] of [
    [
      'chain-move-projectDir',
      `mv ${q(projectDir)} ${q(join(root, 'moved-projectDir'))} && cat ${q(join(root, 'moved-projectDir/neighbour-fixture/secret'))}; printf bad > ${q(join(root, 'moved-projectDir/via-move'))}`,
      [join(root, 'moved-projectDir')],
    ],
    [
      'chain-move-worktrees',
      `mv ${q(worktrees)} ${q(join(root, 'moved-worktrees'))}`,
      [join(root, 'moved-worktrees')],
    ],
    [
      'chain-move-state',
      `mv ${q(state)} ${q(join(root, 'moved-state'))} && cat ${q(join(root, 'moved-state/escalation-fixture-secret'))}`,
      [join(root, 'moved-state')],
    ],
    [
      'chain-workspace-to-sibling',
      `cd / && mv ${q(workspace)} ${q(join(projectDir, 'workspace-sibling'))}`,
      [join(projectDir, 'workspace-sibling')],
    ],
    [
      'chain-workspace-to-link',
      `cd / && mv ${q(workspace)} ${q(join(root, 'moved-workspace'))} && ln -s ${q(state)} ${q(workspace)} && printf bad > ${q(join(workspace, 'via-link'))}; cat ${q(join(workspace, 'escalation-fixture-secret'))}`,
      [join(root, 'moved-workspace'), join(state, 'via-link')],
    ],
    [
      'chain-project-to-link',
      `cd / && rm -rf ${q(projectDir)}; ln -s ${q(state)} ${q(projectDir)} && printf bad > ${q(join(projectDir, 'via-link'))}`,
      [join(state, 'via-link')],
    ],
  ]) {
    const output = await approvedEscalation(id, cmd)
    assertChainIntact(id, {
      chainIntact: intact(),
      escapedPaths: escaped.filter((p) => existsSync(p)),
      output,
    })
  }
  if (!existsSync(join(projectDir, 'neighbour-fixture/secret')))
    throw new Error('chain_probe_failed:chain-project-to-link:neighbour_removed')
  measured.push(
    'approved escalation cannot move, remove or replace the directories from node state to the workspace'
  )
} finally {
  if (detachedEvidence) await ProcessSupervisor.cleanup([detachedEvidence], 100)
  for (const peer of peers) await peer.close()
  if (core) {
    await core.execution.stop()
    await core.resources.stop()
    core.close()
  }
  server.closeAllConnections()
  await new Promise((r) => server.close(r))
}
const report = {
  version: executable.version,
  measured,
  failures,
  replay_requests: replayRequests,
  replay_engine_turns: engineTurns,
  real_inference_turns: 0,
}
writeFileSync(join(root, 'summary.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
console.log(
  json
    ? JSON.stringify(report, null, 2)
    : `Codex ${report.version}: ${measured.length} native replay checks verified.\n${measured.map((m) => '- ' + m).join('\n')}\nFailed gates: ${failures.join(', ') || 'none'}.\nReal inference turns: 0.`
)
process.exitCode = failures.length ? 2 : 0
