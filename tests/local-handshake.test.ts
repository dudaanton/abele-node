import { expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { NodeCore } from '@abele/node-core'
import { LocalChannelConnector, RecordQueue, RequestChannel } from '@abele/channel-client'
import { serveChannel } from '../packages/channel-server/src/index.js'
import {
  FrameCodec,
  LIMITS,
  localTokenHash,
  localSelector,
  localBootstrapMac,
  localTranscript,
  signProof,
  generateIdentity,
  verifyLocalBootstrap,
  type LocalChallenge,
  type RecordFrame,
  type RecordTransport,
} from '@abele/channel-protocol'

function fixture(
  core: NodeCore,
  transform: (frame: RecordFrame) => Promise<RecordFrame> = async (f) => f
) {
  const incoming = new RecordQueue(),
    outgoing = new RecordQueue()
  const sent: RecordFrame[] = [],
    received: RecordFrame[] = []
  const close = async () => {
    incoming.end()
    outgoing.end()
  }
  const server = serveChannel(
    {
      receive: () => incoming,
      close,
      send: async (bytes) => {
        const frame = await transform(FrameCodec.decode(bytes))
        received.push(frame)
        outgoing.push(FrameCodec.encode(frame))
      },
    },
    core
  )
  const transport: RecordTransport = {
    receive: () => outgoing,
    send: async (bytes) => {
      sent.push(FrameCodec.decode(bytes))
      incoming.push(bytes)
    },
    close,
  }
  return {
    connector: new LocalChannelConnector(async () => transport),
    transport,
    server,
    sent,
    received,
    close,
  }
}
const target = (token: string, node: string) => ({
  url: 'ws://127.0.0.1:7777/channel',
  profile: 'local-token-v1' as const,
  token,
  expected_node_id: node,
})

it('upgrades an existing token database without a new installation and reconnects after restart', async () => {
  const dir = mkdtempSync(resolve('.scratch/local-upgrade-'))
  let core = new NodeCore(dir)
  const token = core.createToken('sample-device'),
    node = core.node_id
  let receipt: unknown
  // Same on-disk schema/token_hash as an auth-first daemon; no pin or remote enable.
  core.close()
  try {
    for (let restart = 0; restart < 2; restart++) {
      core = new NodeCore(dir)
      const f = fixture(core)
      try {
        const admitted = await f.connector.connect(target(token.token, node))
        expect(admitted.authority.installation_id).toBe(token.installation_id)
        expect(admitted.welcome.node_id).toBe(node)
        expect(f.sent.map((frame) => frame.kind)).toEqual(['local.begin', 'auth', 'hello'])
        const beginWire = JSON.stringify(f.sent[0])
        expect(beginWire).not.toContain(token.token)
        expect(beginWire).not.toContain(await localTokenHash(token.token))
        const requests = new RequestChannel(admitted)
        requests.start()
        const result = await requests.request('node.describe', {})
        expect(result).toHaveProperty('node_id', node)
        const created = await requests.request(
          'session.create',
          { title: 'retained-receipt' },
          'local-upgrade-operation'
        )
        if (restart === 0) receipt = created
        else expect(created).toEqual(receipt)
        await requests.close()
      } finally {
        await f.close()
        await f.server
        core.close()
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each([
  'mac',
  'signature',
  'nonce',
  'node',
  'selector',
  'key',
  'installation',
  'expiry',
  'signed-key',
  'bad-signature-with-valid-mac',
])('rejects modified %s before disclosing credentials', async (attack) => {
  const dir = mkdtempSync(resolve('.scratch/local-proof-')),
    core = new NodeCore(dir)
  const token = core.createToken('sample-device')
  const f = fixture(core, async (frame) => {
    if (frame.kind !== 'local.challenge') return frame
    const c = { ...frame }
    if (attack === 'mac') c.mac = '0'.repeat(64)
    if (attack === 'signature') c.signature = 'A'.repeat(86)
    if (attack === 'nonce') c.client_nonce = '0'.repeat(64)
    if (attack === 'node') c.node_id = 'impostor'
    if (attack === 'selector') c.selector = '0'.repeat(64)
    if (attack === 'key' || attack === 'signed-key') {
      const other = await generateIdentity()
      c.node_key = other.public_key
      if (attack === 'signed-key')
        c.signature = await signProof(other.private_key, await localTranscript(c))
    }
    if (attack === 'installation') c.installation_id = 'other-installation'
    if (attack === 'expiry') c.expires_at++
    if (attack === 'bad-signature-with-valid-mac') {
      c.signature = 'A'.repeat(86)
      c.mac = await localBootstrapMac(await localTokenHash(token.token), c)
    }
    return c
  })
  try {
    await expect(f.connector.connect(target(token.token, core.node_id))).rejects.toThrow(
      'node_identity_mismatch'
    )
    expect(f.sent.map((frame) => frame.kind)).toEqual(['local.begin'])
    expect(JSON.stringify(f.sent)).not.toContain(token.token)
  } finally {
    await f.close()
    await f.server
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('does not send a token when successful crypto completes after the monotonic deadline', async () => {
  const dir = mkdtempSync(resolve('.scratch/local-late-')),
    core = new NodeCore(dir)
  const token = core.createToken('sample-device'),
    f = fixture(core)
  const original = crypto.subtle.verify.bind(crypto.subtle)
  let release: () => void = () => {},
    started: () => void = () => {},
    late = false
  const verifying = new Promise<void>((resolve) => {
    started = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const clock = vi
    .spyOn(performance, 'now')
    .mockImplementation(() => (late ? LIMITS.auth_ms + 1 : 0))
  const verify = vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
    const result = await original(...args)
    if (typeof args[0] === 'object' && args[0].name === 'ECDSA') {
      started()
      await gate
    }
    return result
  })
  try {
    const attempt = f.connector.connect(target(token.token, core.node_id))
    const rejected = expect(attempt).rejects.toThrow('connection_timeout')
    await verifying
    late = true
    release()
    await rejected
    expect(f.sent.map((frame) => frame.kind)).toEqual(['local.begin'])
  } finally {
    release()
    verify.mockRestore()
    clock.mockRestore()
    await f.close()
    await f.server
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('rejects auth-first and binds the token to the challenged installation, rechecking revocation', async () => {
  const dir = mkdtempSync(resolve('.scratch/local-authority-')),
    core = new NodeCore(dir)
  const first = core.createToken('first'),
    second = core.createToken('second')
  try {
    const legacy = fixture(core)
    await legacy.transport.send(
      FrameCodec.encode({ kind: 'auth', profile: 'local-token-v1', token: first.token })
    )
    await legacy.server
    expect(legacy.received).toEqual([])
    for (const revoke of [false, true]) {
      const credential = revoke ? core.createToken('revoked') : first
      const f = fixture(core)
      await f.transport.send(
        FrameCodec.encode({
          kind: 'local.begin',
          profile: 'local-proof-v1',
          client_nonce: '1'.repeat(64),
          selector: await localSelector(await localTokenHash(credential.token)),
        })
      )
      const row = await f.transport.receive()[Symbol.asyncIterator]().next()
      expect(FrameCodec.decode(row.value!).kind).toBe('local.challenge')
      if (revoke) core.revokeToken(credential.installation_id)
      await f.transport.send(
        FrameCodec.encode({
          kind: 'auth',
          profile: 'local-token-v1',
          token: revoke ? credential.token : second.token,
        })
      )
      await f.server
      expect(f.received.map((frame) => frame.kind)).toEqual(['local.challenge'])
    }
  } finally {
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('rejects a recorded proof on a fresh connection even for the same node and token', async () => {
  const dir = mkdtempSync(resolve('.scratch/local-replay-')),
    core = new NodeCore(dir)
  const token = core.createToken('sample-device')
  let recorded: LocalChallenge | undefined
  const first = fixture(core, async (f) => {
    if (f.kind === 'local.challenge') recorded = f
    return f
  })
  try {
    await first.connector.connect(target(token.token, core.node_id))
    await first.close()
    await first.server
    const replay = fixture(core, async (f) => (f.kind === 'local.challenge' ? recorded! : f))
    try {
      await expect(replay.connector.connect(target(token.token, core.node_id))).rejects.toThrow(
        'node_identity_mismatch'
      )
      expect(replay.sent.map((f) => f.kind)).toEqual(['local.begin'])
      const hash = await localTokenHash(token.token)
      expect(await verifyLocalBootstrap(hash, recorded!)).toBe(true)
    } finally {
      await replay.close()
      await replay.server
    }
  } finally {
    await first.close()
    await first.server
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('does not let paired-only installations prevent a local proof', async () => {
  const dir = mkdtempSync(resolve('.scratch/local-mixed-')),
    core = new NodeCore(dir)
  core.db
    .prepare('INSERT INTO installations(installation_id,label,token_hash) VALUES(?,?,?)')
    .run('paired-only', 'paired', 'paired:' + '0'.repeat(64))
  const token = core.createToken('local'),
    f = fixture(core)
  try {
    const admitted = await f.connector.connect(target(token.token, core.node_id))
    expect(admitted.authority.installation_id).toBe(token.installation_id)
  } finally {
    await f.close()
    await f.server
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('rejects a token if the node identity rotates after the challenge', async () => {
  const dir = mkdtempSync(resolve('.scratch/local-rotation-')),
    core = new NodeCore(dir)
  const token = core.createToken('local'),
    f = fixture(core)
  try {
    await f.transport.send(
      FrameCodec.encode({
        kind: 'local.begin',
        profile: 'local-proof-v1',
        client_nonce: '1'.repeat(64),
        selector: await localSelector(await localTokenHash(token.token)),
      })
    )
    const row = await f.transport.receive()[Symbol.asyncIterator]().next()
    expect(FrameCodec.decode(row.value!).kind).toBe('local.challenge')
    await core.pairing.identity.rotate()
    await f.transport.send(
      FrameCodec.encode({ kind: 'auth', profile: 'local-token-v1', token: token.token })
    )
    await f.server
    expect(f.received.map((frame) => frame.kind)).toEqual(['local.challenge'])
  } finally {
    await f.close()
    await f.server
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each(['profile', 'extra', 'nonce', 'oversized'])(
  'rejects malformed %s admission without publishing a proof',
  async (attack) => {
    const dir = mkdtempSync(resolve('.scratch/local-malformed-')),
      core = new NodeCore(dir)
    const token = core.createToken('local')
    try {
      const begin: Record<string, unknown> = {
        kind: 'local.begin',
        profile: 'local-proof-v1',
        client_nonce: '1'.repeat(64),
        selector: await localSelector(await localTokenHash(token.token)),
      }
      if (attack === 'profile') begin.profile = 'local-token-v1'
      if (attack === 'extra') begin.token = token.token
      if (attack === 'nonce') begin.client_nonce = '1'.repeat(63)
      if (attack === 'oversized') begin.padding = 'x'.repeat(LIMITS.auth_bytes)
      // Deliberately bypass encode validation to exercise the untrusted boundary.
      const raw = new RecordQueue(),
        published: RecordFrame[] = []
      const server = serveChannel(
        {
          receive: () => raw,
          send: async (bytes) => {
            published.push(FrameCodec.decode(bytes))
          },
          close: async () => {
            raw.end()
          },
        },
        core
      )
      raw.push(new TextEncoder().encode(JSON.stringify(begin)))
      await server
      expect(published).toEqual([])
    } finally {
      core.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)

it('preserves already-authenticated paired admission without a local bootstrap', async () => {
  const dir = mkdtempSync(resolve('.scratch/local-paired-path-')),
    core = new NodeCore(dir)
  const token = core.createToken('paired-path-fixture')
  const incoming = new RecordQueue(),
    frames: RecordFrame[] = []
  const server = serveChannel(
    {
      receive: () => incoming,
      send: async (bytes) => {
        frames.push(FrameCodec.decode(bytes))
        incoming.end()
      },
      close: async () => {
        incoming.end()
      },
    },
    core,
    core.authority.authenticate(token.token)
  )
  try {
    incoming.push(FrameCodec.encode({ kind: 'hello', version: { major: 0, minor: 0 } }))
    await server
    expect(frames.map((f) => f.kind)).toEqual(['welcome'])
  } finally {
    incoming.end()
    await server
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('authenticates first enrollment without a previously stored node ID', async () => {
  const dir = mkdtempSync(resolve('.scratch/local-first-')),
    core = new NodeCore(dir)
  const token = core.createToken('first'),
    f = fixture(core)
  try {
    const admitted = await f.connector.connect({
      url: 'ws://127.0.0.1:7777/channel',
      profile: 'local-token-v1',
      token: token.token,
    })
    expect(admitted.welcome.node_id).toBe(core.node_id)
    expect(admitted.authority.installation_id).toBe(token.installation_id)
  } finally {
    await f.close()
    await f.server
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('does not send credentials after the timeout fires during proof verification', async () => {
  const dir = mkdtempSync(resolve('.scratch/local-cancel-')),
    core = new NodeCore(dir)
  const token = core.createToken('local'),
    f = fixture(core)
  const original = crypto.subtle.verify.bind(crypto.subtle)
  let release: () => void = () => {},
    started: () => void = () => {}
  const verifying = new Promise<void>((resolve) => {
    started = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const verify = vi.spyOn(crypto.subtle, 'verify').mockImplementation(async (...args) => {
    const result = await original(...args)
    if (typeof args[0] === 'object' && args[0].name === 'ECDSA') {
      started()
      await gate
    }
    return result
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  try {
    const rejected = expect(f.connector.connect(target(token.token, core.node_id))).rejects.toThrow(
      'connection_timeout'
    )
    await verifying
    await vi.advanceTimersByTimeAsync(LIMITS.auth_ms)
    await rejected
    release()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.sent.map((frame) => frame.kind)).toEqual(['local.begin'])
  } finally {
    release()
    verify.mockRestore()
    vi.useRealTimers()
    await f.close()
    await f.server
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('does not publish a challenge if signing completes after server admission times out', async () => {
  const dir = mkdtempSync(resolve('.scratch/local-server-late-')),
    core = new NodeCore(dir)
  const token = core.createToken('local')
  const original = crypto.subtle.sign.bind(crypto.subtle)
  let release: () => void = () => {},
    started: () => void = () => {}
  const signing = new Promise<void>((resolve) => {
    started = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const sign = vi.spyOn(crypto.subtle, 'sign').mockImplementation(async (...args) => {
    const result = await original(...args)
    if (typeof args[0] === 'object' && args[0].name === 'ECDSA') {
      started()
      await gate
    }
    return result
  })
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const f = fixture(core)
  try {
    await f.transport.send(
      FrameCodec.encode({
        kind: 'local.begin',
        profile: 'local-proof-v1',
        client_nonce: '1'.repeat(64),
        selector: await localSelector(await localTokenHash(token.token)),
      })
    )
    await signing
    await vi.advanceTimersByTimeAsync(LIMITS.auth_ms)
    release()
    await f.server
    expect(f.received).toEqual([])
  } finally {
    release()
    sign.mockRestore()
    vi.useRealTimers()
    await f.close()
    await f.server
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
