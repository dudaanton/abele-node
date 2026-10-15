import { createServer, type RequestListener, type Server } from 'node:http'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { NodeCore } from '../../packages/node-core/src/index.js'
import { sendRequest } from '../../packages/node-core/src/http/send.js'
import { HttpMethodSchemas } from '../../packages/node-protocol/src/http.js'

const dirs: string[] = []
const servers: Server[] = []
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r))
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

async function setup() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'http-security-')))
  dirs.push(dir)
  const repo = join(dir, 'repo')
  mkdirSync(repo)
  spawnSync('/usr/bin/git', ['init', '-q', '-b', 'main'], { cwd: repo })
  const core = new NodeCore(join(dir, 'state'), { debuggerEnabled: false })
  const owner = core.createToken('test')
  const actor = core.authority.authenticate(owner.token)
  const request = (method: string, p: unknown) =>
    core.request(actor, method, p, crypto.randomUUID()) as any
  const { project_id } = (await request('project.register', { path: repo, trust: 'trusted' })) as {
    project_id: string
  }
  return { dir, repo, core, request, owner, p: { project_id } }
}

async function listen(handler: RequestListener) {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return (server.address() as { port: number }).port
}

const doc = (name = 'Ping') => ({
  name,
  method: 'GET',
  url: 'https://example.test/ping',
  params: [],
  headers: [],
  scripts: {},
  checks: [],
})

describe('saved requests stay in their folder', () => {
  it('an environment cannot be named so that it lands on another one’s machine-only values', async () => {
    const s = await setup()
    try {
      s.request('http.v1.env.save', {
        ...s.p,
        environment: { name: 'prod', vars: [{ key: 'base', value: 'https://shop.test' }] },
      })
      const local = join(s.repo, '.abele/requests/env/prod.local.json')
      writeFileSync(local, JSON.stringify({ vars: [{ key: 'base', value: 'http://10.0.0.5' }] }))
      for (const name of ['prod.local', 'prod.LOCAL'])
        expect(() =>
          s.request('http.v1.env.save', {
            ...s.p,
            environment: { name, vars: [{ key: 'base', value: 'overwritten' }] },
          })
        ).toThrow(/invalid_params/)
      expect(() => s.request('http.v1.env.delete', { ...s.p, name: 'prod.local' })).toThrow(
        /invalid_params/
      )
      // The store refuses it too, whoever calls it.
      expect(() => s.core.http.store(s.p.project_id).environment('prod.local')).toThrow(
        /http_bad_path/
      )
      expect(readFileSync(local, 'utf8')).toContain('10.0.0.5')
    } finally {
      s.core.close()
    }
  })

  it('a request or collection named like the environments folder in any case is refused', async () => {
    const s = await setup()
    try {
      s.request('http.v1.env.save', { ...s.p, environment: { name: 'prod', vars: [] } })
      for (const id of ['env/Ping.http', 'Env/Ping.http', 'ENV/Ping.http'])
        expect(() => s.request('http.v1.request.save', { ...s.p, id, request: doc() })).toThrow(
          /http_bad_path/
        )
      for (const name of ['env', 'Env'])
        expect(() => s.request('http.v1.collection.create', { ...s.p, name })).toThrow(
          /http_bad_path/
        )
      expect(readdirSync(join(s.repo, '.abele/requests/env'))).toEqual(['prod.json'])
    } finally {
      s.core.close()
    }
  })

  it('renames a request by the case of its name alone, history and all', async () => {
    const s = await setup()
    const port = await listen((_req, res) => res.end('ok'))
    try {
      s.request('http.v1.request.save', { ...s.p, id: 'Orders/ping.http', request: doc('ping') })
      s.request('http.v1.send', {
        ...s.p,
        request_id: 'Orders/ping.http',
        method: 'GET',
        url: `http://127.0.0.1:${port}/`,
        headers: [],
        secrets: [],
      })
      await s.core.http.settled()
      s.request('http.v1.request.save', {
        ...s.p,
        id: 'Orders/Ping.http',
        from: 'Orders/ping.http',
        request: doc('Ping'),
      })
      expect(readdirSync(join(s.repo, '.abele/requests/Orders'))).toEqual(['Ping.http'])
      expect(
        s.request('http.v1.request.get', { ...s.p, id: 'Orders/Ping.http' }).request.name
      ).toBe('Ping')
      expect(s.request('http.v1.history', { ...s.p, id: 'Orders/Ping.http' }).sends).toHaveLength(1)
    } finally {
      s.core.close()
    }
  })

  it('does not read a request file larger than the list shows', async () => {
    const s = await setup()
    try {
      mkdirSync(join(s.repo, '.abele/requests'), { recursive: true })
      writeFileSync(
        join(s.repo, '.abele/requests/Huge.http'),
        `GET https://example.test/\nX-Pad: ${'a'.repeat(3 * 1024 * 1024)}\n`
      )
      expect(s.request('http.v1.list', s.p).collections).toEqual([])
      expect(() => s.request('http.v1.request.get', { ...s.p, id: 'Huge.http' })).toThrow(
        /http_request_too_large/
      )
    } finally {
      s.core.close()
    }
  })

  it('every http method refuses a revoked installation and an unconfirmed paired device', async () => {
    const s = await setup()
    try {
      const paired = s.core.createToken('phone')
      const device = {
        installation_id: paired.installation_id,
        profile: 'paired-wss-v1' as const,
        device_key: 'not-confirmed',
      }
      const revoked = s.core.authority.authenticate(s.core.createToken('old').token)
      s.core.revokeToken(revoked.installation_id)
      for (const actor of [device, revoked])
        for (const method of Object.keys(HttpMethodSchemas))
          expect(() => s.core.request(actor, method, { ...s.p }, crypto.randomUUID())).toThrow(
            /unauthorized/
          )
    } finally {
      s.core.close()
    }
  })
})

describe('a send goes only where it was addressed, its keys out of what is kept', () => {
  it('blanks a key that travels encoded: in a Basic header, percent-encoded in the address', async () => {
    const s = await setup()
    const port = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ url: req.url }))
    })
    try {
      const key = 'p@ss/w0rd+key'
      const basic = `Basic ${Buffer.from(`shop:${key}`).toString('base64')}`
      const { send_id } = s.request('http.v1.send', {
        ...s.p,
        method: 'GET',
        url: `http://127.0.0.1:${port}/orders?key=${encodeURIComponent(key)}`,
        headers: [{ key: 'Authorization', value: basic }],
        secrets: [key],
      })
      await s.core.http.settled()
      const status = s.request('http.v1.send.status', { ...s.p, send_id })
      const kept = join(s.repo, '.abele/requests/.history')
      const files = readdirSync(kept, { recursive: true })
        .map(String)
        .filter((f) => /\.(json|jsonl|body)$/.test(f))
        .map((f) => readFileSync(join(kept, f), 'utf8'))
      for (const text of [JSON.stringify(status), ...files]) {
        expect(text).not.toContain(basic.slice(6))
        expect(text).not.toContain(encodeURIComponent(key))
      }
    } finally {
      s.core.close()
    }
  })

  it('drops a key header by its name at a redirect to another origin, even when not marked', async () => {
    const seen: (string | undefined)[] = []
    const away = await listen((req, res) => {
      seen.push((req.headers['x-api-key'] ?? req.headers['api-key']) as string | undefined)
      res.end('elsewhere')
    })
    const port = await listen((_req, res) => {
      res.writeHead(307, { location: `http://localhost:${away}/landing` })
      res.end()
    })
    const result = await sendRequest({
      method: 'GET',
      url: `http://127.0.0.1:${port}/`,
      headers: [
        { key: 'X-Api-Key', value: 'k-0123456789' },
        { key: 'Api-Key', value: 'k-0123456789' },
      ],
    })
    expect(result.body).toBe('elsewhere')
    expect(seen).toEqual([undefined])
  })

  it('sends only to http and https, and follows no redirect anywhere else', async () => {
    for (const url of ['file:///etc/hosts', 'data:text/plain,planted', 'ftp://example.test/'])
      expect((await sendRequest({ method: 'GET', url, headers: [] })).outcome).toEqual({
        state: 'failed',
        reason: 'Not an address that can be sent to.',
      })
    const port = await listen((_req, res) => {
      res.writeHead(302, { location: 'data:text/plain,planted' })
      res.end()
    })
    const result = await sendRequest({
      method: 'GET',
      url: `http://127.0.0.1:${port}/`,
      headers: [],
    })
    expect(result.outcome).toMatchObject({ state: 'answered', response: { status: 302 } })
  })

  it('stops a keyed send at a redirect to http, to a protocol-relative address, to another port', async () => {
    let arrived = 0
    const away = await listen((_req, res) => {
      arrived++
      res.end('elsewhere')
    })
    const locations = [
      `//localhost:${away}/x`,
      `http://127.0.0.1:${away}/x`,
      `https://127.0.0.1:${away}/x`,
    ]
    let at = 0
    const port = await listen((_req, res) => {
      res.writeHead(308, { location: locations[at++] })
      res.end()
    })
    for (let i = 0; i < locations.length; i++) {
      const result = await sendRequest({
        method: 'POST',
        url: `http://127.0.0.1:${port}/?token=k-0123456789`,
        headers: [],
        body: '{"token":"k-0123456789"}',
        secrets: ['k-0123456789'],
      })
      expect(result.outcome).toMatchObject({ state: 'answered', response: { status: 308 } })
    }
    expect(arrived).toBe(0)
  })
})
