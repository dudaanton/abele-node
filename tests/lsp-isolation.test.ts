import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeCore } from '@abele/node-core'
import { serveChannel } from '../packages/channel-server/src/index.js'
import { LocalChannelConnector, RecordQueue } from '../packages/channel-client/src/index.js'
import { NodeClient, MemoryClientStore } from '../packages/node-client/src/index.js'

it.each(['lsp_exited', 'server initialization failed'])(
  'keeps the authenticated channel usable after a language server crashes: %s',
  async (failure) => {
    const dir = mkdtempSync(join(tmpdir(), 'lsp-isolation-')),
      core = new NodeCore(dir)
    const token = core.createToken('fixture'),
      incoming = new RecordQueue(),
      outgoing = new RecordQueue()
    const close = async () => {
      incoming.end()
      outgoing.end()
    }
    const server = serveChannel(
      { receive: () => incoming, send: async (b) => outgoing.push(b), close },
      core
    )
    const client = new NodeClient(
      { url: 'ws://127.0.0.1:7777/channel', profile: 'local-token-v1', token: token.token },
      new MemoryClientStore(),
      new LocalChannelConnector(async () => ({
        receive: () => outgoing,
        send: async (b) => incoming.push(b),
        close,
      }))
    )
    vi.spyOn(core.resources.lsp, 'root').mockReturnValue(dir)
    vi.spyOn(core.resources.lsp.service, 'open').mockRejectedValue(new Error(failure))
    try {
      await client.connect()
      await expect(
        client.request('lsp.v1.open', { workspace_id: 'fixture', path: 'a.ts' })
      ).rejects.toMatchObject({
        code: 'lsp_unavailable',
        details: { reason: failure === 'lsp_exited' ? failure : 'lsp_failed' },
      })
      expect(client.connected).toBe(true)
      expect(await client.describe()).toHaveProperty('node_id')
    } finally {
      await client.disconnect()
      await close()
      await server
      await core.resources.stop()
      core.close()
      rmSync(dir, { recursive: true, force: true })
      vi.restoreAllMocks()
    }
  }
)

it('admits heartbeat and unrelated requests while language status is slow', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lsp-slow-')),
    core = new NodeCore(dir)
  const token = core.createToken('fixture'),
    incoming = new RecordQueue(),
    outgoing = new RecordQueue()
  const close = async () => {
    incoming.end()
    outgoing.end()
  }
  const server = serveChannel(
    { receive: () => incoming, send: async (b) => outgoing.push(b), close },
    core
  )
  const client = new NodeClient(
    { url: 'ws://127.0.0.1:7777/channel', profile: 'local-token-v1', token: token.token },
    new MemoryClientStore(),
    new LocalChannelConnector(async () => ({
      receive: () => outgoing,
      send: async (b) => incoming.push(b),
      close,
    }))
  )
  let release!: () => void, started!: () => void
  const entered = new Promise<void>((r) => {
    started = r
  })
  const gate = new Promise<void>((r) => {
    release = r
  })
  const original = core.request.bind(core)
  vi.spyOn(core, 'request').mockImplementation((actor, method, ...args) => {
    if (method === 'lsp.v1.status') {
      started()
      return gate.then(() => [])
    }
    return original(actor, method, ...args)
  })
  let slow: Promise<unknown> | undefined
  try {
    await client.connect()
    slow = client.request('lsp.v1.status', {})
    await entered
    let responsive = false
    const describe = client.describe().then(() => {
      responsive = true
    })
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(responsive).toBe(true)
    release()
    await Promise.all([slow, describe])
  } finally {
    release()
    await slow?.catch(() => {})
    await client.disconnect()
    await close()
    await server
    await core.resources.stop()
    core.close()
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  }
})
