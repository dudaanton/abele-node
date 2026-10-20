import { spawnSync } from 'node:child_process'
import { createServer, type Server, type IncomingMessage } from 'node:http'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DapDebuggerBackend, NodeCore } from '../../packages/node-core/src/index.js'
import { DapSession } from '../../packages/node-core/src/debugger/driver.js'
import { HttpSendStatusSchema } from '../../packages/node-protocol/src/http.js'
import { wire } from '../debugger/dap-wire.js'
import { target } from '../debugger/helpers.js'
import { adapter } from '../trace/adapter.js'
import {
  programHttpKey,
  type ProgramHttpEvent,
} from '../../packages/node-core/src/trace/program-http.js'

const dirs: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function setup(enabled = false) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'http-service-')))
  dirs.push(dir)
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  spawnSync('/usr/bin/git', ['init', '-q', '-b', 'main'], { cwd: repo })
  const core = new NodeCore(join(dir, 'state'), { debuggerEnabled: enabled })
  const actor = core.authority.authenticate(core.createToken('test').token)
  const request = (method: string, p: unknown) =>
    core.request(actor, method, p, crypto.randomUUID()) as any
  const project = (await request('project.register', { path: repo, trust: 'trusted' })) as {
    project_id: string
  }
  return { dir, repo, core, request, project_id: project.project_id }
}

/** A small service to send to: it echoes what came, answers slowly or never when asked. */
async function service(onRequest?: (request: IncomingMessage) => void) {
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      onRequest?.(req)
      if (req.url?.startsWith('/never')) return
      const answer = () => {
        res.writeHead(req.url?.startsWith('/missing') ? 404 : 201, {
          'content-type': 'application/json',
          'x-echo-auth': String(req.headers.authorization ?? ''),
        })
        res.end(
          JSON.stringify({
            method: req.method,
            url: req.url,
            body,
            auth: req.headers.authorization ?? null,
            step: req.headers['x-abele-step'] ?? null,
          })
        )
      }
      if (req.url?.startsWith('/slow')) setTimeout(answer, 150)
      else answer()
    })
  })
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return `http://127.0.0.1:${port}`
}

async function until<T>(read: () => T, ok: (v: T) => boolean, tries = 400): Promise<T> {
  let v = read()
  for (let i = 0; i < tries && !ok(v); i++) {
    await new Promise((r) => setTimeout(r, 10))
    v = read()
  }
  return v
}

const doc = (over: Record<string, unknown> = {}) => ({
  name: 'Create order',
  method: 'POST',
  url: '{{base}}/orders',
  params: [],
  headers: [{ key: 'Authorization', value: 'Bearer ${abele_key:shop}' }],
  body: { format: 'json', text: '{"qty":2}' },
  scripts: {},
  checks: ['status == 201'],
  ...over,
})

describe('saved requests on the node', () => {
  it('is offered on every node and refuses what it does not know', async () => {
    const s = await setup()
    try {
      expect(s.core.capabilities().capabilities).toHaveProperty('http_v1')
      expect(() => s.request('http.v1.nothing', { project_id: s.project_id })).toThrow(
        /unsupported_method/
      )
      expect(() =>
        s.request('http.v1.request.get', { project_id: s.project_id, id: '../escape.http' })
      ).toThrow(/invalid_params/)
      expect(() =>
        s.request('http.v1.request.get', { project_id: s.project_id, id: 'Orders/none.http' })
      ).toThrow(/http_request_not_found/)
      expect(() => s.request('http.v1.list', { project_id: 'no-such-project' })).toThrow(
        /not_found/
      )
      expect(s.request('http.v1.list', { project_id: s.project_id })).toEqual({
        folder: join(s.repo, '.abele/requests'),
        collections: [],
        environments: [],
      })
    } finally {
      s.core.close()
    }
  })

  it('keeps requests as files in collections, renames and deletes them', async () => {
    const s = await setup()
    try {
      const p = { project_id: s.project_id }
      s.request('http.v1.collection.create', { ...p, name: 'Orders' })
      s.request('http.v1.request.save', {
        ...p,
        id: 'Orders/Create order.http',
        request: doc(),
        create: true,
      })
      expect(() =>
        s.request('http.v1.request.save', {
          ...p,
          id: 'Orders/Create order.http',
          request: doc(),
          create: true,
        })
      ).toThrow(/http_request_exists/)
      const file = join(s.repo, '.abele/requests/Orders/Create order.http')
      expect(readFileSync(file, 'utf8')).toContain('POST {{base}}/orders\n')
      expect(readFileSync(join(s.repo, '.abele/requests/.gitignore'), 'utf8')).toContain(
        '.history/'
      )
      expect(s.request('http.v1.list', p).collections).toEqual([
        {
          name: 'Orders',
          requests: [
            {
              id: 'Orders/Create order.http',
              name: 'Create order',
              method: 'POST',
              url: '{{base}}/orders',
            },
          ],
        },
      ])
      expect(s.request('http.v1.request.get', { ...p, id: 'Orders/Create order.http' })).toEqual({
        id: 'Orders/Create order.http',
        request: doc(),
      })
      s.request('http.v1.request.save', {
        ...p,
        id: 'Orders/Place order.http',
        from: 'Orders/Create order.http',
        request: doc({ name: 'Place order' }),
      })
      expect(existsSync(file)).toBe(false)
      expect(s.request('http.v1.list', p).collections[0].requests[0].name).toBe('Place order')
      s.request('http.v1.request.delete', { ...p, id: 'Orders/Place order.http' })
      expect(s.request('http.v1.list', p).collections).toEqual([{ name: 'Orders', requests: [] }])
    } finally {
      s.core.close()
    }
  })

  it('writes environments without their secrets and keeps local values local', async () => {
    const s = await setup()
    try {
      const p = { project_id: s.project_id }
      s.request('http.v1.env.save', {
        ...p,
        environment: {
          name: 'local',
          vars: [
            { key: 'base', value: 'http://localhost:4000' },
            { key: 'token', value: 'should-not-be-written', secret: true },
          ],
          step_header: true,
        },
      })
      const file = join(s.repo, '.abele/requests/env/local.json')
      expect(readFileSync(file, 'utf8')).not.toContain('should-not-be-written')
      expect(s.request('http.v1.env.get', { ...p, name: 'local' })).toEqual({
        name: 'local',
        vars: [
          { key: 'base', value: 'http://localhost:4000' },
          { key: 'token', secret: true },
        ],
        step_header: true,
      })
      // A value kept in the local file wins and stays there when the environment is saved again.
      writeFileSync(
        join(s.repo, '.abele/requests/env/local.local.json'),
        JSON.stringify({ vars: [{ key: 'base', value: 'http://127.0.0.1:9' }] })
      )
      const env = s.request('http.v1.env.get', { ...p, name: 'local' })
      expect(env.vars[0]).toEqual({ key: 'base', value: 'http://127.0.0.1:9' })
      expect(env.local).toEqual(['base'])
      s.request('http.v1.env.save', {
        ...p,
        environment: { name: 'local', vars: [{ key: 'base', value: 'http://127.0.0.1:10' }] },
      })
      expect(readFileSync(file, 'utf8')).not.toContain('127.0.0.1')
      expect(readFileSync(join(s.repo, '.abele/requests/env/local.local.json'), 'utf8')).toContain(
        '127.0.0.1:10'
      )
      expect(s.request('http.v1.list', p).environments).toEqual(['local'])
    } finally {
      s.core.close()
    }
  })

  it('sends, answers at once, and keeps the send with every key blanked', async () => {
    const s = await setup()
    const base = await service()
    try {
      const p = { project_id: s.project_id }
      s.request('http.v1.request.save', { ...p, id: 'Orders/Create order.http', request: doc() })
      const key = 'sk-test-0123456789'
      const { send_id } = s.request('http.v1.send', {
        ...p,
        request_id: 'Orders/Create order.http',
        environment: 'local',
        method: 'POST',
        url: `${base}/slow/orders?key=${key}`,
        headers: [
          { key: 'Authorization', value: `Bearer ${key}` },
          { key: 'Content-Type', value: 'application/json' },
        ],
        body: `{"qty":2,"key":"${key}"}`,
        secrets: [key],
      })
      expect(s.request('http.v1.send.status', { ...p, send_id }).outcome).toEqual({
        state: 'sending',
      })
      const status = await until(
        () => s.request('http.v1.send.status', { ...p, send_id }),
        (v) => v.outcome.state !== 'sending'
      )
      HttpSendStatusSchema.parse(status)
      expect(status.outcome.state).toBe('answered')
      expect(status.outcome.response.status).toBe(201)
      // The service saw the key; nothing that came back or was kept shows it.
      expect(JSON.stringify(status)).not.toContain(key)
      expect(JSON.parse(status.outcome.response.body).auth).toBe('Bearer ••••')
      expect(status.send).toMatchObject({ environment: 'local', status: 201, method: 'POST' })
      await s.core.http.settled()
      const kept = join(s.repo, '.abele/requests/.history')
      const files = readdirSync(kept, { recursive: true }).map(String)
      expect(files.length).toBeGreaterThan(0)
      for (const f of files) {
        const full = join(kept, f)
        if (f.endsWith('.json') || f.endsWith('.body') || f.endsWith('.jsonl'))
          expect(readFileSync(full, 'utf8')).not.toContain(key)
      }
      const history = s.request('http.v1.history', { ...p, id: 'Orders/Create order.http' }).sends
      expect(history).toHaveLength(1)
      expect(history[0]).toMatchObject({ id: send_id, status: 201, environment: 'local' })
      expect(s.request('http.v1.list', p).collections[0].requests[0].last).toEqual({ status: 201 })
      const body = s.request('http.v1.body', { ...p, send_id })
      expect(JSON.parse(body.text).method).toBe('POST')
      // Read back from disk once memory lets it go.
      ;(s.core.http as any).sends.clear()
      const again = s.request('http.v1.send.status', { ...p, send_id })
      expect(again.outcome.response.status).toBe(201)
      expect(JSON.parse(again.outcome.response.body).url).toBe('/slow/orders?key=••••')
    } finally {
      s.core.close()
    }
  })

  it('says a request that never reached the server failed, one with no answer may have gone', async () => {
    const s = await setup()
    let arrived = 0
    const base = await service(() => arrived++)
    const closed = await service()
    await new Promise((r) => servers.pop()!.close(r))
    try {
      const p = { project_id: s.project_id }
      const send = (url: string, extra = {}) =>
        s.request('http.v1.send', {
          ...p,
          method: 'GET',
          url,
          headers: [],
          secrets: [],
          ...extra,
        }).send_id as string
      const outcome = (id: string) =>
        until(
          () => s.request('http.v1.send.status', { ...p, send_id: id }).outcome,
          (o) => o.state !== 'sending',
          600
        )
      const refused = await outcome(send(`${closed}/orders`))
      expect(refused.state).toBe('failed')
      expect(refused.reason).toMatch(/Could not connect to 127\.0\.0\.1:\d+/)
      const silent = await outcome(send(`${base}/never`, { timeout_ms: 1000 }))
      expect(silent).toMatchObject({ state: 'unknown', reason: 'No answer in 1 s.' })
      expect(arrived).toBe(1)
      const missing = await outcome(send(`${base}/missing`))
      expect(missing.response.status).toBe(404)
    } finally {
      s.core.close()
    }
  })

  it('never follows a link out of the requests folder', async () => {
    const s = await setup()
    const outside = join(s.dir, 'outside')
    mkdirSync(outside)
    mkdirSync(join(s.repo, '.abele/requests'), { recursive: true })
    symlinkSync(outside, join(s.repo, '.abele/requests/Linked'))
    writeFileSync(join(outside, 'Secret.http'), 'GET https://example.test/\n')
    try {
      const p = { project_id: s.project_id }
      expect(s.request('http.v1.list', p).collections).toEqual([])
      expect(() =>
        s.request('http.v1.request.save', { ...p, id: 'Linked/Planted.http', request: doc() })
      ).toThrow(/http_bad_path/)
      expect(() => s.request('http.v1.request.get', { ...p, id: 'Linked/Secret.http' })).toThrow(
        /http_bad_path/
      )
      expect(existsSync(join(outside, 'Planted.http'))).toBe(false)
    } finally {
      s.core.close()
    }
  })

  it('does not carry a key across a redirect to another origin', async () => {
    const s = await setup()
    const seen: (string | undefined)[] = []
    const other = createServer((req, res) => {
      seen.push(req.headers['x-api-key'] as string | undefined)
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('elsewhere')
    })
    servers.push(other)
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r))
    // `localhost` and `127.0.0.1` are different origins for the same machine.
    const away = `http://localhost:${(other.address() as any).port}/landing`
    const first = createServer((req, res) => {
      if (req.url === '/same') {
        res.writeHead(302, { location: '/moved' })
        return res.end()
      }
      if (req.url === '/moved') {
        res.writeHead(200, { 'content-type': 'text/plain' })
        return res.end(`moved ${req.headers['x-api-key'] ? 'with key' : 'without key'}`)
      }
      res.writeHead(302, { location: away })
      res.end()
    })
    servers.push(first)
    await new Promise<void>((r) => first.listen(0, '127.0.0.1', r))
    const base = `http://127.0.0.1:${(first.address() as any).port}`
    try {
      const p = { project_id: s.project_id }
      const send = async (path: string, secret: boolean) => {
        const { send_id } = s.request('http.v1.send', {
          ...p,
          method: 'GET',
          url: `${base}${path}`,
          headers: [{ key: 'X-Api-Key', value: 'k-0123456789' }],
          secrets: secret ? ['k-0123456789'] : [],
        })
        await s.core.http.settled()
        return s.request('http.v1.send.status', { ...p, send_id }).outcome
      }
      const within = await send('/same', true)
      expect(within.response.body).toBe('moved with key')
      const stopped = await send('/away', true)
      expect(stopped.response.status).toBe(302)
      expect(stopped.response.headers).toContainEqual({ key: 'location', value: away })
      expect(seen).toEqual([])
      // With no key in it, a redirect goes on as a browser's would.
      const plain = await send('/away', false)
      expect(plain.response.body).toBe('elsewhere')
    } finally {
      s.core.close()
    }
  })

  it('pages a long body without splitting a character', async () => {
    const s = await setup()
    const long = 'é'.repeat(70_000)
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(long)
    })
    servers.push(server)
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    try {
      const p = { project_id: s.project_id }
      const { send_id } = s.request('http.v1.send', {
        ...p,
        method: 'GET',
        url: `http://127.0.0.1:${(server.address() as any).port}/`,
        headers: [],
        secrets: [],
      })
      await s.core.http.settled()
      const status = s.request('http.v1.send.status', { ...p, send_id })
      expect(status.outcome.response.more).toBe(true)
      let text = ''
      let from: number | undefined = 0
      while (from !== undefined) {
        const page = s.request('http.v1.body', { ...p, send_id, from })
        text += page.text
        from = page.next
      }
      expect(text).toBe(long)
    } finally {
      s.core.close()
    }
  })

  it('sends into a recording: the request heads the code steps taken while it was out', async () => {
    const s = await setup(true)
    const w = wire()
    let hit: (request: IncomingMessage) => void = () => {}
    const base = await service((request) => hit(request))
    let traffic: ProgramHttpEvent[] = []
    const fake = adapter(
      w,
      () => ({
        order: { qty: 2 },
        Buffer,
        [programHttpKey]: {
          drain: () => traffic.splice(0, 1),
          stop: () => {},
        },
      }),
      s.repo
    )
    const state = s.core.debugger.create({
      ...target,
      project_id: s.project_id,
      build_identity: 'matched',
    })
    const session = new DapSession(
      s.core.debugger,
      state,
      w.dap,
      new Map([['source', join(s.repo, 'src/page.ts')]])
    )
    await session.start('attach', { type: 'pwa-node', port: 1 })
    const off = s.core.debuggerControl.registerBackend(session.id, new DapDebuggerBackend(session))
    try {
      const p = { project_id: s.project_id }
      expect(() =>
        s.request('http.v1.send', {
          ...p,
          method: 'GET',
          url: `${base}/slow`,
          headers: [],
          secrets: [],
          debug_session_id: session.id,
        })
      ).toThrow(/http_not_recording/)
      s.request('trace.v1.points.set', {
        debug_session_id: session.id,
        upsert: [{ breakpoint_id: 'bp-1', take: ['order'], note: 'Order read' }],
        remove: [],
      })
      await session.patchBreakpoints(
        session.snapshot.breakpoint_revision,
        [{ breakpoint_id: 'bp-1', source_id: 'source', line: 4 }],
        []
      )
      const dapId = fake.lastBreakpointId()
      // The service's code reaches the record point while it answers.
      hit = (request) => {
        traffic.push({
          id: 'n1',
          direction: 'incoming',
          method: 'POST',
          url: `${base}/slow/orders`,
          started: Date.now(),
          ended: Date.now() + 100,
          status: 201,
          request_headers: { 'x-abele-step': String(request.headers['x-abele-step']) },
          response_headers: {},
          request_body: '{"qty":2}',
          response_body: 'answer',
        })
        fake.hit([dapId])
      }
      const sent = s.request('http.v1.send', {
        ...p,
        request_id: 'Orders/Create order.http',
        method: 'POST',
        url: `${base}/slow/orders`,
        headers: [],
        body: '{"qty":2}',
        secrets: [],
        debug_session_id: session.id,
        step_header: true,
      })
      expect(sent.run_id).toBeTruthy()
      const status = await until(
        () => s.request('http.v1.send.status', { ...p, send_id: sent.send_id }),
        (v) => v.outcome.state !== 'sending'
      )
      expect(status.code_steps).toBe(1)
      expect(status.send.run).toEqual({ run_id: sent.run_id, step: expect.any(String) })
      expect(JSON.parse(status.outcome.response.body).step).toMatch(/^h[0-9a-f]{12}$/)
      await s.core.trace.recorder.settled(session.id)
      const run = s.request('trace.v1.run', { ...p, run_id: sent.run_id })
      expect(status.send.run).toEqual({
        run_id: sent.run_id,
        step: run.steps.find((step: any) => step.sent).id,
      })
      expect(run.steps.map((x: any) => [x.kind, x.label])).toEqual([
        ['http', 'POST /slow/orders'],
        ['probe', 'Order read'],
      ])
      expect(run.steps[0]).toMatchObject({
        sent: true,
        direction: 'incoming',
        status: 201,
        host: expect.any(String),
      })
      expect(run.steps[1]).toMatchObject({ by_time: true, chain: run.steps[0].chain })
      expect(run.steps[0].values.map((v: any) => v.name)).toEqual(['request', 'response', 'http'])
      hit = () => {}
      const unrelated = s.request('http.v1.send', {
        ...p,
        method: 'GET',
        url: `${base}/missing/sink`,
        headers: [],
        secrets: [],
        debug_session_id: session.id,
      })
      await s.core.http.settled()
      expect(
        s.request('http.v1.send.status', { ...p, send_id: unrelated.send_id }).send.run
      ).toBeUndefined()
      expect(s.request('trace.v1.run', { ...p, run_id: sent.run_id }).steps).toHaveLength(2)
      const flush = s.core.trace.recorder.flushHttp
      s.core.trace.recorder.flushHttp = async () => {
        throw new Error('fixture capture unavailable')
      }
      try {
        const failedCapture = s.request('http.v1.send', {
          ...p,
          method: 'GET',
          url: `${base}/missing/capture`,
          headers: [],
          secrets: [],
          debug_session_id: session.id,
        })
        await s.core.http.settled()
        expect(
          s.request('http.v1.send.status', { ...p, send_id: failedCapture.send_id }).outcome.state
        ).toBe('answered')
      } finally {
        s.core.trace.recorder.flushHttp = flush
      }
    } finally {
      off()
      fake.stop()
      w.dap.close()
      s.core.close()
    }
  })
})
