// Explicit, reproducible CLI acceptance. No providers, app, vaults, or phone are used.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  existsSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
} from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { NodeClient } from '@abele/node-client'

mkdirSync('.scratch', { recursive: true })
const state = mkdtempSync(resolve('.scratch/acceptance-'))
const cli = resolve('packages/node-daemon/dist/cli.js')
const processes = new Set()
const clients = new Set()
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(work) {
  for (let i = 0; i < 250; i++) {
    if (await work()) return
    await sleep(20)
  }
  throw new Error('acceptance deadline exceeded')
}
class FileStore {
  serial = Promise.resolve()
  constructor(path) {
    this.path = path
  }
  transaction(work) {
    const task = this.serial.then(async () => {
      const state = existsSync(this.path)
        ? JSON.parse(readFileSync(this.path, 'utf8'))
        : { cursors: {}, events: {}, outbox: [], results: {} }
      const result = await work(state)
      const temp = this.path + '.tmp',
        fd = openSync(temp, 'w', 0o600)
      try {
        writeFileSync(fd, JSON.stringify(state))
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      renameSync(temp, this.path)
      const directory = openSync(dirname(this.path), 'r')
      try {
        fsyncSync(directory)
      } finally {
        closeSync(directory)
      }
      return structuredClone(result)
    })
    this.serial = task.catch(() => {})
    return task
  }
}
function token(label) {
  const result = spawnSync(
    process.execPath,
    [cli, '--json', 'token', 'create', label, '--state-dir', state],
    { encoding: 'utf8' }
  )
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
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
  let output = '',
    errors = ''
  child.stdout.on('data', (data) => {
    output += data
  })
  child.stderr.on('data', (data) => {
    errors += data
  })
  await until(() => {
    if (child.exitCode !== null) throw new Error(errors)
    return output.includes('"listening"')
  })
  return {
    child,
    ...JSON.parse(
      output
        .trim()
        .split('\n')
        .find((line) => line.includes('"listening"'))
    ),
  }
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await new Promise((resolve) => child.once('exit', resolve))
  processes.delete(child)
}
function client(daemon, credential, store) {
  const client = new NodeClient(
    {
      url: `ws://127.0.0.1:${daemon.port}/channel`,
      token: credential.token,
      profile: 'local-token-v1',
      expected_node_id: daemon.node_id,
    },
    store
  )
  clients.add(client)
  return client
}
try {
  const one = token('acceptance-one'),
    two = token('acceptance-two')
  let daemon = await start()
  const storePath = join(state, 'client-one.json')
  let first = client(daemon, one, new FileStore(storePath))
  await first.connect()
  const session = await first.createSession('Manual stage 1 acceptance')
  await first.subscribe(session.session_id)
  await first.disconnect()
  const queued = await first.send(session.session_id, 'Offline permission then echo', 0, [
    { kind: 'permission', ttl_ms: 60000 },
    { kind: 'echo' },
  ])
  assert.equal((await first.pending()).length, 1)
  first = client(daemon, one, new FileStore(storePath))
  await first.connect()
  await until(async () =>
    (await first.prompts(session.session_id)).some((prompt) => prompt.state === 'pending')
  )
  const prompt = (await first.prompts(session.session_id)).find(
    (prompt) => prompt.state === 'pending'
  )
  await first.answerPrompt(prompt, 'allow')
  await until(async () =>
    (await first.history(session.session_id)).some((event) => event.type === 'run.completed')
  )
  assert.ok(await first.operationResult(queued.operation_id))
  const history = await first.history(session.session_id)
  await first.disconnect()
  await stop(daemon.child)
  daemon = await start()
  first = client(daemon, one, new FileStore(storePath))
  const second = client(daemon, two, new FileStore(join(state, 'client-two.json')))
  await Promise.all([first.connect(), second.connect()])
  await Promise.all([first.subscribe(session.session_id), second.subscribe(session.session_id)])
  await until(async () => (await second.history(session.session_id)).length === history.length)
  assert.deepEqual(await first.history(session.session_id), history)
  assert.deepEqual(await second.history(session.session_id), history)
  assert.equal(history.filter((event) => event.type === 'input.accepted').length, 1)
  const report = {
    passed: true,
    node_id: daemon.node_id,
    session_id: session.session_id,
    committed_events: history.length,
    outbox_reloaded_from_disk: true,
    clients_converged_after_restart: true,
  }
  writeFileSync(join(state, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ ...report, evidence: state }))
} finally {
  for (const client of clients) await client.disconnect()
  for (const child of processes) await stop(child)
}
