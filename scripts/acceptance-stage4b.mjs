// Offline acceptance through the production channel and CLI; no model inference.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { once } from 'node:events'
import { NodeClient, MemoryClientStore } from '@abele/node-client'
mkdirSync('.scratch', { recursive: true })
const evidence = mkdtempSync(resolve('.scratch/acceptance-stage4b-')),
  state = join(evidence, 'state'),
  repo = join(evidence, 'folder')
mkdirSync(repo)
writeFileSync(join(repo, 'sample.txt'), 'before')
const cli = resolve('packages/node-daemon/dist/cli.js')
const token = spawnSync(
  process.execPath,
  [cli, '--json', 'token', 'create', 'fixture', '--state-dir', state],
  { encoding: 'utf8' }
)
assert.equal(token.status, 0, token.stderr)
const credential = JSON.parse(token.stdout),
  store = new MemoryClientStore()
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
    store
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
  const project = await client.registerProject(repo, 'untrusted'),
    [workspace] = await client.listWorkspaces(project.project_id)
  const file = await client.readFile(workspace.workspace_id, 'sample.txt')
  const params = {
    workspace_id: workspace.workspace_id,
    path: file.path,
    expected_content_id: file.content_id,
    text: 'after',
  }
  // Drop the local receipt commit after the server has already committed the replacement.
  const original = store.transaction.bind(store)
  let dropped = false
  store.transaction = (work) =>
    original(async (s) => {
      const result = await work(s)
      if (!dropped && Object.values(s.results).some((r) => r.result?.state === 'saved')) {
        dropped = true
        throw new Error('lost receipt commit')
      }
      return result
    })
  const save = await client.writeFile(params)
  assert.ok(dropped)
  assert.equal(await client.fileMutationResult(save.operation_id), undefined)
  assert.equal(readFileSync(join(repo, 'sample.txt'), 'utf8'), 'after')
  writeFileSync(join(repo, 'sample.txt'), 'external')
  await stop()
  store.transaction = original
  await start()
  assert.equal((await client.fileMutationResult(save.operation_id)).state, 'saved')
  assert.equal(readFileSync(join(repo, 'sample.txt'), 'utf8'), 'external')
  const conflict = await client.writeFile(params)
  assert.equal((await client.fileMutationResult(conflict.operation_id)).state, 'conflict')
  assert.equal(readFileSync(join(repo, 'sample.txt'), 'utf8'), 'external')
  assert.equal(
    Buffer.from(
      (await client.readContent(workspace.workspace_id, file.content_id)).base64,
      'base64'
    ).toString(),
    'before'
  )
  assert.deepEqual(
    (await client.listFiles(workspace.workspace_id)).entries.map((e) => e.name),
    ['sample.txt']
  )
  const recovery_path = (await client.fileMutationResult(save.operation_id)).recovery_path
  assert.equal(
    Buffer.from(
      (await client.readRecovery(workspace.workspace_id, recovery_path)).base64,
      'base64'
    ).toString(),
    'before'
  )
  const current = await client.readFile(workspace.workspace_id, 'sample.txt')
  const restore = await client.restoreFile({
    workspace_id: workspace.workspace_id,
    path: 'sample.txt',
    expected_content_id: current.content_id,
    recovery_path,
  })
  assert.equal((await client.fileMutationResult(restore.operation_id)).state, 'saved')
  assert.equal(readFileSync(join(repo, 'sample.txt'), 'utf8'), 'before')
  const created = await client.writeFile({
    workspace_id: workspace.workspace_id,
    path: 'new.txt',
    expected_content_id: null,
    text: 'created',
  })
  assert.equal((await client.fileMutationResult(created.operation_id)).state, 'saved')
  writeFileSync(
    join(evidence, 'report.json'),
    JSON.stringify({ passed: true, operation_id: save.operation_id, live_turns: 0 }, null, 2)
  )
  console.log(JSON.stringify({ passed: true, evidence, live_turns: 0 }))
} finally {
  await stop()
}
