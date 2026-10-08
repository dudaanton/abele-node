import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { NodeCore } from '@abele/node-core'
import { AsyncLocalStorage } from 'node:async_hooks'
import { servePairedChannel } from '../packages/node-daemon/src/paired.js'
import {
  PairedWssConnector,
  type DeviceKeyStore,
  type PairedDevice,
} from '../packages/node-client/src/paired.js'
import { RecordQueue } from '../packages/channel-client/src/index.js'
import {
  FrameCodec,
  generateIdentity,
  randomNonce,
  signProof,
  proofTranscript,
  type RecordTransport,
  type RecordFrame,
  type AuthorityContext,
} from '../packages/channel-protocol/src/index.js'

const clockDomain = new AsyncLocalStorage<'server'>()
const dirs: string[] = [],
  cores: NodeCore[] = [],
  tasks: Promise<void>[] = [],
  transports: RecordTransport[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const t of transports.splice(0)) await t.close('test_done')
  await Promise.allSettled(tasks.splice(0))
  for (const c of cores.splice(0)) c.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function setup() {
  const dir = mkdtempSync(resolve('.scratch/paired-security-'))
  dirs.push(dir)
  const core = new NodeCore(dir)
  cores.push(core)
  const endpoint = 'wss://node.example.ts.net:8443/channel'
  const open = async () => {
    const incoming = new RecordQueue(),
      outgoing = new RecordQueue()
    const close = async () => {
      incoming.end()
      outgoing.end()
    }
    const server = {
      send: async (b: Uint8Array) => outgoing.push(b),
      receive: () => incoming,
      close,
    }
    const client = {
      send: async (b: Uint8Array) => incoming.push(b),
      receive: () => outgoing,
      close,
    }
    transports.push(client)
    tasks.push(clockDomain.run('server', () => servePairedChannel(server, core, endpoint)))
    return client
  }
  return { core, endpoint, open }
}
function pendingPermission(
  core: NodeCore,
  actor: AuthorityContext,
  session_id: string,
  operation: string
) {
  core.request(
    actor,
    'session.send',
    {
      session_id,
      text: 'permission',
      observed_seq: 0,
      script: [{ kind: 'permission', ttl_ms: 60000 }],
    },
    operation
  )
  core.tick()
  const prompt = core.prompts(session_id).find((p) => p.state === 'pending')
  expect(prompt).toBeDefined()
  return prompt!
}
function permissionAnswer(prompt: ReturnType<typeof pendingPermission>) {
  return {
    session_id: prompt.session_id,
    prompt_id: prompt.prompt_id,
    run_id: prompt.run_id,
    revision: prompt.revision,
    action_digest: prompt.action_digest,
    choice: 'allow' as const,
  }
}
class Keys implements DeviceKeyStore {
  device?: PairedDevice
  async load() {
    return this.device
  }
  async save(d: PairedDevice) {
    this.device = d
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
async function read(t: RecordTransport): Promise<RecordFrame | undefined> {
  const row = await t.receive()[Symbol.asyncIterator]().next()
  return row.done ? undefined : FrameCodec.decode(row.value)
}
it('actual claim response loss recovers only with the persisted device private key', async () => {
  const { core, endpoint, open } = setup()
  const invite = await core.pairing.issue(endpoint, 'lost-reply')
  const keys = new Keys()
  const lossy = new PairedWssConnector(keys, async () => {
    const t = await open()
    return {
      ...t,
      receive: async function* () {
        for await (const bytes of t.receive()) {
          if (FrameCodec.decode(bytes).kind === 'paired.claimed') {
            await t.close()
            return
          }
          yield bytes
        }
      },
    }
  })
  await expect(lossy.claim(invite)).rejects.toThrow('connection_closed')
  expect(keys.device?.installation_id).toBeUndefined()
  expect(core.pairing.list()).toHaveLength(1)
  const same = new PairedWssConnector(keys, open)
  const claim = await same.claim(invite)
  expect(claim.state).toBe('pending')
  expect(core.pairing.list()).toHaveLength(1)
  await expect(new PairedWssConnector(new Keys(), open).claim(invite)).rejects.toThrow()
  expect(() => core.pairing.confirm(claim.installation_id, '0'.repeat(64))).toThrow('key_mismatch')
})
it('concurrent claims through separate connectors preserve the consumed key after all responses are lost', async () => {
  const { core, endpoint, open } = setup()
  const invite = await core.pairing.issue(endpoint, 'concurrent-lost-reply')
  let releaseReads!: () => void, accepted!: () => void
  const bothRead = new Promise<void>((resolve) => {
    releaseReads = resolve
  })
  const consumed = new Promise<void>((resolve) => {
    accepted = resolve
  })
  class ConcurrentKeys extends Keys {
    private reads = 0
    async load() {
      const snapshot = this.device
      if (!snapshot) {
        if (++this.reads === 2) releaseReads()
        await bothRead
      }
      return snapshot
    }
  }
  const keys = new ConcurrentKeys()
  const generate = globalThis.crypto.subtle.generateKey.bind(globalThis.crypto.subtle)
  let generations = 0
  vi.spyOn(globalThis.crypto.subtle, 'generateKey').mockImplementation(async (...args) => {
    // Reproduce A accepted before B overwrites the persistent key, without relying on scheduler luck.
    if (++generations === 2) await consumed
    return generate(...args)
  })
  const loseReply = async () => {
    const t = await open()
    return {
      ...t,
      receive: async function* () {
        for await (const bytes of t.receive()) {
          if (FrameCodec.decode(bytes).kind === 'paired.claimed') {
            accepted()
            await t.close()
            return
          }
          yield bytes
        }
      },
    }
  }
  const attempts = await Promise.allSettled([
    new PairedWssConnector(keys, loseReply).claim(invite),
    new PairedWssConnector(keys, loseReply).claim(invite),
  ])
  expect(attempts.map((result) => result.status)).toEqual(['rejected', 'rejected'])
  expect(core.pairing.list()).toHaveLength(1)
  const recovered = await new PairedWssConnector(keys, open).claim(invite)
  expect(recovered.device_fingerprint).toBe(core.pairing.list()[0]!.fingerprint)
  expect(generations).toBe(1)
})
it('two independent key-store adapters serialize creation and recover one consumed key after lost replies', async () => {
  const { core, endpoint, open } = setup()
  const invite = await core.pairing.issue(endpoint, 'independent-adapters')
  const devices = new Map<string, PairedDevice>(),
    queues = new Map<string, Promise<unknown>>()
  let requested = 0,
    entered = 0
  // Each adapter has its own object/lifecycle. The namespace transaction boundary is shared storage,
  // not a mutex hidden inside one connector or one DeviceKeyStore adapter instance.
  const adapter = (): DeviceKeyStore => ({
    load: async (node_id) => structuredClone(devices.get(node_id)),
    transaction: <T>(
      node_id: string,
      work: (device: PairedDevice | undefined) => Promise<{ device: PairedDevice; result: T }>
    ): Promise<T> => {
      requested++
      const task = (queues.get(node_id) ?? Promise.resolve()).then(async () => {
        entered++
        const next = await work(structuredClone(devices.get(node_id)))
        devices.set(node_id, structuredClone(next.device))
        return structuredClone(next.result)
      })
      queues.set(
        node_id,
        task.catch(() => {})
      )
      return task
    },
  })
  const first = adapter(),
    second = adapter()
  expect(first).not.toBe(second)
  let generated!: () => void, release!: () => void
  const generating = new Promise<void>((resolve) => {
    generated = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  const generate = globalThis.crypto.subtle.generateKey.bind(globalThis.crypto.subtle)
  let generations = 0
  vi.spyOn(globalThis.crypto.subtle, 'generateKey').mockImplementation(async (...args) => {
    generations++
    const pair = await generate(...args)
    generated()
    await held
    return pair
  })
  const loseReply = async () => {
    const t = await open()
    return {
      ...t,
      receive: async function* () {
        for await (const bytes of t.receive()) {
          if (FrameCodec.decode(bytes).kind === 'paired.claimed') {
            await t.close()
            return
          }
          yield bytes
        }
      },
    }
  }
  const attempts = Promise.allSettled([
    new PairedWssConnector(first, loseReply).claim(invite),
    new PairedWssConnector(second, loseReply).claim(invite),
  ])
  try {
    await generating
    expect(requested).toBe(2)
    expect(entered).toBe(1)
    expect(generations).toBe(1)
  } finally {
    release()
    await attempts
  }
  expect((await attempts).map((result) => result.status)).toEqual(['rejected', 'rejected'])
  const a = await first.load(core.node_id),
    b = await second.load(core.node_id)
  expect(a).not.toBe(b)
  expect(a?.public_key).toEqual(b?.public_key)
  expect(core.pairing.list()).toHaveLength(1)
  const recovered = await new PairedWssConnector(adapter(), open).claim(invite)
  expect(recovered.device_fingerprint).toBe(core.pairing.list()[0]!.fingerprint)
  expect(generations).toBe(1)
})
it.each(['key', 'pin'] as const)(
  'late claim binding cannot overwrite an explicit %s change',
  async (change) => {
    const { core, endpoint, open } = setup()
    const invite = await core.pairing.issue(endpoint, 'late-binding')
    const keys = new Keys()
    let received!: () => void, release!: () => void
    const responseReady = new Promise<void>((resolve) => {
      received = resolve
    })
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const connector = new PairedWssConnector(keys, async () => {
      const t = await open()
      return {
        ...t,
        receive: async function* () {
          for await (const bytes of t.receive()) {
            if (FrameCodec.decode(bytes).kind === 'paired.claimed') {
              received()
              await held
            }
            yield bytes
          }
        },
      }
    })
    const attempt = connector.claim(invite)
    const rejected = expect(attempt).rejects.toThrow('device_identity_mismatch')
    try {
      await responseReady
      const original = keys.device!
      expect(original.installation_id).toBeUndefined()
      const accepted = core.pairing.list()[0]!
      const otherConnector = new PairedWssConnector(keys, open)
      if (change === 'key') {
        await keys.transaction(core.node_id, async (current) => ({
          device: { ...current!, ...(await generateIdentity()) },
          result: undefined,
        }))
      } else {
        await core.pairing.identity.rotate()
        const renewed = await core.pairing.issue(
          endpoint,
          'new-pin',
          300000,
          String(accepted.installation_id)
        )
        await otherConnector.authorizeNodeKeyChange(renewed, original.node_fingerprint)
      }
      const replacement = keys.device!
      expect(replacement).not.toBe(original)
      release()
      await rejected
      // Both the key/pin and unbound principal must stay exactly as explicitly persisted.
      expect(keys.device).toBe(replacement)
      expect(keys.device?.installation_id).toBeUndefined()
      // A legitimate fresh enrollment still works with the retained replacement identity.
      core.pairing.revoke(String(accepted.installation_id))
      const recovery = await core.pairing.issue(
        endpoint,
        'recover',
        300000,
        String(accepted.installation_id)
      )
      const recovered = await otherConnector.claim(recovery)
      expect(recovered.installation_id).toBe(accepted.installation_id)
      core.pairing.confirm(recovered.installation_id, recovered.device_fingerprint)
      const channel = await otherConnector.connect(await otherConnector.target(core.node_id))
      await channel.transport.close('replacement_verified')
    } finally {
      release()
      await attempt.catch(() => {})
    }
  }
)
it.each([-86400000, -1000, 1000, 86400000])(
  'claim and connect accept valid fresh challenges with client clock skew %s ms',
  async (skew) => {
    const { core, endpoint, open } = setup()
    const invite = await core.pairing.issue(endpoint, 'skew')
    const realNow = Date.now.bind(Date)
    vi.spyOn(Date, 'now').mockImplementation(
      () => realNow() + (clockDomain.getStore() === 'server' ? 0 : skew)
    )
    const keys = new Keys(),
      connector = new PairedWssConnector(keys, open)
    const claim = await connector.claim(invite)
    core.pairing.confirm(claim.installation_id, claim.device_fingerprint)
    const channel = await connector.connect(await connector.target(core.node_id))
    expect(channel.authority.installation_id).toBe(claim.installation_id)
    await channel.transport.close('skew_verified')
    await clockDomain.run('server', () => core.pairing.identity.rotate())
    const renewed = await clockDomain.run('server', () =>
      core.pairing.issue(endpoint, 'skew-recovery', 300000, claim.installation_id)
    )
    await connector.authorizeNodeKeyChange(renewed, invite.node_fingerprint)
    const recovered = await connector.claim(renewed)
    expect(recovered.installation_id).toBe(claim.installation_id)
    core.pairing.confirm(recovered.installation_id, recovered.device_fingerprint)
    const restored = await connector.connect(await connector.target(core.node_id))
    await restored.transport.close('skew_recovery_verified')
  }
)
it('a challenge that outlasts the local monotonic deadline during verification cannot elicit a device proof', async () => {
  const { core, endpoint, open } = setup()
  const invite = await core.pairing.issue(endpoint, 'local-deadline')
  const started = performance.now(),
    proofs: Uint8Array[] = []
  const connector = new PairedWssConnector(new Keys(), async () => {
    const t = await open()
    return {
      ...t,
      send: async (bytes) => {
        if (FrameCodec.decode(bytes).kind === 'paired.proof') proofs.push(bytes)
        await t.send(bytes)
      },
    }
  })
  const verify = globalThis.crypto.subtle.verify.bind(globalThis.crypto.subtle)
  vi.spyOn(globalThis.crypto.subtle, 'verify').mockImplementation(async (...args) => {
    const valid = await verify(...args)
    vi.spyOn(performance, 'now').mockReturnValue(started + 20000)
    return valid
  })
  await expect(connector.claim(invite)).rejects.toThrow('connection_timeout')
  expect(proofs).toHaveLength(0)
  expect(core.pairing.list()).toHaveLength(0)
})
it('device proofs cannot be replayed on another connection or used after expiry', async () => {
  const { core, endpoint, open } = setup()
  const keys = new Keys(),
    connector = new PairedWssConnector(keys, open)
  const invite = await core.pairing.issue(endpoint, 'replay')
  const claim = await connector.claim(invite)
  core.pairing.confirm(claim.installation_id, claim.device_fingerprint)
  const device = keys.device!
  const challenge = async () => {
    const t = await open()
    await t.send(
      FrameCodec.encode({
        kind: 'paired.begin',
        profile: 'paired-wss-v1',
        client_nonce: randomNonce(),
        public_key: device.public_key,
        installation_id: device.installation_id,
      })
    )
    const c = await read(t)
    if (c?.kind !== 'paired.challenge') throw new Error('no challenge')
    return { t, c }
  }
  const first = await challenge()
  const signature = await signProof(device.private_key, proofTranscript(first.c, 'device'))
  await first.t.close()
  const second = await challenge()
  expect(second.c.connection_id).not.toBe(first.c.connection_id)
  await second.t.send(FrameCodec.encode({ kind: 'paired.proof', signature }))
  expect(await read(second.t)).toBeUndefined()
  const expired = await challenge()
  const expiringProof = await signProof(device.private_key, proofTranscript(expired.c, 'device'))
  vi.spyOn(Date, 'now').mockReturnValue(expired.c.expires_at)
  await expired.t.send(FrameCodec.encode({ kind: 'paired.proof', signature: expiringProof }))
  expect(await read(expired.t)).toBeUndefined()
  vi.restoreAllMocks()
  const slowVerify = await challenge()
  const delayedProof = await signProof(device.private_key, proofTranscript(slowVerify.c, 'device'))
  const verify = globalThis.crypto.subtle.verify.bind(globalThis.crypto.subtle)
  vi.spyOn(globalThis.crypto.subtle, 'verify').mockImplementation(async (...args) => {
    const valid = await verify(...args)
    vi.spyOn(Date, 'now').mockReturnValue(slowVerify.c.expires_at)
    return valid
  })
  await slowVerify.t.send(FrameCodec.encode({ kind: 'paired.proof', signature: delayedProof }))
  expect(await read(slowVerify.t)).toBeUndefined()
})
it('node-key substitution and stored-device substitution fail closed before proof disclosure', async () => {
  const { core, endpoint, open } = setup()
  const keys = new Keys()
  const invite = await core.pairing.issue(endpoint, 'pin')
  const connector = new PairedWssConnector(keys, open)
  const claim = await connector.claim(invite)
  core.pairing.confirm(claim.installation_id, claim.device_fingerprint)
  const target = await connector.target(core.node_id)
  if (target.profile !== 'paired-wss-v1') throw new Error('unexpected profile')
  await expect(connector.connect({ ...target, node_fingerprint: '0'.repeat(64) })).rejects.toThrow(
    'device_identity_mismatch'
  )
  await expect(
    connector.connect({ ...target, public_key: (await generateIdentity()).public_key })
  ).rejects.toThrow('device_identity_mismatch')
  const original = keys.device!
  keys.device = { ...original, node_id: 'substituted-node' }
  await expect(connector.connect(target)).rejects.toThrow('device_identity_mismatch')
  keys.device = original
  await core.pairing.identity.rotate()
  await expect(connector.connect(target)).rejects.toThrow('node_identity_mismatch')
  const renewed = await core.pairing.issue(endpoint, 'renewed', 300000, claim.installation_id)
  await expect(connector.claim(renewed)).rejects.toThrow('node_identity_mismatch')
  await expect(connector.authorizeNodeKeyChange(renewed, '0'.repeat(64))).rejects.toThrow(
    'node_identity_mismatch'
  )
  await connector.authorizeNodeKeyChange(renewed, target.node_fingerprint)
  const renewal = await connector.claim(renewed)
  expect(renewal.installation_id).toBe(claim.installation_id)
  core.pairing.confirm(renewal.installation_id, renewal.device_fingerprint)
  const channel = await connector.connect(await connector.target(core.node_id))
  await channel.transport.close('renewal_verified')
})
it('an unpaired peer cannot authenticate with a stolen installation ID and its own key', async () => {
  const { core, endpoint, open } = setup()
  const owner = core.createToken('owner')
  const attacker = await generateIdentity()
  const t = await open()
  await t.send(
    FrameCodec.encode({
      kind: 'paired.begin',
      profile: 'paired-wss-v1',
      client_nonce: randomNonce(),
      public_key: attacker.public_key,
      installation_id: owner.installation_id,
    })
  )
  const challenge = await read(t)
  if (challenge?.kind !== 'paired.challenge') throw new Error('no challenge')
  await t.send(
    FrameCodec.encode({
      kind: 'paired.proof',
      signature: await signProof(attacker.private_key, proofTranscript(challenge, 'device')),
    })
  )
  expect(await read(t)).toBeUndefined()
  expect(core.pairing.list()).toHaveLength(0)
})
it('expired unused invitations are refused without allocating an installation', async () => {
  const { core, endpoint, open } = setup()
  const invite = await core.pairing.issue(endpoint, 'expiry', 1)
  vi.spyOn(Date, 'now').mockReturnValue(invite.expires_at + 1)
  await expect(new PairedWssConnector(new Keys(), open).claim(invite)).rejects.toThrow()
  expect(core.pairing.list()).toHaveLength(0)
  expect(core.listTokens()).toHaveLength(0)
})
it('revocation after a valid artifact read waits in processing fences the response at publication', async () => {
  const { core, endpoint, open } = setup()
  const keys = new Keys(),
    connector = new PairedWssConnector(keys, open)
  const invite = await core.pairing.issue(endpoint, 'artifact-wait')
  const claim = await connector.claim(invite)
  core.pairing.confirm(claim.installation_id, claim.device_fingerprint)
  const actor = core.pairing.actor(claim.installation_id, keys.device!.public_key)
  const session = core.request(actor, 'session.create', { title: 'artifact-wait' }, 'create') as {
    session_id: string
  }
  core.db
    .prepare('INSERT INTO artifacts VALUES(?,?,?)')
    .run('artifact-wait', session.session_id, new Uint8Array([1, 2]))
  const params = {
    session_id: session.session_id,
    artifact_id: 'artifact-wait',
    offset: 0,
    length: 2,
  }
  const channel = await connector.connect(await connector.target(core.node_id))
  const request = (request_id: string) =>
    channel.transport.send(
      FrameCodec.encode({ kind: 'request', request_id, method: 'artifact.read', params })
    )
  await request('positive-read')
  expect(await read(channel.transport)).toMatchObject({
    kind: 'response',
    request_id: 'positive-read',
    result: { offset: 0, total: 2, base64: 'AQI=' },
  })
  let started!: () => void, release!: () => void
  const processing = new Promise<void>((resolve) => {
    started = resolve
  })
  const waiting = new Promise<void>((resolve) => {
    release = resolve
  })
  const realRequest = core.request.bind(core)
  vi.spyOn(core, 'request').mockImplementation((actor, method, params, operation) => {
    const result = realRequest(actor, method, params, operation)
    if (method !== 'artifact.read') return result
    // Hold a genuine, authorized DB read at an async processing boundary before publication.
    return (async () => {
      started()
      await waiting
      return result
    })()
  })
  try {
    await request('revoked-read')
    await processing
    core.pairing.revoke(actor.installation_id)
    release()
    expect(await read(channel.transport)).toBeUndefined()
  } finally {
    release()
    await channel.transport.close('test_done')
  }
})
it('revocation after request admission but before the prompt transaction preserves a real pending prompt', async () => {
  const { core, endpoint, open } = setup()
  const keys = new Keys(),
    connector = new PairedWssConnector(keys, open)
  const invite = await core.pairing.issue(endpoint, 'prompt-transaction')
  const claim = await connector.claim(invite)
  core.pairing.confirm(claim.installation_id, claim.device_fingerprint)
  const actor = core.pairing.actor(claim.installation_id, keys.device!.public_key)
  const session = core.request(
    actor,
    'session.create',
    { title: 'prompt-transaction' },
    'create'
  ) as { session_id: string }
  const positive = pendingPermission(core, actor, session.session_id, 'positive-send')
  expect(
    core.request(actor, 'prompt.answer', permissionAnswer(positive), 'positive-answer')
  ).toMatchObject({ state: 'resolved', choice: 'allow', installation_id: actor.installation_id })
  core.tick()
  const pending = pendingPermission(core, actor, session.session_id, 'waiting-send')
  expect(
    core.request(actor, 'prompt.list', { session_id: session.session_id, state: 'pending' })
  ).toContainEqual(pending)
  const before = core.head(session.session_id)
  const commit = core.commitOperation.bind(core)
  let reached = false
  vi.spyOn(core, 'commitOperation').mockImplementation((actor, method, params, operation, work) => {
    if (method === 'prompt.answer') {
      // Request validation/admission has succeeded, but the durable mutation has not begun.
      reached = true
      core.pairing.revoke(actor.installation_id)
    }
    return commit(actor, method, params, operation, work)
  })
  expect(() =>
    core.request(actor, 'prompt.answer', permissionAnswer(pending), 'revoked-during-processing')
  ).toThrow('unauthorized')
  expect(reached).toBe(true)
  expect(core.prompts(session.session_id).find((p) => p.prompt_id === pending.prompt_id)).toEqual(
    pending
  )
  expect(core.head(session.session_id)).toBe(before)
  expect(
    core.db
      .prepare('SELECT 1 FROM operations WHERE principal_id=? AND operation_id=?')
      .get(actor.installation_id, 'revoked-during-processing')
  ).toBeUndefined()
})
it('explicit local migration preserves principal-scoped receipts; revocation fences receipt replay and artifacts', async () => {
  const { core, endpoint } = setup()
  const local = core.createToken('existing')
  const owner = core.authority.authenticate(local.token)
  const operation = 'stable-operation'
  const session = core.request(owner, 'session.create', { title: 'retained' }, operation) as {
    session_id: string
  }
  const device = await generateIdentity()
  const invite = await core.pairing.issue(endpoint, 'migrated', 300000, local.installation_id)
  const claim = await core.pairing.claim(invite, device.public_key)
  expect(claim.installation_id).toBe(local.installation_id)
  core.pairing.confirm(claim.installation_id, claim.device_fingerprint)
  const actor = core.pairing.actor(claim.installation_id, device.public_key)
  expect(core.request(actor, 'session.create', { title: 'retained' }, operation)).toEqual(session)
  const artifact_id = 'artifact'
  core.db
    .prepare('INSERT INTO artifacts VALUES(?,?,?)')
    .run(artifact_id, session.session_id, new Uint8Array([1, 2]))
  const artifactParams = { session_id: session.session_id, artifact_id, offset: 0, length: 1 }
  expect(core.request(actor, 'artifact.read', artifactParams)).toEqual({
    offset: 0,
    total: 2,
    base64: 'AQ==',
  })
  const positivePrompt = pendingPermission(core, actor, session.session_id, 'positive-prompt')
  const answer = permissionAnswer(positivePrompt)
  expect(core.request(actor, 'prompt.answer', answer, 'positive-answer')).toMatchObject({
    state: 'resolved',
    choice: 'allow',
    installation_id: actor.installation_id,
  })
  core.tick()
  const pending = pendingPermission(core, actor, session.session_id, 'revoked-prompt')
  core.pairing.revoke(actor.installation_id)
  expect(() => core.request(actor, 'session.create', { title: 'retained' }, operation)).toThrow(
    'unauthorized'
  )
  expect(() => core.request(actor, 'artifact.read', artifactParams)).toThrow('unauthorized')
  expect(() =>
    core.request(actor, 'prompt.answer', permissionAnswer(pending), 'revoked-answer')
  ).toThrow('unauthorized')
  expect(
    core.prompts(session.session_id).find((p) => p.prompt_id === pending.prompt_id)?.state
  ).toBe('pending')
  expect(
    core.db
      .prepare('SELECT 1 FROM operations WHERE principal_id=? AND operation_id=?')
      .get(actor.installation_id, 'revoked-answer')
  ).toBeUndefined()
  expect(core.request(owner, 'session.create', { title: 'retained' }, operation)).toEqual(session)
  // Recovery must reuse the same principal after explicit node-key rotation and key re-enrollment.
  await core.pairing.identity.rotate()
  const recovery = await core.pairing.issue(endpoint, 'recovery', 300000, local.installation_id)
  const replacement = await generateIdentity()
  const newClaim = await core.pairing.claim(recovery, replacement.public_key)
  core.pairing.confirm(newClaim.installation_id, newClaim.device_fingerprint)
  expect(
    core.request(
      core.pairing.actor(local.installation_id, replacement.public_key),
      'session.create',
      { title: 'retained' },
      operation
    )
  ).toEqual(session)
  expect(() => core.pairing.actor(local.installation_id, device.public_key)).toThrow('unauthorized')
})
