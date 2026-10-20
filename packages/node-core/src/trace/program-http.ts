/** Self-contained: serialized into the debuggee, no dependency on installed Abele modules.
 * Diagnostics channels work on attached Node 22 programs without experimental startup flags.
 * Stream taps observe chunks the application consumes; they never put a stream in flowing mode.
 */
import { randomBytes } from 'node:crypto'
export const inspectorProbeToken = randomBytes(24).toString('hex')

export interface ProgramHttpEvent {
  id: string
  direction: 'incoming' | 'outgoing'
  method: string
  url: string
  started: number
  ended: number
  status?: number
  error?: string
  request_headers: Record<string, string>
  response_headers: Record<string, string>
  request_body: string
  response_body: string
  request_truncated?: boolean
  response_truncated?: boolean
}

export function installProgramHttp(probeToken?: string) {
  const dc = process.getBuiltinModule(
    'node:diagnostics_channel'
  ) as typeof import('node:diagnostics_channel')
  const http = process.getBuiltinModule('node:http') as typeof import('node:http')
  const { AsyncLocalStorage } = process.getBuiltinModule(
    'node:async_hooks'
  ) as typeof import('node:async_hooks')
  const fetching = new AsyncLocalStorage<boolean>()
  const limit = 32768
  const sensitive = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i
  const mask = '••••'
  let serial = 0
  let stopped = false
  let expired = false
  let lastDrain = Date.now()
  const ready: ProgramHttpEvent[] = []
  const active = new Map<
    object,
    { event: ProgramHttpEvent; undo: (() => void)[]; secrets: string[] }
  >()
  const subscriptions: (() => void)[] = []
  const bodies = new WeakMap<object, { text: string; truncated: boolean }>()
  const cut = (s: string, bytes = limit) => {
    const b = Buffer.from(s)
    let end = Math.min(bytes, b.length)
    while (end < b.length && end > 0 && (b[end]! & 0xc0) === 0x80) end--
    return b.subarray(0, end).toString('utf8')
  }
  const text = (chunk: unknown, encoding?: unknown) => {
    if (typeof chunk === 'string')
      return Buffer.from(
        chunk.slice(0, limit * 4 + 16),
        typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8'
      ).toString('utf8')
    return Buffer.isBuffer(chunk) || chunk instanceof Uint8Array
      ? Buffer.from(chunk.subarray(0, limit + 4)).toString('utf8')
      : ''
  }
  const headers = (raw: any, secrets: string[]) => {
    const out: Record<string, string> = Object.create(null)
    let size = 0
    if (typeof raw?.forEach === 'function' && typeof raw?.get === 'function') {
      const dictionary: Record<string, string> = Object.create(null)
      raw.forEach((value: string, key: string) => {
        dictionary[key] = value
      })
      raw = dictionary
    }
    const pairs: [string, unknown][] =
      typeof raw === 'string'
        ? raw.split('\r\n').flatMap((line: string) => {
            const i = line.indexOf(':')
            return i > 0 ? [[line.slice(0, i), line.slice(i + 1).trim()] as [string, unknown]] : []
          })
        : Array.isArray(raw)
          ? Array.from({ length: Math.floor(raw.length / 2) }, (_, i) => [
              String(raw[i * 2]),
              raw[i * 2 + 1],
            ])
          : Object.entries(raw ?? {})
    for (const [key, value] of pairs.slice(0, 128)) {
      const k = cut(key.toLowerCase(), 256),
        v = cut(String(value), 4096)
      if (sensitive.test(k) && v) secrets.push(v)
      size += Buffer.byteLength(k) + Buffer.byteLength(v)
      if (size > 16384) break
      out[k] = sensitive.test(k) ? mask : v
    }
    return out
  }
  const url = (raw: string) => {
    try {
      const u = new URL(raw)
      u.username = ''
      u.password = ''
      for (const key of [...u.searchParams.keys()])
        if (/token|secret|password|api.?key|authorization|cookie/i.test(key))
          u.searchParams.set(key, mask)
      return cut(u.href, 4096)
    } catch {
      return cut(raw, 4096)
    }
  }
  const start = (
    key: object,
    direction: ProgramHttpEvent['direction'],
    method: string,
    rawUrl: string,
    rawHeaders: any
  ) => {
    if (stopped || active.size >= 64) return undefined
    const secrets: string[] = []
    const event: ProgramHttpEvent = {
      id: `n${++serial}`,
      direction,
      method: cut(method, 32),
      url: url(rawUrl),
      started: Date.now(),
      ended: 0,
      request_headers: headers(rawHeaders, secrets),
      response_headers: {},
      request_body: '',
      response_body: '',
    }
    const entry = { event, undo: [] as (() => void)[], secrets }
    active.set(key, entry)
    return entry
  }
  const finish = (key: object, error?: string) => {
    const entry = active.get(key)
    if (!entry) return
    active.delete(key)
    for (const undo of entry.undo) undo()
    const e = entry.event
    e.ended = Date.now()
    if (error) e.error = cut(error, 512)
    // Header secrets can be echoed in bodies or URLs. Mask before leaving the program.
    const redact = (text: string, bound = limit, clipped?: () => void) => {
      for (const secret of new Set(entry.secrets))
        if (secret) {
          const replaced = text.split(secret).join(mask)
          if (Buffer.byteLength(replaced) > bound) clipped?.()
          text = cut(replaced, bound)
        }
      return text
    }
    e.request_body = redact(e.request_body, limit, () => {
      e.request_truncated = true
    })
    e.response_body = redact(e.response_body, limit, () => {
      e.response_truncated = true
    })
    // Redact URL data without changing its scheme or delimiters.
    try {
      const u = new URL(e.url)
      u.pathname = redact(u.pathname, 4096)
      for (const [key, value] of u.searchParams) u.searchParams.set(key, redact(value, 4096))
      u.hash = redact(u.hash, 4096)
      e.url = cut(u.href, 4096)
    } catch {
      e.url = url(e.url)
    }
    if (e.error) e.error = redact(e.error, 512)
    for (const set of [e.request_headers, e.response_headers])
      for (const name of Object.keys(set)) set[name] = redact(set[name]!, 4096)
    e.request_headers = headers(e.request_headers, [])
    e.response_headers = headers(e.response_headers, [])
    if (ready.length < 128) ready.push(e)
  }
  const add = (
    e: ProgramHttpEvent,
    side: 'request' | 'response',
    chunk: unknown,
    encoding?: unknown
  ) => {
    const field = `${side}_body` as const
    const s = text(chunk, encoding)
    const remaining = limit - Buffer.byteLength(e[field])
    if (Buffer.byteLength(s) > remaining) e[`${side}_truncated`] = true
    e[field] += cut(s, remaining)
  }
  // Observe emit rather than adding a data listener: no reads, buffering or backpressure changes.
  const tapRead = (stream: any, key: object, side: 'request' | 'response') => {
    const entry = active.get(key)
    if (!entry) return
    const original = stream.emit
    const wrapper = function (this: any, name: string, ...args: any[]) {
      if (name === 'data') add(entry.event, side, args[0])
      if (name === 'error') finish(key, String(args[0]?.message ?? 'Stream error'))
      if (side === 'response' && (name === 'end' || name === 'close')) finish(key)
      return original.call(this, name, ...args)
    }
    stream.emit = wrapper
    entry.undo.push(() => {
      if (stream.emit === wrapper) stream.emit = original
    })
  }
  const tapWrite = (stream: any, key: object) => {
    const entry = active.get(key)!
    for (const name of ['write', 'end']) {
      const original = stream[name]
      const wrapper = function (this: any, ...args: any[]) {
        add(entry.event, 'response', args[0], args[1])
        return original.apply(this, args)
      }
      stream[name] = wrapper
      entry.undo.push(() => {
        if (stream[name] === wrapper) stream[name] = original
      })
    }
    const done = () => {
      entry.event.status = stream.statusCode
      entry.event.response_headers = headers(stream.getHeaders(), entry.secrets)
      finish(key)
    }
    stream.once('finish', done)
    stream.once('close', done)
    entry.undo.push(() => {
      stream.off('finish', done)
      stream.off('close', done)
    })
  }
  const subscribe = (name: string, listener: (message: any) => void) => {
    // A diagnostics subscriber must never throw into application code.
    const safe = (message: unknown) => {
      try {
        listener(message)
      } catch {
        /* best effort */
      }
    }
    dc.subscribe(name, safe)
    subscriptions.push(() => dc.unsubscribe(name, safe))
  }
  subscribe('http.server.request.start', ({ request: req, response: res }) => {
    if (
      probeToken &&
      req.method === 'GET' &&
      ['/json/version', '/json/list'].includes(req.url) &&
      req.headers['x-abele-inspector-probe'] === probeToken &&
      ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)
    )
      return
    const scheme = req.socket?.encrypted ? 'https' : 'http'
    if (
      !start(
        req,
        'incoming',
        req.method ?? 'GET',
        `${scheme}://${req.headers.host ?? 'localhost'}${req.url}`,
        req.headers
      )
    )
      return
    tapRead(req, req, 'request')
    tapWrite(res, req)
  })
  // Client diagnostics start after end() on some Node versions: retain only bounded write data.
  for (const name of ['write', 'end'] as const) {
    const proto = http.ClientRequest.prototype as any
    const original = proto[name]
    const wrapper = function (this: any, ...args: any[]) {
      const body = bodies.get(this) ?? { text: '', truncated: false }
      const chunk = text(args[0], args[1])
      const remaining = limit - Buffer.byteLength(body.text)
      body.truncated ||= Buffer.byteLength(chunk) > remaining
      body.text += cut(chunk, remaining)
      bodies.set(this, body)
      return original.apply(this, args)
    }
    try {
      proto[name] = wrapper
    } catch {
      continue
    }
    subscriptions.push(() => {
      if (proto[name] === wrapper) proto[name] = original
    })
  }
  subscribe('http.client.request.start', ({ request: req }) => {
    const entry = start(
      req,
      'outgoing',
      req.method,
      `${req.protocol ?? 'http:'}//${req.getHeader('host')}${req.path}`,
      req.getHeaders()
    )
    if (!entry) return
    const body = bodies.get(req)
    if (body) {
      entry.event.request_body = body.text
      entry.event.request_truncated = body.truncated
    }
    const response = (res: any) => {
      entry.event.status = res.statusCode
      entry.event.response_headers = headers(res.headers, entry.secrets)
      tapRead(res, req, 'response')
    }
    const error = (err: Error) => finish(req, err.message)
    req.prependOnceListener('response', response)
    req.once('error', error)
    entry.undo.push(() => {
      req.off('response', response)
      req.off('error', error)
    })
  })
  subscribe('undici:request:create', ({ request: req }) => {
    if (fetching.getStore()) return
    start(req, 'outgoing', req.method, `${req.origin}${req.path}`, req.headers)
  })
  subscribe('undici:request:headers', ({ request: req, response: res }) => {
    const entry = active.get(req)
    if (entry) {
      entry.event.status = res.statusCode
      entry.event.response_headers = headers(res.headers, entry.secrets)
    }
  })
  subscribe('undici:request:bodyChunkReceived', ({ request: req, chunk }) => {
    const entry = active.get(req)
    if (entry) add(entry.event, 'response', chunk)
  })
  subscribe('undici:request:bodyChunkSent', ({ request: req, chunk }) => {
    const entry = active.get(req)
    if (entry) add(entry.event, 'request', chunk)
  })
  subscribe('undici:request:trailers', ({ request: req }) => finish(req))
  subscribe('undici:request:error', ({ request: req, error }) =>
    finish(req, String(error?.message ?? 'Request failed'))
  )
  const originalFetch = globalThis.fetch
  const wrappedFetch: typeof fetch = async (input, init) => {
    const key = {}
    const req = input instanceof Request ? input : undefined
    const entry = start(
      key,
      'outgoing',
      init?.method ?? req?.method ?? 'GET',
      String(req?.url ?? input),
      new Headers(init?.headers ?? req?.headers)
    )
    if (entry && (typeof init?.body === 'string' || Buffer.isBuffer(init?.body)))
      add(entry.event, 'request', init.body)
    const upload = (stream: ReadableStream<Uint8Array>) => {
      if (!entry) return
      const reader = stream.getReader()
      entry.undo.push(() => {
        void reader.cancel().catch(() => {})
      })
      void (async () => {
        try {
          while (active.has(key)) {
            const { done, value } = await reader.read()
            if (done || !active.has(key)) break
            add(entry.event, 'request', value)
            if (entry.event.request_truncated) break
          }
        } catch {
          entry.event.request_truncated = true
        } finally {
          void reader.cancel().catch(() => {})
        }
      })()
    }
    // Tee only a bounded observer branch; the original upload still goes to the application.
    try {
      if (entry && req?.body && init?.body == null) {
        const body = req.clone().body
        if (body) upload(body)
      } else if (entry && init?.body instanceof ReadableStream) {
        const [body, observed] = init.body.tee()
        init = { ...init, body }
        upload(observed)
      } else if (entry && init?.body instanceof URLSearchParams) {
        add(entry.event, 'request', init.body.toString())
      } else if (entry && init?.body instanceof Blob) {
        upload(init.body.stream())
      } else if (entry && init?.body instanceof Uint8Array && !Buffer.isBuffer(init.body)) {
        add(entry.event, 'request', init.body)
      }
    } catch {
      if (entry) entry.event.request_truncated = true
    }
    try {
      const response = await fetching.run(true, () => originalFetch(input, init))
      if (entry && active.has(key)) {
        entry.event.status = response.status
        entry.event.response_headers = headers(response.headers, entry.secrets)
        const reader = response.clone().body?.getReader()
        // Detached reader is bounded; never await it before returning the application's response.
        void (async () => {
          try {
            if (reader)
              for (;;) {
                const { done, value } = await reader.read()
                if (done || !active.has(key)) break
                add(entry.event, 'response', value)
                if (entry.event.response_truncated) break
              }
            finish(key)
          } catch (error) {
            finish(key, String(error))
          } finally {
            void reader?.cancel().catch(() => {})
          }
        })()
        entry.undo.push(() => {
          void reader?.cancel().catch(() => {})
        })
      }
      return response
    } catch (error) {
      finish(key, String(error))
      throw error
    }
  }
  if (typeof originalFetch === 'function') {
    try {
      globalThis.fetch = wrappedFetch
    } catch {
      /* diagnostics still capture undici */
    }
  }
  const api = {
    probe_token: probeToken,
    get active() {
      return !stopped
    },
    drain(): ProgramHttpEvent[] {
      if (expired) throw new Error('Program HTTP capture lease expired')
      if (stopped && !ready.length) return []
      lastDrain = Date.now()
      for (const [key, entry] of active)
        if (Date.now() - entry.event.started > 60000) finish(key, 'Capture timed out')
      // Worst-case JSON escaping + base64 stays below the 1 MiB DAP frame ceiling.
      return ready.splice(0, 1)
    },
    stop() {
      clearInterval(lease)
      stopped = true
      for (const undo of subscriptions) undo()
      if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch
      for (const key of active.keys()) finish(key, 'Recording ended')
    },
  }
  // Transport loss must not leave hooks installed in an externally owned program.
  const lease = setInterval(() => {
    if (Date.now() - lastDrain > 10000) {
      expired = true
      api.stop()
    }
  }, 1000)
  lease.unref()
  return api
}

export const programHttpKey = '__abeleProgramHttpV1'
export const programHttpInstall = `(() => { const old = globalThis.${programHttpKey}; if (!old || old.active === false || (old.active === true && old.probe_token !== ${JSON.stringify(inspectorProbeToken)})) { old?.stop(); globalThis.${programHttpKey} = (${installProgramHttp.toString()})(${JSON.stringify(inspectorProbeToken)}); } return 'ok' })()`
export const programHttpDrain = `Buffer.from(JSON.stringify(globalThis.${programHttpKey}?.drain() ?? [])).toString('base64')`
export const programHttpStop = `(() => { globalThis.${programHttpKey}?.stop(); delete globalThis.${programHttpKey}; return 'ok' })()`
