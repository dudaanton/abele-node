import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeCore } from '@abele/node-core'
import { RecordQueue } from '@abele/channel-client'
import { FrameCodec, type RecordFrame } from '@abele/channel-protocol'
import { serveChannel } from '../packages/channel-server/src/index.js'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const f of cleanup.splice(0).reverse()) await f()
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function until(fn: () => boolean) {
  for (let i = 0; i < 400; i++) {
    if (fn()) return
    await sleep(5)
  }
  throw Error('publication fixture deadline')
}
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'abele-mailbox-publication-')),
    core = new NodeCore(dir)
  cleanup.push(() => {
    core.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const owner = core.authority.authenticate(core.createToken('owner').token),
    controller = core.authority.authenticate(core.createToken('controller').token)
  const grant = core.request(
    owner,
    'delegation.grant.create',
    {
      installation_id: controller.installation_id,
      parent_id: 'parent',
      project_ids: [],
      allow_fake: true,
    },
    'grant'
  ) as any
  const child = (await core.request(
    controller,
    'delegation.create',
    {
      grant_id: grant.grant_id,
      delegation_key: 'key',
      title: 'child',
      provider: 'fake',
      text: 'private durable result',
    },
    'create'
  )) as any
  core.tick()
  const revoke = () =>
    core.request(owner, 'delegation.grant.revoke', { grant_id: grant.grant_id }, 'revoke')
  return { core, controller, child, revoke }
}
async function channel(
  f: Awaited<ReturnType<typeof fixture>>,
  shouldBlock: (frame: RecordFrame) => boolean
) {
  const incoming = new RecordQueue(),
    frames: RecordFrame[] = []
  let blocked = false,
    closed = false,
    release: () => void = () => {}
  const server = serveChannel(
    {
      receive: () => incoming,
      close: async () => {
        closed = true
        incoming.end()
      },
      send: async (bytes) => {
        const frame = FrameCodec.decode(bytes)
        frames.push(frame)
        if (!blocked && shouldBlock(frame)) {
          blocked = true
          await new Promise<void>((r) => {
            release = r
          })
        }
      },
    },
    f.core,
    f.controller
  )
  cleanup.push(async () => {
    release()
    incoming.end()
    await server
  })
  const request = (method: string, params: unknown, request_id: string) =>
    incoming.push(FrameCodec.encode({ kind: 'request', method, params, request_id }))
  incoming.push(FrameCodec.encode({ kind: 'hello', version: { major: 0, minor: 0 } }))
  await until(() => frames.some((f) => f.kind === 'welcome'))
  return {
    frames,
    request,
    server,
    get blocked() {
      return blocked
    },
    get closed() {
      return closed
    },
    release() {
      release()
    },
  }
}
it('checks the grant and stream immediately before every replay event, including the rest of an already-read page', async () => {
  const f = await fixture(),
    c = await channel(f, (frame) => frame.kind === 'event')
  c.request('stream.subscribe', { stream_id: f.child.mailbox_stream_id, after_seq: 0 }, 'subscribe')
  await until(() => c.blocked)
  expect(
    f.core.read(f.child.mailbox_stream_id, 0).some((e) => e.type === 'delegation.result')
  ).toBe(true)
  f.revoke()
  c.release()
  await until(() => c.closed)
  await c.server
  // The first event had already entered transport.send; all remaining page records must be fenced.
  expect(c.frames.filter((f) => f.kind === 'event')).toHaveLength(1)
  expect(c.frames.some((f) => f.kind === 'event' && f.type === 'delegation.result')).toBe(false)
})
for (const method of ['stream.read', 'delegation.status'] as const)
  it(`rechecks authority of a queued ${method} response at the actual scheduler publication boundary`, async () => {
    const f = await fixture(),
      c = await channel(f, (frame) => frame.kind === 'response' && frame.request_id === 'blocked')
    c.request('node.describe', {}, 'blocked')
    await until(() => c.blocked)
    const params =
      method === 'stream.read'
        ? { stream_id: f.child.mailbox_stream_id, after_seq: 0 }
        : { delegation_id: f.child.delegation_id }
    const original = f.core.request.bind(f.core)
    let read = false
    f.core.request = (actor, m, p, op) => {
      const result = original(actor, m, p, op)
      if (m === method) read = true
      return result
    }
    c.request(method, params, 'private')
    await until(() => read)
    f.revoke()
    c.release()
    await until(
      () => c.closed || c.frames.some((f) => f.kind === 'response' && f.request_id === 'private')
    )
    expect(c.frames.some((f) => f.kind === 'response' && f.request_id === 'private')).toBe(false)
    expect(c.closed).toBe(true)
  })
