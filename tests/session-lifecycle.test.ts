import { afterEach, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { NodeCore } from '@abele/node-core'
import { NodeClient, MemoryClientStore } from '../packages/node-client/src/index.js'
import { RecordQueue, LocalChannelConnector } from '@abele/channel-client'
import { serveChannel } from '../packages/channel-server/src/index.js'
import { FrameCodec, LIMITS, type RecordTransport } from '@abele/channel-protocol'
import { SessionSchema } from '@abele/node-protocol'

const cores: NodeCore[] = [],
  dirs: string[] = [],
  cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const work of cleanup.splice(0).reverse()) await work()
  for (const core of cores.splice(0)) core.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function setup() {
  mkdirSync('.scratch', { recursive: true })
  const dir = mkdtempSync(resolve('.scratch/session-lifecycle-'))
  dirs.push(dir)
  const core = new NodeCore(dir)
  cores.push(core)
  const token = core.createToken('fixture')
  const actor = core.authority.authenticate(token.token)
  const session = SessionSchema.parse(
    core.request(actor, 'session.create', { title: 'Chat' }, 'create')
  )
  return { core, actor, token, session, dir }
}

it('describes the release independently of provider and wire versions, with explicit support', () => {
  const { core, actor } = setup()
  const description = core.request(actor, 'node.describe', {}) as any
  const release = JSON.parse(readFileSync('package.json', 'utf8')).version
  expect(description.node_version).toBe(release)
  expect(description.supported_capabilities).toEqual(
    expect.arrayContaining(['expected_target', 'session.rename', 'session.delete'])
  )
  expect(new Set(description.supported_capabilities).size).toBe(
    description.supported_capabilities.length
  )
  expect(description.capabilities.capabilities.expected_target.status).toBe('supported')
})

it('renames only the display title, journals both streams and replays receipts even after deletion/restart', () => {
  const { core, actor, session, dir } = setup()
  const native = { ...session, native_session_id: '11111111-1111-4111-8111-111111111111' }
  core.db
    .prepare('UPDATE sessions SET body=? WHERE session_id=?')
    .run(JSON.stringify(native), session.session_id)
  const params = { session_id: session.session_id, title: 'Renamed' }
  const renamed = core.request(actor, 'session.rename', params, 'rename')
  expect(renamed).toEqual({ ...native, title: 'Renamed' })
  expect(core.request(actor, 'session.rename', params, 'rename')).toEqual(renamed)
  expect(() =>
    core.request(actor, 'session.rename', { ...params, title: 'Other' }, 'rename')
  ).toThrow('idempotency_mismatch')
  for (const stream of [session.session_id, 'catalog']) {
    const events = core.read(stream, 0).filter((e) => e.type === 'session.updated')
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      actor: { kind: 'installation', installation_id: actor.installation_id },
      data: renamed,
    })
  }
  const deleted = core.request(
    actor,
    'session.delete',
    { session_id: session.session_id },
    'delete'
  )
  expect(deleted).toEqual({ session_id: session.session_id, deleted: true })
  core.close()
  const reopened = new NodeCore(dir)
  cores.push(reopened)
  expect(reopened.request(actor, 'session.rename', params, 'rename')).toEqual(renamed)
  expect(
    reopened.request(actor, 'session.delete', { session_id: session.session_id }, 'delete')
  ).toEqual(deleted)
  expect(reopened.request(actor, 'session.list', {})).toEqual([])
  expect(() => reopened.request(actor, 'session.get', { session_id: session.session_id })).toThrow(
    'not_found'
  )
  for (const stream of [session.session_id, 'catalog']) {
    expect(reopened.read(stream, 0).filter((e) => e.type === 'session.deleted')).toHaveLength(1)
  }
  expect(() =>
    reopened.request(
      actor,
      'session.send',
      { session_id: session.session_id, text: 'no', observed_seq: 0 },
      'late'
    )
  ).toThrow('not_found')
})

it('refuses deletion of queued/running turns, permits rename during a turn, then deletes after completion', () => {
  const { core, actor, session } = setup()
  const p = { session_id: session.session_id }
  core.request(
    actor,
    'session.send',
    { ...p, text: 'wait', observed_seq: 0, script: [{ kind: 'hang' }] },
    'send'
  )
  expect(() => core.request(actor, 'session.delete', p, 'delete')).toThrow('resource_busy')
  core.tick()
  expect(() => core.request(actor, 'session.delete', p, 'delete')).toThrow('resource_busy')
  expect(core.request(actor, 'session.rename', { ...p, title: 'Running' }, 'rename')).toMatchObject(
    { title: 'Running' }
  )
  const run = core.db
    .prepare('SELECT run_id FROM inputs WHERE session_id=?')
    .get(session.session_id)!
  core.request(actor, 'session.interrupt', { ...p, run_id: run.run_id }, 'interrupt')
  expect(core.request(actor, 'session.delete', p, 'delete')).toEqual({ ...p, deleted: true })
  expect(
    core.db.prepare('SELECT 1 FROM workspace_leases WHERE session_id=?').get(session.session_id)
  ).toBeUndefined()
})

it('refuses deletion until provider cleanup is settled, even with a terminal input', () => {
  const { core, actor, session } = setup()
  const p = { session_id: session.session_id }
  core.db
    .prepare("INSERT INTO provider_runs(run_id,session_id,state) VALUES(?,?,'active')")
    .run('cleanup', session.session_id)
  expect(() => core.request(actor, 'session.delete', p, 'delete')).toThrow('resource_busy')
  core.db.prepare("UPDATE provider_runs SET state='settled' WHERE run_id='cleanup'").run()
  expect(core.request(actor, 'session.delete', p, 'delete')).toEqual({ ...p, deleted: true })
  expect(
    core.db.prepare("SELECT state FROM provider_runs WHERE run_id='cleanup'").get()
  ).toMatchObject({ state: 'settled' })
})

it('requires operation IDs, validates title bounds, and rolls rename/delete back atomically', () => {
  for (const method of ['session.rename', 'session.delete']) {
    const { core, actor, session } = setup()
    const p = {
      session_id: session.session_id,
      ...(method === 'session.rename' ? { title: 'New' } : {}),
    }
    expect(() => core.request(actor, method, p)).toThrow('operation_id_required')
    if (method === 'session.rename') {
      expect(() =>
        core.request(actor, method, { ...p, title: 'x'.repeat(257) }, 'invalid')
      ).toThrow('invalid_params')
    }
    core.fault = (point) => {
      if (point === 'before_commit') throw new Error('SQLITE_FULL')
    }
    expect(() => core.request(actor, method, p, 'fault')).toThrow('SQLITE_FULL')
    expect(core.session(session.session_id)).toEqual(session)
    expect(core.read('catalog', 0)).toHaveLength(1)
    expect(
      core.db.prepare('SELECT 1 FROM operations WHERE operation_id=?').get('fault')
    ).toBeUndefined()
  }
})

it('advertises the same metadata in the handshake; clients can ignore it and still chat', async () => {
  const { core, token, session } = setup()
  const incoming = new RecordQueue(),
    outgoing = new RecordQueue()
  const close = async () => {
    incoming.end()
    outgoing.end()
  }
  const server: RecordTransport = {
    receive: () => incoming,
    send: async (b) => outgoing.push(b),
    close,
  }
  const task = serveChannel(server, core)
  cleanup.push(async () => {
    await close()
    await task
  })
  const connector = new LocalChannelConnector(async () => ({
    receive: () => outgoing,
    send: async (b) => incoming.push(b),
    close,
  }))
  const target = {
    profile: 'local-token-v1' as const,
    url: 'ws://127.0.0.1:7777/channel',
    token: token.token,
  }
  const channel = await connector.connect(target)
  const welcome = channel.welcome as any
  const description = core.request(
    core.authority.authenticate(token.token),
    'node.describe',
    {}
  ) as any
  expect(welcome.capabilities.node_version).toBe(description.node_version)
  expect(welcome.capabilities.supported_capabilities).toEqual(description.supported_capabilities)
  expect(welcome).not.toHaveProperty('node_version')
  // The handshake bounds the welcome; provider configuration is read from node.describe.
  expect(FrameCodec.encode(welcome).length).toBeLessThanOrEqual(LIMITS.auth_bytes)
  expect(welcome.capabilities.providers.map((p: any) => p.provider)).toEqual(
    description.providers.map((p: any) => p.provider)
  )
  expect(welcome.capabilities.providers.every((p: any) => !('configuration' in p))).toBe(true)
  expect(welcome).not.toHaveProperty('supported_capabilities')
  expect(welcome.methods).toEqual(expect.arrayContaining(['session.rename', 'session.delete']))
  // A client using only existing fields continues without consulting feature discovery.
  const client = new NodeClient(target, new MemoryClientStore(), { connect: async () => channel })
  cleanup.push(() => client.disconnect())
  await client.connect()
  expect(await client.listSessions()).toEqual([session])
  const op = await client.send(session.session_id, 'legacy send', 0)
  await client.flush()
  expect(await client.operationResult(op.operation_id)).toMatchObject({
    result: { input_id: expect.any(String) },
  })
  core.tick()
  expect(
    await client.renameSession(session.session_id, 'Client title', 'client-rename')
  ).toMatchObject({ title: 'Client title' })
  expect(await client.deleteSession(session.session_id, 'client-delete')).toEqual({
    session_id: session.session_id,
    deleted: true,
  })
  expect(await client.deleteSession(session.session_id, 'client-delete')).toEqual({
    session_id: session.session_id,
    deleted: true,
  })
  expect(await client.listSessions()).toEqual([])
  const {
    node_version: _version,
    supported_capabilities: _capabilities,
    ...oldCapabilities
  } = welcome.capabilities
  const oldWelcome = { ...welcome, capabilities: oldCapabilities }
  expect(FrameCodec.decode(FrameCodec.encode(oldWelcome))).toEqual(oldWelcome)
})
