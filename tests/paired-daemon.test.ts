import { afterEach, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { PairedListenerSchema, pairedAdmission } from '../packages/node-daemon/src/paired.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import WebSocket from 'ws'
import { startDaemon, offlineToken, control } from '../packages/node-daemon/src/index.js'
import {
  NodeClient,
  MemoryClientStore,
  PairedWssConnector,
  type DeviceKeyStore,
  type PairedDevice,
} from '../packages/node-client/src/index.js'
import { BrowserRecordTransport } from '../packages/channel-client/src/index.js'
import {
  FrameCodec,
  type PairingInvite,
  type RecordTransport,
} from '../packages/channel-protocol/src/index.js'

const dirs: string[] = [],
  stops: Array<() => Promise<void>> = [],
  clients: NodeClient[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.disconnect()
  for (const stop of stops.splice(0)) await stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
class Keys implements DeviceKeyStore {
  device?: PairedDevice
  async load() {
    return this.device
  }
  async save(device: PairedDevice) {
    this.device = device
  }
  private serial: Promise<unknown> = Promise.resolve()
  transaction<T>(
    _node_id: string,
    work: (device: PairedDevice | undefined) => Promise<{ device: PairedDevice; result: T }>
  ): Promise<T> {
    const task = this.serial.then(async () => {
      const next = await work(this.device)
      this.device = next.device
      return next.result
    })
    this.serial = task.catch(() => {})
    return task
  }
}
const endpoint = 'wss://node.example.ts.net:8443/channel'
async function setup() {
  const dir = mkdtempSync(resolve('.scratch/paired-daemon-'))
  dirs.push(dir)
  const local = (await offlineToken(dir, { action: 'create', value: 'owner' })) as {
    token: string
    installation_id: string
  }
  const daemon = await startDaemon(
    dir,
    0,
    undefined,
    {},
    {
      endpoint,
      backend_port: 0,
      origins: ['app://obsidian.md'],
      allow_missing_origin: false,
      allow_null_origin: false,
    }
  )
  stops.push(daemon.stop)
  const open = async (_: string): Promise<RecordTransport> => {
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.paired_port}/channel`, {
      origin: 'app://obsidian.md',
      headers: { Host: 'node.example.ts.net:8443' },
    })
    const transport = new BrowserRecordTransport(ws as unknown as globalThis.WebSocket)
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    return transport
  }
  return { dir, local, daemon, open }
}
async function eventually(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('condition timed out')
}
it('explicit missing/null Origin policy and default HTTPS port are independent of device authorization', () => {
  const config = PairedListenerSchema.parse({
    endpoint: 'wss://node.example.ts.net/channel',
    allow_missing_origin: true,
    allow_null_origin: true,
  })
  expect(config.endpoint).toBe(endpoint)
  expect(pairedAdmission(config, 'node.example.ts.net:8443', undefined, '/channel')).toBe(true)
  expect(pairedAdmission(config, 'node.example.ts.net:8443', 'null', '/channel')).toBe(true)
  expect(
    pairedAdmission(config, 'node.example.ts.net:8443', 'capacitor://localhost', '/channel')
  ).toBe(false)
  expect(() => PairedListenerSchema.parse({ ...config, origins: ['https://*.example'] })).toThrow()
})
it('CLI owner controls and status/doctor use the running paired config and fake Tailscale CLI', async () => {
  const { dir, daemon, open } = await setup()
  const command = async (...args: string[]) =>
    JSON.parse(
      (
        await promisify(execFile)(process.execPath, [
          resolve('packages/node-daemon/dist/cli.js'),
          ...args,
          '--state-dir',
          dir,
        ])
      ).stdout
    )
  const invite = (await command('pair', 'invite', 'cli-device')) as PairingInvite
  const keys = new Keys(),
    connector = new PairedWssConnector(keys, open)
  const claim = await connector.claim(invite)
  expect(await command('pair', 'list')).toContainEqual({
    installation_id: claim.installation_id,
    fingerprint: claim.device_fingerprint,
    state: 'pending',
  })
  await command('pair', 'confirm', claim.installation_id, claim.device_fingerprint)
  const client = new NodeClient(
    await connector.target(daemon.node_id),
    new MemoryClientStore(),
    connector
  )
  clients.push(client)
  await client.connect()
  const doctor = await command('doctor')
  expect(doctor.paired.backend_port).toBe(daemon.paired_port)
  expect(doctor.tailscale).toMatchObject({
    present: true,
    logged_in: true,
    magicdns: true,
    https: true,
    node_mapping: false,
    local_token_unmapped: true,
    policy_verified: false,
  })
  expect((await command('status')).paired.endpoint).toBe(endpoint)
  await expect(command('serve', 'enable')).rejects.toThrow('tailnet-policy-verified')
  await command('pair', 'revoke', claim.installation_id)
  await eventually(async () => !client.connected)
})
it('two independent paired fake devices: claim recovery, local confirmation, durable replay, prompt race, revoke and restart', async () => {
  const { dir, local, daemon, open } = await setup()
  const owner = new NodeClient(
    { url: `ws://127.0.0.1:${daemon.port}/channel`, profile: 'local-token-v1', token: local.token },
    new MemoryClientStore()
  )
  clients.push(owner)
  await owner.connect()
  const keys = [new Keys(), new Keys()]
  const connectors = keys.map((k) => new PairedWssConnector(k, open))
  const stores = [new MemoryClientStore(), new MemoryClientStore()]
  const remotes: NodeClient[] = []
  for (let i = 0; i < 2; i++) {
    const invite = (await control(dir, {
      action: 'pairing.issue',
      endpoint,
      label: `device-${i}`,
    })) as PairingInvite
    const claim = await connectors[i]!.claim(invite)
    expect(await connectors[i]!.claim(invite)).toEqual(claim)
    await expect(
      connectors[i]!.connect(await connectors[i]!.target(invite.node_id))
    ).rejects.toThrow()
    // Owner confirms the fingerprint shown on the independently enrolling device.
    await owner.request('pairing.confirm', {
      installation_id: claim.installation_id,
      device_fingerprint: claim.device_fingerprint,
    })
    const remote = new NodeClient(
      await connectors[i]!.target(invite.node_id),
      stores[i]!,
      connectors[i]
    )
    clients.push(remote)
    remotes.push(remote)
    await remote.connect()
    await expect(remote.request('pairing.list', {})).rejects.toThrow('local_owner_required')
  }
  const [a, b] = remotes as [NodeClient, NodeClient]
  const session = await a.createSession('remote fake')
  await Promise.all([a.subscribe(session.session_id), b.subscribe(session.session_id)])
  await a.disconnect()
  const input = await a.send(session.session_id, 'offline', 0, [
    { kind: 'permission', ttl_ms: 60000 },
    { kind: 'echo' },
  ])
  await a.connect()
  await eventually(async () =>
    (await b.prompts(session.session_id)).some((p) => p.state === 'pending')
  )
  const prompt = (await b.prompts(session.session_id)).find((p) => p.state === 'pending')!
  await Promise.all([a.answerPrompt(prompt, 'allow'), b.answerPrompt(prompt, 'deny')])
  expect(await a.operationResult(input.operation_id)).toBeDefined()
  await eventually(async () =>
    (await a.history(session.session_id)).some(
      (e) => e.type === 'input.completed' || e.type === 'input.failed'
    )
  )
  await eventually(
    async () =>
      (await a.history(session.session_id)).length === (await b.history(session.session_id)).length
  )
  expect(await a.history(session.session_id)).toEqual(await b.history(session.session_id))
  const before = await a.history(session.session_id)
  const revoked = keys[1]!.device!.installation_id!
  await control(dir, { action: 'pairing.revoke', installation_id: revoked })
  await eventually(async () => !b.connected)
  await expect(b.connect()).rejects.toThrow()
  await a.disconnect()
  await owner.disconnect()
  await daemon.stop()
  const restarted = await startDaemon(
    dir,
    0,
    undefined,
    {},
    {
      endpoint,
      backend_port: 0,
      origins: ['app://obsidian.md'],
      allow_missing_origin: false,
      allow_null_origin: false,
    }
  )
  stops.push(restarted.stop)
  expect(restarted.node_id).toBe(daemon.node_id)
  const reopen = async (_: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${restarted.paired_port}/channel`, {
      origin: 'app://obsidian.md',
      headers: { Host: 'node.example.ts.net:8443' },
    })
    const t = new BrowserRecordTransport(ws as unknown as globalThis.WebSocket)
    await new Promise<void>((r, j) => {
      ws.once('open', r)
      ws.once('error', j)
    })
    return t
  }
  const connector = new PairedWssConnector(keys[0]!, reopen)
  const restored = new NodeClient(await connector.target(daemon.node_id), stores[0]!, connector)
  clients.push(restored)
  await restored.connect()
  expect(await restored.history(session.session_id)).toEqual(before)
  // No changed node key may be accepted silently, even when TLS/endpoint stays unchanged.
  await control(dir, { action: 'pairing.rotate' })
  await eventually(async () => !restored.connected)
  await expect(restored.connect()).rejects.toThrow('node_identity_mismatch')
})
it('paired listener refuses local-token from loopback and exact Host/path/Origin policy ignores forwarded headers', async () => {
  const { daemon, local } = await setup()
  async function admission(headers: Record<string, string>, path = '/channel') {
    const ws = new WebSocket(`ws://127.0.0.1:${daemon.paired_port}${path}`, { headers })
    let opened = false
    ws.on('error', () => {})
    ws.once('open', () => {
      opened = true
      ws.close()
    })
    await new Promise<void>((r) => ws.once('close', () => r()))
    return opened
  }
  expect(
    await admission({ Host: 'node.example.ts.net:8443', Origin: 'https://evil.example' })
  ).toBe(false)
  expect(await admission({ Host: 'node.example.ts.net:8443' })).toBe(false)
  expect(await admission({ Host: 'node.example.ts.net:8443', Origin: 'null' })).toBe(false)
  expect(
    await admission({
      Host: 'evil.example',
      Origin: 'app://obsidian.md',
      'X-Forwarded-Host': 'node.example.ts.net:8443',
    })
  ).toBe(false)
  expect(
    await admission(
      { Host: 'node.example.ts.net:8443', Origin: 'app://obsidian.md' },
      '/channel?token=x'
    )
  ).toBe(false)
  const ws = new WebSocket(`ws://127.0.0.1:${daemon.paired_port}/channel`, {
    origin: 'app://obsidian.md',
    headers: { Host: 'node.example.ts.net:8443' },
  })
  ws.on('error', () => {})
  let authenticated = false
  ws.on('message', () => {
    authenticated = true
  })
  ws.once('open', () =>
    ws.send(FrameCodec.encode({ kind: 'auth', profile: 'local-token-v1', token: local.token }))
  )
  await new Promise<void>((r) => ws.once('close', () => r()))
  expect(authenticated).toBe(false)
})
