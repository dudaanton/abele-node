import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it } from 'vitest'
import { NodeCore } from '@abele/node-core'
import { RecordQueue } from '@abele/channel-client'
import { FrameCodec, type RecordFrame } from '@abele/channel-protocol'
import { serveChannel } from '../packages/channel-server/src/index.js'

it('keeps a chat approval pending after a client window closes and accepts it on reconnect', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'approval-window-'))
  const core = new NodeCore(dir)
  const incoming = new RecordQueue()
  const actor = core.authority.authenticate(core.createToken('window').token)
  const session = core.request(actor, 'session.create', { title: 'approval' }, 'create') as {
    session_id: string
  }
  core.request(
    actor,
    'session.send',
    {
      session_id: session.session_id,
      text: 'wait',
      observed_seq: 0,
      script: [{ kind: 'permission', ttl_ms: 60000 }],
    },
    'send'
  )
  core.tick()
  const prompt = core.prompts(session.session_id)[0]!
  const server = serveChannel(
    {
      receive: () => incoming,
      send: async () => {},
      close: async () => incoming.end(),
    },
    core,
    actor
  )
  try {
    incoming.push(FrameCodec.encode({ kind: 'hello', version: { major: 0, minor: 0 } }))
    incoming.end()
    await server
    core.tick()
    expect(core.prompt(prompt.prompt_id)).toMatchObject({
      state: 'pending',
      choice: null,
      delivered: false,
    })
    expect(core.read(session.session_id, 0).filter((e) => e.type === 'prompt.resolved')).toEqual([])
    const reconnected = core.authority.forInstallation(actor.installation_id)
    core.request(
      reconnected,
      'prompt.answer',
      {
        session_id: session.session_id,
        prompt_id: prompt.prompt_id,
        run_id: prompt.run_id,
        revision: prompt.revision,
        action_digest: prompt.action_digest,
        choice: 'allow',
      },
      'answer'
    )
    core.tick()
    expect(core.prompt(prompt.prompt_id)).toMatchObject({
      state: 'resolved',
      choice: 'allow',
      delivered: true,
    })
  } finally {
    incoming.end()
    await server
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it('publishes the self-revocation acknowledgement before closing the channel', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'disconnect-channel-'))
  const core = new NodeCore(dir)
  const incoming = new RecordQueue()
  const sent: RecordFrame[] = []
  const actor = core.authority.authenticate(core.createToken('device').token)
  const server = serveChannel(
    {
      receive: () => incoming,
      send: async (bytes) => {
        sent.push(FrameCodec.decode(bytes))
      },
      close: async () => {
        incoming.end()
      },
    },
    core,
    actor
  )
  try {
    incoming.push(FrameCodec.encode({ kind: 'hello', version: { major: 0, minor: 0 } }))
    incoming.push(
      FrameCodec.encode({
        kind: 'request',
        method: 'node.disconnect',
        params: {},
        request_id: 'disconnect',
      })
    )
    await server
    expect(sent).toContainEqual({
      kind: 'response',
      request_id: 'disconnect',
      result: { disconnected: true },
    })
  } finally {
    incoming.end()
    await server
    core.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

it.each(['local-token-v1', 'paired-wss-v1'] as const)(
  'disconnect revokes only the authenticated device and rejects its saved authority (%s)',
  (profile) => {
    const dir = mkdtempSync(join(tmpdir(), 'disconnect-'))
    const core = new NodeCore(dir)
    try {
      const token = core.createToken('device')
      const other = core.createToken('other')
      if (profile === 'paired-wss-v1')
        core.db
          .prepare('INSERT INTO paired_devices VALUES(?,?,?,?)')
          .run(token.installation_id, 'fixture-public-key', 'fixture-fingerprint', 'confirmed')
      const actor =
        profile === 'paired-wss-v1'
          ? { installation_id: token.installation_id, profile, device_key: 'fixture-public-key' }
          : core.authority.authenticate(token.token)
      expect(() =>
        core.request(actor, 'node.disconnect', { installation_id: other.installation_id })
      ).toThrow('invalid_params')
      expect(core.request(actor, 'node.disconnect', {})).toEqual({ disconnected: true })
      expect(() =>
        core.checkPublication(actor, 'node.disconnect', {}, { disconnected: true })
      ).not.toThrow()
      expect(() => core.authority.authenticate(token.token)).toThrow('unauthorized')
      expect(() => core.request(actor, 'node.describe', {})).toThrow('unauthorized')
      expect(core.authority.authenticate(other.token).installation_id).toBe(other.installation_id)
      if (profile === 'paired-wss-v1')
        expect(
          core.db
            .prepare('SELECT state FROM paired_devices WHERE installation_id=?')
            .get(token.installation_id)
        ).toMatchObject({ state: 'revoked' })
    } finally {
      core.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
