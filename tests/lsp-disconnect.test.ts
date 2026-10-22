import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  ChannelError,
  FrameCodec,
  LIMITS,
  type AuthorityContext,
  type RecordFrame,
} from '@abele/channel-protocol'
import type { ResourceServices } from '../packages/node-core/src/resources.js'
import type { NodeCore } from '@abele/node-core'
import { NodeLsp } from '../packages/node-core/src/lsp/node.js'
import { serveChannel } from '../packages/channel-server/src/index.js'
import { RecordQueue } from '../packages/channel-client/src/index.js'

const cleanups: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'lsp-disconnect-'))
  for (const path of ['a.ts', 'b.ts']) writeFileSync(join(root, path), '')
  const lsp = new NodeLsp({
    core: {
      stateDir: root,
      authority: { check: () => {} },
      transaction: (work: () => void) => work(),
      append: () => {},
    },
  } as unknown as ResourceServices)
  vi.spyOn(lsp, 'root').mockReturnValue(root)
  Object.assign((lsp.service as any).options, {
    idleMs: 100,
    trusted: () => true,
    read: () => '',
    check: (base: string, path: string) => join(base, path),
    command: (language: string) =>
      language === 'typescript'
        ? { command: process.execPath, args: [resolve('tests/fixtures/fake-lsp.mjs')] }
        : null,
  })
  cleanups.push(async () => {
    await lsp.stop()
    rmSync(root, { recursive: true, force: true })
  })
  const actor = { installation_id: 'same-installation' } as AuthorityContext
  const open = (connection: AbortController, path = 'a.ts') =>
    lsp.request(
      actor,
      'lsp.v1.open',
      { workspace_id: 'project', path, text: '' },
      connection.signal
    )
  return { root, actor, lsp, open, slots: () => [...(lsp.service as any).slots.values()] as any[] }
}

it('releases all documents on disconnect without explicit closes, then idles out', async () => {
  const { open, slots } = setup()
  const connection = new AbortController()
  await open(connection, 'a.ts')
  await open(connection, 'b.ts')
  connection.abort()
  expect(slots()[0].docs.size).toBe(0)
  expect(slots()).toHaveLength(1)
  await sleep(250)
  expect(slots()).toHaveLength(0)
})

it.each(['socket', 'heartbeat', 'revocation'] as const)(
  'releases ownership through the channel %s cleanup path',
  async (mode) => {
    const { actor, lsp, slots } = setup()
    const incoming = new RecordQueue()
    const sent: RecordFrame[] = []
    let revoked = false
    const core = {
      node_id: 'node',
      authority: {
        check: () => {
          if (revoked) throw new ChannelError('unauthorized')
        },
      },
      capabilities: () => ({ providers: [] }),
      discovery: () => ({}),
      debuggerControl: { methods: () => [] },
      trace: { methods: () => [] },
      http: { methods: () => [] },
      request: (
        context: AuthorityContext,
        method: string,
        raw: unknown,
        _operation: string,
        signal: AbortSignal
      ) => lsp.request(context, method, raw, signal),
      checkPublication: () => {},
    } as unknown as NodeCore
    const closed = vi.fn(async () => {
      incoming.end()
    })
    if (mode === 'heartbeat') vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const server = serveChannel(
      {
        receive: () => incoming,
        send: async (bytes) => {
          sent.push(FrameCodec.decode(bytes))
        },
        close: closed,
      },
      core,
      actor
    )
    cleanups.push(async () => {
      incoming.end()
      await server
    })
    incoming.push(FrameCodec.encode({ kind: 'hello', version: { major: 0, minor: 0 } }))
    incoming.push(
      FrameCodec.encode({
        kind: 'request',
        request_id: 'open',
        method: 'lsp.v1.open',
        params: { workspace_id: 'project', path: 'a.ts', text: '' },
      })
    )
    for (let i = 0; i < 200 && !sent.some((frame) => frame.kind === 'response'); i++)
      await sleep(10)
    expect(sent.find((frame) => frame.kind === 'response')).toMatchObject({
      result: { servers: ['typescript'] },
    })
    expect(slots()[0].docs.size).toBe(1)
    if (mode === 'socket') incoming.end()
    if (mode === 'heartbeat') {
      const now = Date.now()
      vi.spyOn(Date, 'now').mockReturnValue(now + LIMITS.dead_ms + 1)
    }
    if (mode === 'revocation') revoked = true
    if (mode === 'heartbeat') await vi.advanceTimersByTimeAsync(LIMITS.heartbeat_ms)
    await server
    expect(slots()[0].docs.size).toBe(0)
    await sleep(250)
    expect(slots()).toHaveLength(0)
    if (mode === 'heartbeat') expect(closed).toHaveBeenCalledWith('dead_connection')
    if (mode === 'revocation') expect(closed).toHaveBeenCalledWith('publication_failed')
  }
)

it('keeps the other connection alive even when both use the same installation', async () => {
  const { open, slots } = setup()
  const first = new AbortController(),
    second = new AbortController()
  await open(first)
  await open(second)
  expect(slots()[0].docs.get('a.ts').owners.size).toBe(2)
  first.abort()
  await sleep(250)
  expect(slots()).toHaveLength(1)
  expect(slots()[0].docs.get('a.ts').owners.size).toBe(1)
  second.abort()
  expect(slots()[0].docs.size).toBe(0)
  await sleep(250)
  expect(slots()).toHaveLength(0)
})

it('lets a reconnect reopen documents without inheriting the old ownership', async () => {
  const { lsp, actor, open, slots } = setup()
  const first = new AbortController()
  await open(first)
  const process = slots()[0].connection
  first.abort()
  const second = new AbortController()
  await open(second)
  await expect(open(first)).rejects.toMatchObject({ code: 'cancelled' })
  expect(slots()[0].connection).toBe(process)
  expect(slots()[0].docs.get('a.ts').owners.size).toBe(1)
  await lsp.request(actor, 'lsp.v1.close', { workspace_id: 'project', path: 'a.ts' }, second.signal)
  await sleep(250)
  expect(slots()).toHaveLength(0)
})

it('does not resurrect ownership when disconnect interrupts an open', async () => {
  const { open, slots } = setup()
  const connection = new AbortController()
  await open(connection)
  const slot = slots()[0]
  let ready!: () => void
  slot.ready = new Promise<void>((resolve) => {
    ready = resolve
  })
  const pending = open(connection, 'b.ts')
  const rejected = expect(pending).rejects.toMatchObject({ code: 'cancelled' })
  // Let open reach the pending initialization wait before dropping the connection.
  for (let i = 0; i < 10; i++) await Promise.resolve()
  connection.abort()
  ready()
  await rejected
  expect(slot.docs.size).toBe(0)
  await sleep(250)
  expect(slots()).toHaveLength(0)
})

it('releases ownership even when its project directory has disappeared', async () => {
  const { root, open, slots } = setup()
  const connection = new AbortController()
  await open(connection)
  rmSync(root, { recursive: true, force: true })
  connection.abort()
  expect(slots()[0].docs.size).toBe(0)
  await sleep(250)
  expect(slots()).toHaveLength(0)
})

it.each(['open', 'implicit query'] as const)(
  'lets close win over an %s waiting for initialization on the same connection',
  async (operation) => {
    const { lsp, actor, open, slots } = setup()
    const connection = new AbortController()
    let release!: () => void, entered!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const start = (lsp.service as any).start.bind(lsp.service)
    vi.spyOn(lsp.service as any, 'start').mockImplementation(async (...args) => {
      await start(...args)
      entered()
      await gate
    })
    const pending =
      operation === 'open'
        ? open(connection)
        : lsp.request(
            actor,
            'lsp.v1.diagnostics',
            { workspace_id: 'project', path: 'a.ts' },
            connection.signal
          )
    // Observe rejection immediately, while still proving the ownership postcondition below.
    const result = pending.catch((error) => error)
    try {
      await started
      await lsp.request(
        actor,
        'lsp.v1.close',
        { workspace_id: 'project', path: 'a.ts' },
        connection.signal
      )
      release()
      expect(await result).toMatchObject({ code: 'cancelled' })
      expect(slots()[0].docs.size).toBe(0)
      await sleep(250)
      expect(slots()).toHaveLength(0)
    } finally {
      release()
      await result
    }
  }
)

it("allows later opens while cancelling only the closing connection's earlier opens", async () => {
  const { lsp, actor, open, slots } = setup()
  const first = new AbortController(),
    second = new AbortController()
  await open(second)
  const slot = slots()[0]
  let ready!: () => void
  slot.ready = new Promise<void>((resolve) => {
    ready = resolve
  })
  const earlier = open(first, 'b.ts').catch((error) => error)
  const other = open(second, 'b.ts')
  try {
    await lsp.request(
      actor,
      'lsp.v1.close',
      { workspace_id: 'project', path: 'b.ts' },
      first.signal
    )
    const later = open(first, 'b.ts')
    ready()
    expect(await earlier).toMatchObject({ code: 'cancelled' })
    await Promise.all([other, later])
    expect(slot.docs.get('b.ts').owners.size).toBe(2)
    first.abort()
    expect(slot.docs.get('b.ts').owners.size).toBe(1)
    second.abort()
    await sleep(250)
    expect(slots()).toHaveLength(0)
  } finally {
    ready()
    await Promise.allSettled([earlier, other])
  }
})

it.each(['cold', 'already open'] as const)(
  'acquires implicit query ownership independently of whether the document is %s',
  async (state) => {
    const { lsp, actor, open, slots } = setup()
    const first = new AbortController(),
      second = new AbortController()
    if (state === 'already open') await open(first)
    await lsp.request(
      actor,
      'lsp.v1.diagnostics',
      { workspace_id: 'project', path: 'a.ts' },
      second.signal
    )
    first.abort()
    await sleep(250)
    expect(slots()).toHaveLength(1)
    expect(slots()[0].docs.get('a.ts').owners.size).toBe(1)
    second.abort()
    await sleep(250)
    expect(slots()).toHaveLength(0)
  }
)
