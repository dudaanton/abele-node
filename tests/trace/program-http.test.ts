import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { afterEach, expect, it } from 'vitest'
import {
  installProgramHttp,
  programHttpInstall,
  programHttpStop,
  programHttpDrain,
} from '../../packages/node-core/src/trace/program-http.js'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'
import { channel } from 'node:diagnostics_channel'
import { Session } from 'node:inspector'

let stop: (() => void) | undefined
afterEach(() => stop?.())

it('installs and drains the serialized hook over a real inspector channel', async () => {
  const session = new Session()
  session.connect()
  const evaluate = (expression: string) =>
    new Promise<any>((resolve, reject) => {
      session.post('Runtime.evaluate', { expression, returnByValue: true }, (error, result) => {
        if (error || result.exceptionDetails)
          reject(error ?? new Error(result.exceptionDetails?.text))
        else resolve(result.result.value)
      })
    })
  const server = createServer((_req, res) => res.end('inspector-body')).listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    expect(await evaluate(programHttpInstall)).toBe('ok')
    const response = await fetch(
      `http://127.0.0.1:${(server.address() as { port: number }).port}/inspector`
    )
    expect(await response.text()).toBe('inspector-body')
    await new Promise((r) => setTimeout(r, 30))
    const events = []
    for (;;) {
      const batch = JSON.parse(
        Buffer.from(await evaluate(programHttpDrain), 'base64').toString('utf8')
      )
      if (!batch.length) break
      events.push(...batch)
    }
    expect(events.map((e) => e.direction).sort()).toEqual(['incoming', 'outgoing'])
    expect(events.every((e) => e.response_body === 'inspector-body')).toBe(true)
  } finally {
    await evaluate(programHttpStop)
    session.disconnect()
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

const drainAll = (capture: ReturnType<typeof installProgramHttp>) => {
  const events = []
  for (;;) {
    const batch = capture.drain()
    if (!batch.length) return events
    events.push(...batch)
  }
}

it('captures direct undici requests, including streamed request and response chunks', async () => {
  // Exercise the direct client already pinned by our pi dependency, without a live provider.
  const undici = createRequire(
    new URL('../../node_modules/@earendil-works/pi-coding-agent/package.json', import.meta.url)
  )('undici')
  const capture = installProgramHttp()
  stop = capture.stop
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    res.end(`received:${body}`)
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const response = await undici.request(
      `http://127.0.0.1:${(server.address() as { port: number }).port}/direct`,
      {
        method: 'POST',
        body: (async function* () {
          yield 'one'
          yield 'two'
        })(),
      }
    )
    expect(await response.body.text()).toBe('received:onetwo')
    const outgoing = drainAll(capture).find((e) => e.direction === 'outgoing')
    expect(outgoing).toMatchObject({
      request_body: 'onetwo',
      response_body: 'received:onetwo',
      status: 200,
    })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

it('serializes into a debuggee with no Abele dependencies and uninstalls', () => {
  const sandbox = { process, Buffer, URL, Request, Headers, fetch, setInterval, clearInterval }
  expect(runInNewContext(programHttpInstall, sandbox)).toBe('ok')
  expect(runInNewContext(programHttpStop, sandbox)).toBe('ok')
})

it('flushes unfinished requests on stop and bounds worst-case escaped payloads below a DAP frame', () => {
  const capture = installProgramHttp()
  stop = capture.stop
  const req = {
    method: 'POST',
    origin: 'http://localhost',
    path: '/api?token=private-query',
    headers: 'authorization: private-header\r\n',
  }
  channel('undici:request:create').publish({ request: req })
  channel('undici:request:bodyChunkSent').publish({ request: req, chunk: Buffer.alloc(100_000, 0) })
  channel('undici:request:bodyChunkReceived').publish({
    request: req,
    chunk: Buffer.alloc(100_000, 0),
  })
  capture.stop()
  const events = drainAll(capture)
  expect(events).toHaveLength(1)
  expect(events[0]).toMatchObject({
    error: 'Recording ended',
    request_truncated: true,
    response_truncated: true,
  })
  const serialized = JSON.stringify(events)
  expect(serialized).not.toContain('private-query')
  expect(serialized).not.toContain('private-header')
  expect(Buffer.byteLength(Buffer.from(serialized).toString('base64'))).toBeLessThan(
    1024 * 1024 - 1024
  )
})

it('redacts secret values without rewriting event keys or direction enums', () => {
  const capture = installProgramHttp()
  stop = capture.stop
  const req = {
    method: 'POST',
    origin: 'http://localhost',
    path: '/',
    headers: 'authorization: incoming\r\ncookie: id\r\n',
  }
  channel('undici:request:create').publish({ request: req })
  channel('undici:request:bodyChunkReceived').publish({
    request: req,
    chunk: Buffer.from('incoming id'),
  })
  channel('undici:request:trailers').publish({ request: req })
  expect(capture.drain()[0]).toMatchObject({
    id: 'n1',
    direction: 'outgoing',
    response_body: '•••• ••••',
  })
})

it('keeps byte bounds after replacing short secrets with the mask', () => {
  const capture = installProgramHttp()
  stop = capture.stop
  const req = { method: 'GET', origin: 'http://localhost', path: '/', headers: 'cookie: a\r\n' }
  channel('undici:request:create').publish({ request: req })
  channel('undici:request:bodyChunkReceived').publish({
    request: req,
    chunk: Buffer.from('a'.repeat(8000)),
  })
  channel('undici:request:trailers').publish({ request: req })
  const event = capture.drain()[0]!
  expect(Buffer.byteLength(event.response_body)).toBeLessThanOrEqual(32768)
  expect(event.response_truncated).toBe(true)
})

it('captures incoming, http client and fetch traffic without consuming application bodies', async () => {
  const capture = installProgramHttp()
  stop = capture.stop
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    res.setHeader('set-cookie', 'private-response')
    res.end(`answer:${body}`)
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/test`
  try {
    const result = await new Promise<string>((resolve, reject) => {
      const req = request(
        url,
        { method: 'POST', headers: { authorization: 'private-token' } },
        (res) => {
          let body = ''
          res.on('data', (chunk) => {
            body += chunk
          })
          res.on('end', () => resolve(body))
        }
      )
      req.on('error', reject)
      req.end('hello')
    })
    expect(result).toBe('answer:hello')
    const response = await fetch(url, { method: 'POST', body: 'fetch-body' })
    expect(await response.text()).toBe('answer:fetch-body')
    await new Promise((r) => setTimeout(r, 50))
    const events = drainAll(capture)
    expect(events.filter((e) => e.direction === 'incoming')).toHaveLength(2)
    expect(events.filter((e) => e.direction === 'outgoing')).toHaveLength(2)
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'POST',
          status: 200,
          request_body: 'hello',
          response_body: 'answer:hello',
        }),
        expect.objectContaining({
          method: 'POST',
          status: 200,
          response_body: 'answer:fetch-body',
        }),
      ])
    )
    expect(JSON.stringify(events)).not.toContain('private-token')
    expect(JSON.stringify(events)).not.toContain('private-response')
    expect(events.every((e) => e.ended >= e.started)).toBe(true)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

it('bounds bodies and removes hooks on stop', async () => {
  const original = fetch
  const capture = installProgramHttp()
  stop = capture.stop
  const server = createServer((_req, res) => res.end('x'.repeat(200_000))).listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const response = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}`)
    expect((await response.text()).length).toBe(200_000)
    await new Promise((r) => setTimeout(r, 50))
    const events = drainAll(capture)
    expect(events.length).toBe(2)
    expect(events.every((e) => Buffer.byteLength(e.response_body) <= 65536)).toBe(true)
    expect(events.every((e) => e.response_truncated)).toBe(true)
    capture.stop()
    expect(fetch).toBe(original)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

it('captures a fetch Request upload without consuming its application body', async () => {
  const capture = installProgramHttp()
  stop = capture.stop
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    res.end(body)
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const response = await fetch(
      new Request(`http://127.0.0.1:${(server.address() as { port: number }).port}/request`, {
        method: 'POST',
        body: 'request-upload',
      })
    )
    expect(await response.text()).toBe('request-upload')
    await new Promise((r) => setTimeout(r, 30))
    expect(drainAll(capture).find((e) => e.direction === 'outgoing')).toMatchObject({
      request_body: 'request-upload',
      response_body: 'request-upload',
    })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
})

it('captures http uploads written after the diagnostic request-start notification', async () => {
  const capture = installProgramHttp()
  stop = capture.stop
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    res.end(body)
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const response = new Promise<string>((resolve, reject) => {
      const req = request(
        `http://127.0.0.1:${(server.address() as { port: number }).port}/stream`,
        { method: 'POST' },
        (res) => {
          let text = ''
          res.on('data', (chunk) => {
            text += chunk
          })
          res.on('end', () => resolve(text))
        }
      )
      req.on('error', reject)
      req.flushHeaders()
      req.write('one')
      setTimeout(() => {
        req.write('two')
        req.end('three')
      }, 10)
    })
    expect(await response).toBe('onetwothree')
    expect(drainAll(capture).find((e) => e.direction === 'outgoing')).toMatchObject({
      request_body: 'onetwothree',
    })
  } finally {
    server.closeAllConnections()
    await new Promise<void>((r) => server.close(() => r()))
  }
})
