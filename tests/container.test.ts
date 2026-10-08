import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { startDaemon, offlineToken } from '../packages/node-daemon/src/index.js'
import { NodeClient, MemoryClientStore } from '../packages/node-client/src/index.js'
import {
  BrowserRecordTransport,
  LocalChannelConnector,
} from '../packages/channel-client/src/index.js'

// The container wrapper is intentionally plain JS and consumes built production packages.
// @ts-expect-error standalone container entrypoint has no declaration file
import { createForwarder, checkHealth } from '../scripts/container.mjs'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const work of cleanup.splice(0).reverse()) await work()
})

it('forwards the Docker port without weakening Host, Origin or token admission', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abele-container-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const daemon = await startDaemon(dir, 0)
  cleanup.push(() => daemon.stop())
  const proxy = await createForwarder(daemon.port, 0, '127.0.0.1')
  cleanup.push(() => proxy.close())
  await checkHealth(dir, proxy.port)
  await expect(checkHealth(dir, 1)).rejects.toThrow()

  const connect = (headers: Record<string, string>) =>
    new Promise<boolean>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/channel`, { headers })
      let open = false
      ws.on('error', () => {})
      ws.once('open', () => {
        open = true
        ws.terminate()
      })
      ws.once('close', () => resolve(open))
    })
  expect(await connect({ Host: `127.0.0.1:${proxy.port}` })).toBe(false)
  expect(
    await connect({ Host: `127.0.0.1:${daemon.port}`, Origin: 'https://example.invalid' })
  ).toBe(false)
  expect(await connect({ Host: `127.0.0.1:${daemon.port}`, Origin: 'app://obsidian.md' })).toBe(
    true
  )

  // Simulate Docker DNAT: endpoint port stays the daemon's advertised port, but TCP goes to proxy.
  const connector = new LocalChannelConnector(async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/channel`, {
      headers: { Host: `127.0.0.1:${daemon.port}` },
    })
    const transport = new BrowserRecordTransport(ws as unknown as globalThis.WebSocket)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    return transport
  })
  // Enrollment still requires a valid token; a successful health upgrade alone grants nothing.
  const target = {
    url: `ws://127.0.0.1:${daemon.port}/channel`,
    profile: 'local-token-v1' as const,
  }
  const bad = new NodeClient(
    { ...target, token: '0'.repeat(64) },
    new MemoryClientStore(),
    connector
  )
  cleanup.push(() => bad.disconnect())
  await expect(bad.connect()).rejects.toThrow()
  const token = (await offlineToken(dir, { action: 'create', value: 'container-test' })) as {
    token: string
  }
  const good = new NodeClient({ ...target, token: token.token }, new MemoryClientStore(), connector)
  cleanup.push(() => good.disconnect())
  await good.connect()
  expect(await good.listSessions()).toEqual([])
})
