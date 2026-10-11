import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { LocalDiscovery } from '../packages/node-client/src/local-discovery.js'
import { startDaemon } from '../packages/node-daemon/src/index.js'
import { NodeClient, MemoryClientStore } from '@abele/node-client'
const dirs: string[] = [],
  stops: Array<() => Promise<void>> = [],
  clients: NodeClient[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.disconnect()
  for (const stop of stops.splice(0)) await stop()
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})
const runtime = { fs, net, os, path, process }
async function setup() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'local-discovery-'))
  dirs.push(dir)
  const daemon = await startDaemon(dir, 0)
  stops.push(daemon.stop)
  const discovery = new LocalDiscovery(true, () => runtime)
  return { dir, daemon, discovery }
}
it('desktop discovers only protected metadata, creates a local token only on explicit connect, and pins node identity', async () => {
  const { dir, daemon, discovery } = await setup()
  const found = discovery.discover(dir)!
  expect(found).toMatchObject({
    nodeId: daemon.node_id,
    endpoint: `ws://127.0.0.1:${daemon.port}/channel`,
  })
  expect(Object.keys(found).sort()).toEqual(['endpoint', 'nodeId', 'nodeName'])
  const add = vi.fn(async (label: string, url: string, token: string, expectedNodeId: string) => {
    const client = new NodeClient(
      { profile: 'local-token-v1', url, token, expected_node_id: expectedNodeId },
      new MemoryClientStore()
    )
    clients.push(client)
    await client.connect()
    return { label, expectedNodeId }
  })
  const added = await discovery.connect(found, 'Test device', { add })
  expect(added.expectedNodeId).toBe(daemon.node_id)
  expect(add).toHaveBeenCalledTimes(1)
  expect(add.mock.calls[0]![3]).toBe(daemon.node_id)
})
it('mobile does not load Node APIs or inspect the filesystem', () => {
  const load = vi.fn(() => runtime)
  expect(new LocalDiscovery(false, load).discover()).toBeUndefined()
  expect(load).not.toHaveBeenCalled()
})
it('rejects wrong owners, readable locks, symlink state/lock/socket paths, stale runtime records and foreign handles', async () => {
  const { dir, daemon, discovery } = await setup()
  const found = discovery.discover(dir)!
  const lock = path.join(dir, 'daemon.lock')
  const body = fs.readFileSync(lock, 'utf8')
  const value = JSON.parse(body)
  fs.chmodSync(lock, 0o644)
  expect(discovery.discover(dir)).toBeUndefined()
  fs.chmodSync(lock, 0o600)
  const wrongOwner = new LocalDiscovery(true, () => ({
    ...runtime,
    process: { ...process, getuid: () => process.getuid!() + 1 },
  }))
  expect(wrongOwner.discover(dir)).toBeUndefined()
  const alias = dir + '-alias'
  fs.symlinkSync(dir, alias)
  dirs.push(alias)
  expect(discovery.discover(alias)).toBeUndefined()
  fs.renameSync(lock, lock + '.saved')
  fs.symlinkSync(lock + '.saved', lock)
  expect(discovery.discover(dir)).toBeUndefined()
  fs.unlinkSync(lock)
  fs.renameSync(lock + '.saved', lock)
  const socketAlias = path.join(dir, 'socket-alias')
  fs.symlinkSync(value.control_socket, socketAlias)
  fs.writeFileSync(lock, JSON.stringify({ ...value, control_socket: socketAlias }))
  expect(discovery.discover(dir)).toBeUndefined()
  fs.writeFileSync(lock, body)
  const add = vi.fn(async () => ({ expectedNodeId: daemon.node_id }))
  await expect(discovery.connect({ ...found }, 'Test device', { add })).rejects.toThrow(
    'local_discovery_stale'
  )
  fs.writeFileSync(lock, JSON.stringify({ ...value, node_id: 'replaced-node' }))
  await expect(discovery.connect(found, 'Test device', { add })).rejects.toThrow(
    'local_discovery_stale'
  )
  expect(add).not.toHaveBeenCalled()
  fs.writeFileSync(lock, body)
})
