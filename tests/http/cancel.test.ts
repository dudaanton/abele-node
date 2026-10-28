import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import type { AuthorityContext } from '@abele/channel-protocol'
import type { NodeCore } from '../../packages/node-core/src/index.js'
import { HttpService } from '../../packages/node-core/src/http/service.js'
import { HttpSendStatusSchema } from '../../packages/node-protocol/src/http.js'

const dirs: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function fixture(trace?: unknown) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'http-cancel-')))
  dirs.push(root)
  const check = vi.fn()
  const service = new HttpService({
    authority: { check },
    debugger: { enabled: true },
    trace,
    db: { prepare: () => ({ get: () => ({ root_path: root }) }) },
  } as unknown as NodeCore)
  const actor = {} as AuthorityContext
  const request = (method: string, params: object) =>
    service.request(actor, method, { project_id: 'project', ...params }) as any
  return { service, request, check }
}
it('aborts a send by id, preserves uncertain delivery in status/history, and never resends', async () => {
  let signal!: AbortSignal
  const fetch = vi.fn(
    (_url: string, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        signal = options.signal!
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
  )
  vi.stubGlobal('fetch', fetch)
  const { service, request, check } = fixture()
  const { send_id } = request('http.v1.send', {
    request_id: 'Orders/Create.http',
    method: 'POST',
    url: 'https://service.invalid/orders',
    headers: [],
    secrets: [],
    body: '{}',
  })
  try {
    const result = await request('http.v1.send.cancel', { send_id })
    expect(signal.aborted).toBe(true)
    expect(HttpSendStatusSchema.parse(result).outcome.state).toBe('unknown')
    expect(result.outcome.reason).toContain('Stopped')
    expect(await request('http.v1.send.cancel', { send_id })).toEqual(result)
    await service.settled()
    expect(request('http.v1.send.status', { send_id }).outcome.state).toBe('unknown')
    expect(request('http.v1.history', { id: 'Orders/Create.http' }).sends[0].unknown).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(check).toHaveBeenCalled()
  } finally {
    service.close()
    await service.settled()
  }
})
it('checks authority and project ownership before aborting and keeps completed answers', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('ok'))
  )
  const { service, request, check } = fixture()
  const { send_id } = request('http.v1.send', {
    method: 'GET',
    url: 'https://service.invalid/',
    headers: [],
    secrets: [],
  })
  await service.settled()
  check.mockImplementationOnce(() => {
    throw new Error('denied')
  })
  expect(() => request('http.v1.send.cancel', { send_id })).toThrow('denied')
  await expect(request('http.v1.send.cancel', { project_id: 'other', send_id })).rejects.toThrow(
    'http_send_not_found'
  )
  expect((await request('http.v1.send.cancel', { send_id })).outcome.state).toBe('answered')
  service.close()
})

it('cancels a partially read response without reporting a complete answer', async () => {
  let receiving!: () => void
  const started = new Promise<void>((resolve) => {
    receiving = resolve
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, options: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('partial'))
          options.signal!.addEventListener(
            'abort',
            () => controller.error(options.signal!.reason),
            { once: true }
          )
          receiving()
        },
      })
      return new Response(stream)
    })
  )
  const { service, request } = fixture()
  const { send_id } = request('http.v1.send', {
    method: 'GET',
    url: 'https://service.invalid/',
    headers: [],
    secrets: [],
  })
  await started
  try {
    const result = await request('http.v1.send.cancel', { send_id })
    expect(result.outcome.state).toBe('unknown')
    expect(result.outcome.reason).toContain('Stopped')
  } finally {
    service.close()
    await service.settled()
  }
})

it('returns cancellation while the debugger recording flush is still pending', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_url: string, options: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          options.signal!.addEventListener('abort', () => reject(options.signal!.reason), {
            once: true,
          })
        })
    )
  )
  let release!: () => void
  const flush = new Promise<void>((resolve) => {
    release = resolve
  })
  const { service, request } = fixture({
    recorder: {
      chain: () => ({ id: 'chain', runId: 'run', close: () => undefined }),
      flushHttp: () => flush,
    },
  })
  const { send_id } = request('http.v1.send', {
    debug_session_id: 'session',
    method: 'POST',
    url: 'https://service.invalid/',
    headers: [],
    secrets: [],
  })
  try {
    const result = await request('http.v1.send.cancel', { send_id })
    expect(result.outcome.state).toBe('unknown')
    expect(request('http.v1.send.status', { send_id }).outcome.state).toBe('unknown')
  } finally {
    release()
    service.close()
    await service.settled()
  }
})
