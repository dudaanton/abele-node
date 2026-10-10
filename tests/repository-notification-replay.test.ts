import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { NodeCore } from '@abele/node-core'
import { NodeClient, MemoryClientStore } from '../packages/node-client/src/index.js'
import { LocalChannelConnector, RecordQueue } from '../packages/channel-client/src/index.js'
import { serveChannel } from '../packages/channel-server/src/index.js'
import { FrameCodec, type RecordFrame } from '../packages/channel-protocol/src/index.js'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(check: () => Promise<boolean>) {
  const deadline = Date.now() + 3000
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('notification replay deadline')
    await sleep(10)
  }
}
it.each(['opt-out', 'removed'])(
  'advances reconnect replay past a fenced external invalidation after %s without leaking its content',
  async (mode) => {
    mkdirSync('.scratch', { recursive: true })
    const dir = mkdtempSync(resolve('.scratch/notification-replay-'))
    const repo = join(dir, 'repo'),
      linked = join(dir, 'linked')
    mkdirSync(repo)
    const git = (...args: string[]) => {
      const result = spawnSync('/usr/bin/git', args, { cwd: repo, encoding: 'utf8' })
      expect(result.status, result.stderr).toBe(0)
    }
    git('init', '-b', 'trunk')
    git('config', 'user.name', 'Fixture')
    git('config', 'user.email', 'fixture@example.invalid')
    writeFileSync(join(repo, 'file'), 'fixture\n')
    git('add', '.')
    git('commit', '-m', 'fixture')
    git('worktree', 'add', '-b', 'side', linked)
    const core = new NodeCore(join(dir, 'state'))
    const credential = core.createToken('fixture'),
      actor = core.authority.authenticate(credential.token)
    let operation = 0
    const request = async (method: string, params: unknown) =>
      (await core.request(actor, method, params, `fixture-${++operation}`)) as any
    const servers: Promise<void>[] = []
    const wire: RecordFrame[] = [],
      subscriptions: RecordFrame[] = []
    const connector = new LocalChannelConnector(async () => {
      const incoming = new RecordQueue(),
        outgoing = new RecordQueue()
      const close = async () => {
        incoming.end()
        outgoing.end()
      }
      servers.push(
        serveChannel(
          {
            receive: () => incoming,
            send: async (bytes) => {
              wire.push(FrameCodec.decode(bytes))
              outgoing.push(bytes)
            },
            close,
          },
          core
        )
      )
      return {
        receive: () => outgoing,
        send: async (bytes) => {
          const frame = FrameCodec.decode(bytes)
          if (frame.kind === 'request' && frame.method === 'stream.subscribe')
            subscriptions.push(frame)
          incoming.push(bytes)
        },
        close,
      }
    })
    const store = new MemoryClientStore()
    const client = new NodeClient(
      { url: 'ws://127.0.0.1:7777/channel', profile: 'local-token-v1', token: credential.token },
      store,
      connector
    )
    try {
      const project = await request('project.register', { path: repo, trust: 'untrusted' })
      await request('project.repository_settings', {
        project_id: project.project_id,
        external_read: true,
      })
      const target = (
        await request('repository.v1.worktrees', { project_id: project.project_id })
      ).entries.find((e: any) => e.kind === 'external')
      const baseline = core.head('catalog')
      await client.connect()
      await client.subscribe('catalog')
      await until(async () => (await client.cursor('catalog')) === baseline)
      await client.disconnect()
      const hidden = core.append(
        'catalog',
        'repository.invalidated',
        { kind: 'installation', installation_id: actor.installation_id },
        {
          project_id: project.project_id,
          worktree_id: target.worktree_id,
          reason: 'overflow',
          generation: 'private-invalidation-generation',
        }
      )
      expect(hidden.seq).toBe(baseline + 1)
      expect(core.canPublishEvent(actor, hidden)).toBe(true)
      if (mode === 'opt-out')
        await request('project.repository_settings', {
          project_id: project.project_id,
          external_read: false,
        })
      else {
        git('worktree', 'remove', linked)
        await request('repository.v1.worktrees', { project_id: project.project_id })
      }
      expect(core.canPublishEvent(actor, hidden)).toBe(false)
      const later = core.append(
        'catalog',
        'fixture.unrelated',
        { kind: 'node' },
        { value: 'allowed-later-event' }
      )
      wire.length = 0
      subscriptions.length = 0
      await client.connect()
      // Before the fix, the server repeatedly sends the later event and the client
      // repeatedly resubscribes after baseline, never committing any new cursor.
      await until(
        async () => (await client.cursor('catalog')) === later.seq || subscriptions.length >= 3
      )
      expect(subscriptions).toHaveLength(1)
      expect(await client.cursor('catalog')).toBe(later.seq)
      expect((await client.history('catalog')).find((e) => e.seq === later.seq)).toEqual(later)
      const marker = (await client.history('catalog')).find((e) => e.seq === hidden.seq)!
      expect(marker).toMatchObject({
        type: 'stream.redacted',
        actor: { kind: 'node' },
        data: { refresh_required: true },
      })
      const events = wire.filter((frame) => frame.kind === 'event')
      expect(JSON.stringify(events)).not.toContain('private-invalidation-generation')
      expect(JSON.stringify(events)).not.toContain(target.worktree_id)
      expect(
        events.some((frame) => frame.kind === 'event' && frame.type === 'repository.invalidated')
      ).toBe(false)
      // The marker's committed cursor survives another reconnect and normal events continue.
      await client.disconnect()
      wire.length = 0
      subscriptions.length = 0
      const newest = core.append(
        'catalog',
        'fixture.unrelated',
        { kind: 'node' },
        { value: 'after-second-reconnect' }
      )
      await client.connect()
      await until(async () => (await client.cursor('catalog')) === newest.seq)
      expect(subscriptions).toHaveLength(1)
      expect(wire.filter((frame) => frame.kind === 'event')).toEqual([newest])
    } finally {
      await client.disconnect()
      await Promise.all(servers)
      await core.resources.stop()
      core.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
