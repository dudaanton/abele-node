import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { NodeCore } from '@abele/node-core'
import { NodeClient, MemoryClientStore } from '@abele/node-client'
import { LocalChannelConnector, RecordQueue } from '@abele/channel-client'
import { FrameCodec, LIMITS, type RecordTransport } from '@abele/channel-protocol'
import { serveChannel } from '../packages/channel-server/src/index.js'
import { legacyExecutionPolicy } from '../packages/channel-server/src/execution-policy-wire.js'
import {
  ProjectSchema as Project042Schema,
  SessionSchema as Session042Schema,
  LiveSessionStateSchema as State042Schema,
  DelegationSchema as Delegation042Schema,
} from './fixtures/protocol-0.4.42.js'
import { servePairedChannel } from '../packages/node-daemon/src/paired.js'
import {
  PairedWssConnector,
  type DeviceKeyStore,
  type PairedDevice,
} from '../packages/node-client/src/paired.js'
import {
  Welcome042Schema,
  Claim042Schema,
  Claimed042Schema,
  Response042Schema,
} from './fixtures/channel-0.4.2.js'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const work of cleanup.splice(0).reverse()) await work()
})
class Keys implements DeviceKeyStore {
  private device?: PairedDevice
  async load() {
    return this.device
  }
  async transaction<T>(
    _node: string,
    work: (device: PairedDevice | undefined) => Promise<{ device: PairedDevice; result: T }>
  ) {
    const next = await work(this.device)
    this.device = next.device
    return next.result
  }
}
function setup(paired: boolean) {
  const dir = mkdtempSync(resolve('.scratch/discovery-compatibility-'))
  const core = new NodeCore(dir)
  cleanup.push(() => {
    core.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const seen: Record<string, unknown>[] = []
  const endpoint = 'wss://node.example.ts.net:8443/channel'
  const open = async (): Promise<RecordTransport> => {
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
    const task = paired ? servePairedChannel(server, core, endpoint) : serveChannel(server, core)
    cleanup.push(async () => {
      await close()
      await task
    })
    return {
      send: async (b) => incoming.push(b),
      close,
      receive: async function* () {
        for await (const bytes of outgoing) {
          const raw = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>
          seen.push(raw)
          // Reproduce the vendored 0.4.2 decoders before the updated client sees
          // each changed server record. No normalization or key removal is allowed.
          if (raw.kind === 'welcome') Welcome042Schema.parse(raw)
          if (raw.kind === 'paired.claimed') Claimed042Schema.parse(raw)
          if (raw.kind === 'response') Response042Schema.parse(raw)
          yield bytes
        }
      },
    }
  }
  return { core, open, endpoint, seen }
}

it.each([false, true])(
  '0.4.2 decoders still pair/connect and chat against the new node (paired=%s)',
  async (paired) => {
    const { core, open, endpoint, seen } = setup(paired)
    let client: NodeClient
    if (paired) {
      const connector = new PairedWssConnector(new Keys(), open)
      const invite = await core.pairing.issue(endpoint, 'legacy phone')
      const claim = await connector.claim(invite)
      expect(Claim042Schema.parse(claim)).toEqual(claim)
      core.pairing.confirm(claim.installation_id, claim.device_fingerprint)
      client = new NodeClient(
        await connector.target(core.node_id),
        new MemoryClientStore(),
        connector
      )
    } else {
      const token = core.createToken('legacy local')
      client = new NodeClient(
        { profile: 'local-token-v1', url: 'ws://127.0.0.1:7777/channel', token: token.token },
        new MemoryClientStore(),
        new LocalChannelConnector(open)
      )
    }
    cleanup.push(() => client.disconnect())
    await client.connect()
    const welcome = seen.find((frame) => frame.kind === 'welcome')!
    expect(Welcome042Schema.parse(welcome)).toEqual(welcome)
    expect(welcome).not.toHaveProperty('node_version')
    expect(welcome).not.toHaveProperty('supported_capabilities')
    const description = (await client.describe()) as {
      node_version: string
      supported_capabilities: string[]
    }
    expect(description).toMatchObject(core.discovery())
    expect(welcome.capabilities).toMatchObject(core.discovery())
    expect(description.supported_capabilities).toEqual(
      expect.arrayContaining(['expected_target', 'session.rename', 'session.delete'])
    )
    const session = await client.createSession('legacy chat')
    const send = await client.send(session.session_id, 'still works', 0)
    await client.flush()
    expect(await client.operationResult(send.operation_id)).toMatchObject({
      result: { input_id: expect.any(String) },
    })
    core.tick()
    expect(core.read(session.session_id, 0).some((event) => event.type === 'input.completed')).toBe(
      true
    )
    // Reconnect an already enrolled installation, not just the new-pairing path.
    await client.connect()
    expect(await client.listSessions()).toEqual([session])
  }
)

it('keeps 0.4.42 strict resource/session decoders working until connection opt-in', async () => {
  const { core, open, seen } = setup(false)
  const client = new NodeClient(
    {
      profile: 'local-token-v1',
      url: 'ws://127.0.0.1:7777/channel',
      token: core.createToken('legacy').token,
    },
    new MemoryClientStore(),
    new LocalChannelConnector(open)
  )
  cleanup.push(() => client.disconnect())
  await client.connect()
  expect(await client.describe()).toMatchObject({
    capabilities: { capabilities: { 'execution.policy.v1': { status: 'supported' } } },
  })
  await client.request('stream.subscribe', { stream_id: 'catalog', after_seq: 0 })
  const session = await client.createSession('legacy resource')
  for (
    let attempts = 0;
    attempts < 100 &&
    !seen.some((frame) => frame.kind === 'event' && frame.type === 'session.created');
    attempts++
  )
    await new Promise((resolve) => setTimeout(resolve, 10))
  Session042Schema.parse(
    seen.find((frame) => frame.kind === 'event' && frame.type === 'session.created')!.data
  )
  for (const enabled of [false, true]) {
    const project = {
      project_id: 'compat-project',
      root_path: '/fixture/project',
      repository_path: null,
      git_common_dir: null,
      trust: 'trusted',
      use_repository_claude_permissions: false,
      codex_network_enabled: enabled,
      created_at: new Date().toISOString(),
    }
    core.db
      .prepare('INSERT OR REPLACE INTO projects(project_id,root_path,body) VALUES(?,?,?)')
      .run(project.project_id, project.root_path, JSON.stringify(project))
    const result = await client.request('project.get', { project_id: project.project_id })
    expect(Project042Schema.parse(result)).not.toHaveProperty('codex_network_enabled')
  }
  const get = () => client.request('session.get', { session_id: session.session_id })
  expect(Session042Schema.parse(await get())).not.toHaveProperty('tool_permissions')
  expect(
    State042Schema.parse(await client.request('session.state', { session_id: session.session_id }))
  ).not.toHaveProperty('tool_permissions')
  const replay = (await client.request('stream.read', {
    stream_id: session.session_id,
    after_seq: 0,
  })) as Array<{ type: string; data: unknown }>
  Session042Schema.parse(replay.find((event) => event.type === 'session.created')!.data)
  await client.request('execution.policy.v1.enable', {})
  expect(await get()).toHaveProperty('tool_permissions')
  expect(await client.request('project.get', { project_id: 'compat-project' })).toHaveProperty(
    'codex_network_enabled',
    true
  )
  await client.connect()
  expect(Session042Schema.parse(await get())).not.toHaveProperty('tool_permissions')
})

it('projects nested setup, delegation and event payloads without altering durable or opaque data', () => {
  const policy = { permission_mode: 'manual', per_action_approval: true, status: 'supported' }
  const delegation = {
    node_id: 'node',
    session_id: 'child',
    delegation_id: 'delegation',
    delegation_key: 'key',
    grant_id: 'grant',
    parent_id: 'parent',
    mailbox_stream_id: 'mailbox',
    workspace_id: null,
    job_id: null,
    state: 'provisioning',
    created_at: new Date().toISOString(),
    tool_permissions: policy,
  }
  const project = {
    project_id: 'project',
    root_path: '/fixture/project',
    repository_path: null,
    git_common_dir: null,
    trust: 'trusted',
    use_repository_claude_permissions: false,
    created_at: new Date().toISOString(),
    codex_network_enabled: true,
  }
  const original = {
    result: { project, delegations: [delegation] },
    data: project,
    input: { project, delegation },
  }
  const projected = legacyExecutionPolicy(original) as typeof original
  Project042Schema.parse(projected.result.project)
  Project042Schema.parse(projected.data)
  Delegation042Schema.parse(projected.result.delegations[0])
  expect(projected.input).toEqual(original.input)
  expect(project.codex_network_enabled).toBe(true)
  expect(delegation.tool_permissions).toEqual(policy)
  const provider = {
    provider: 'acp',
    configuration: {
      permission_modes: ['manual', 'bypassPermissions'],
      per_action_approval: true,
      approval_mode: 'on-request',
      workspace_actions_without_approval: true,
      permission_ttl_ms: 60000,
    },
  }
  expect(legacyExecutionPolicy(provider)).toEqual({
    provider: 'acp',
    configuration: { permission_ttl_ms: 60000 },
  })
  expect(legacyExecutionPolicy({ ...provider, provider: 'pi' })).toEqual({
    provider: 'pi',
    configuration: { permission_ttl_ms: 60000, permission_modes: ['manual', 'bypassPermissions'] },
  })
})

const oldWelcome = {
  kind: 'welcome',
  version: { major: 0, minor: 0 },
  node_id: 'node',
  installation_id: 'installation',
  instance_id: 'instance',
  methods: ['node.describe'],
  limits: LIMITS,
  capabilities: {},
}
const oldClaim = {
  installation_id: 'installation',
  device_fingerprint: 'a'.repeat(64),
  state: 'pending',
}
const decode = (value: unknown) =>
  FrameCodec.decode(new TextEncoder().encode(JSON.stringify(value)))
it('new discovery decoders retain unknown additive keys while validating existing identity fields', () => {
  const welcome = { ...oldWelcome, future_discovery: { supported: ['future.feature'] } }
  const claimed = {
    kind: 'paired.claimed',
    future_discovery: { supported: ['future.envelope'] },
    claim: { ...oldClaim, future_discovery: { supported: ['future.feature'] } },
  }
  expect(Welcome042Schema.safeParse(welcome).success).toBe(false)
  expect(Claimed042Schema.safeParse(claimed).success).toBe(false)
  expect(decode(welcome)).toEqual(welcome)
  expect(decode(claimed)).toEqual(claimed)
  expect(() => decode({ ...welcome, node_id: 123 })).toThrow()
  expect(() => decode({ ...claimed, claim: { ...claimed.claim, state: 'unknown' } })).toThrow()
  // Authority-bearing client input remains strict; this is response tolerance only.
  expect(() =>
    decode({ kind: 'hello', version: { major: 0, minor: 0 }, future_discovery: {} })
  ).toThrow()
})
