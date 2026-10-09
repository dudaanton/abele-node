// Real channel/CLI acceptance with the non-executing provider. Never launches model inference.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { NodeClient, MemoryClientStore } from '@abele/node-client'
mkdirSync('.scratch', { recursive: true })
const evidence = mkdtempSync(resolve('.scratch/acceptance-stage4a-')),
  state = join(evidence, 'state'),
  repo = join(evidence, 'repo')
const cli = resolve('packages/node-daemon/dist/cli.js')
function run(executable, args, cwd) {
  const r = spawnSync(executable, args, { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.trim()
}
function git(...args) {
  return run('/usr/bin/git', args, repo)
}
mkdirSync(repo)
git('init', '-b', 'main')
git('config', 'user.name', 'Fixture')
git('config', 'user.email', 'fixture@example.invalid')
writeFileSync(join(repo, 'sample.txt'), 'one\nold\n')
git('add', '.')
git('commit', '-m', 'fixture')
const credential = JSON.parse(
  run(process.execPath, [cli, '--json', 'token', 'create', 'fixture', '--state-dir', state])
)
let daemon, client
async function start() {
  daemon = spawn(
    process.execPath,
    [
      cli,
      '--json',
      'start',
      '--state-dir',
      state,
      '--port',
      '0',
      '--claude-path',
      resolve('tests/fixtures/claude.mjs'),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let text = '',
    error = ''
  daemon.stdout.on('data', (b) => (text += b))
  daemon.stderr.on('data', (b) => (error += b))
  for (let i = 0; !text.includes('"listening"'); i++) {
    if (i > 500 || daemon.exitCode !== null) throw new Error(error || 'startup deadline')
    await new Promise((r) => setTimeout(r, 20))
  }
  const info = JSON.parse(text.split('\n').find((l) => l.includes('"listening"')))
  client = new NodeClient(
    {
      url: `ws://127.0.0.1:${info.port}/channel`,
      profile: 'local-token-v1',
      token: credential.token,
    },
    new MemoryClientStore()
  )
  await client.connect()
}
async function stop() {
  await client?.disconnect()
  if (daemon && daemon.exitCode === null && daemon.signalCode === null) {
    const exit = once(daemon, 'exit')
    daemon.kill('SIGTERM')
    await exit
  }
}
try {
  await start()
  const p = await client.registerProject(repo, 'untrusted'),
    job = await client.createWorkspace(p.project_id)
  for (let i = 0; ; i++) {
    const j = await client.getJob(job.job_id)
    if (j.state === 'succeeded') break
    assert.ok(i < 500 && j.state !== 'needs_attention')
    await new Promise((r) => setTimeout(r, 20))
  }
  const w = await client.getWorkspace(job.workspace_id),
    session = await client.createSession('Review fixture', w.workspace_id)
  writeFileSync(join(w.path, 'sample.txt'), 'one\nnew\n')
  assert.ok((await client.listFiles(w.workspace_id)).entries.some((e) => e.name === 'sample.txt'))
  const file = await client.readFile(w.workspace_id, 'sample.txt')
  const snap = await client.captureDiff(w.workspace_id, 'head')
  writeFileSync(join(w.path, 'sample.txt'), 'later\n')
  const batch = {
    session_id: session.session_id,
    observed_seq: 0,
    anchors: [
      {
        node_id:
          client.target.expected_node_id ?? (await client.store.transaction((s) => s.node_id)),
        workspace_id: w.workspace_id,
        diff_id: snap.diff_id,
        path: 'sample.txt',
        side: 'new',
        start_line: 2,
        end_line: 2,
        context_hash: createHash('sha256').update('new').digest('hex'),
        comment: 'Explain this change',
      },
    ],
  }
  await client.disconnect()
  const submitted = await client.submitReview(batch)
  await client.connect()
  assert.deepEqual((await client.reviewResult(submitted.operation_id)).stale, [true])
  await stop()
  await start()
  assert.equal((await client.getDiff(w.workspace_id, snap.diff_id)).content_id, snap.content_id)
  assert.equal(
    Buffer.from(
      (await client.readContent(w.workspace_id, file.content_id)).base64,
      'base64'
    ).toString(),
    'one\nnew\n'
  )
  assert.ok(
    Buffer.from((await client.readDiff(w.workspace_id, snap.diff_id)).base64, 'base64')
      .toString()
      .includes('+new')
  )
  writeFileSync(
    join(evidence, 'report.json'),
    JSON.stringify(
      {
        passed: true,
        diff_id: snap.diff_id,
        review_operation: submitted.operation_id,
        live_turns: 0,
      },
      null,
      2
    )
  )
  console.log(JSON.stringify({ passed: true, evidence, live_turns: 0 }))
} finally {
  await stop()
}
