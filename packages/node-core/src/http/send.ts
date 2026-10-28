/** One request out from the node and what came of it. Keys arrive by value for this send only and
 * are blanked in everything kept or answered: the request as it went, the answer's headers and
 * body. Whether it reached the server decides the outcome: refused or no such host never got
 * there; no answer in time, or a line cut mid-way, may have, and nothing sends it again. */
import type { HttpOutcomeDoc } from '@abele/node-protocol'
import { BODY_KEEP } from './store.js'

export const MASK = '••••'
export const DEFAULT_TIMEOUT_MS = 30_000

/** Errors that mean the request never left for the server. */
const NEVER_ARRIVED = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UND_ERR_INVALID_ARG',
  'ERR_INVALID_URL',
  'ERR_INVALID_HTTP_TOKEN',
  'ERR_INVALID_CHAR',
])

/** Blanks every secret value wherever it shows, the longest first so a longer one is not split;
 * also as it reads in an address or a form, percent-encoded. */
export function masker(secrets: string[]) {
  const forms = secrets.flatMap((s) => {
    const uri = encodeURIComponent(s)
    return [s, uri, uri.replace(/%20/g, '+')]
  })
  const values = [...new Set(forms.filter((s) => s.length >= 3))].sort(
    (a, b) => b.length - a.length
  )
  return (text: string) => {
    for (const v of values) if (text.includes(v)) text = text.split(v).join(MASK)
    return text
  }
}

export interface SendInput {
  method: string
  url: string
  headers: { key: string; value: string }[]
  body?: string
  timeoutMs?: number
  /** Service-owned sends keep the transport alive to retain a late answer. */
  retainLateAnswer?: boolean
  /** Key values in the request: a redirect to another origin does not carry them on. */
  secrets?: string[]
}

const REDIRECT = new Set([301, 302, 303, 307, 308])
const MAX_HOPS = 10
/** What a browser drops when a redirect leaves the origin, and headers named as keys. */
const ORIGIN_BOUND = /^(authorization|proxy-authorization|cookie|x-api-key|api-key)$/i
/** A send goes out over http or https only: `file:`, `data:` and the rest are not addresses here. */
const SENDABLE = new Set(['http:', 'https:'])

/** Follows redirects by hand. Within the origin it goes on as a browser would. Leaving it, a
 * request that carries a key stops there: the key was allowed for this origin only, so the
 * redirect itself is the answer, its `Location` in its headers. */
async function follow(input: SendInput, signal: AbortSignal): Promise<Response> {
  let url = input.url
  let method = input.method
  let body = input.body
  let headers = input.headers
  // A key may travel encoded (Basic, a signature): any key at all keeps the request in its origin.
  const keyed = (input.secrets ?? []).length > 0
  for (let hop = 0; ; hop++) {
    const h = new Headers()
    for (const x of headers) h.append(x.key, x.value)
    const response = await fetch(url, {
      method,
      headers: h,
      ...(body !== undefined && !['GET', 'HEAD'].includes(method) ? { body } : {}),
      redirect: 'manual',
      signal,
    })
    const location = response.headers.get('location')
    if (!REDIRECT.has(response.status) || !location || hop >= MAX_HOPS) return response
    let next: URL
    try {
      next = new URL(location, url)
    } catch {
      return response
    }
    if (!SENDABLE.has(next.protocol)) return response
    const leaves = next.origin !== new URL(url).origin
    if (leaves && keyed) return response
    await response.body?.cancel().catch(() => {})
    if (response.status === 303 || ([301, 302].includes(response.status) && method === 'POST')) {
      method = method === 'HEAD' ? 'HEAD' : 'GET'
      body = undefined
      headers = headers.filter((x) => !/^content-(type|length)$/i.test(x.key))
    }
    if (leaves) headers = headers.filter((x) => !ORIGIN_BOUND.test(x.key))
    url = next.href
  }
}

export interface SendResult {
  outcome: Exclude<HttpOutcomeDoc, { state: 'sending' }>
  /** The whole body as kept, up to `BODY_KEEP`; the answer carries only its start. */
  body?: string
  ms: number
}

const TEXTUAL =
  /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|[a-z.+-]*\+(json|xml))|$)/i

function where(error: unknown): { code?: string; message: string } {
  let e: any = error
  for (let i = 0; i < 4 && e; i++) {
    if (e.code && typeof e.code === 'string')
      return { code: e.code, message: String(e.message ?? e.code) }
    e = e.cause
  }
  return { message: error instanceof Error ? error.message : String(error) }
}

function failedWords(url: string, code: string | undefined, message: string) {
  let host = url
  try {
    host = new URL(url).host
  } catch {
    return 'Not an address that can be sent to.'
  }
  if (code === 'ECONNREFUSED') return `Could not connect to ${host}: nothing answers there.`
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `No such host: ${host}.`
  if (code?.includes('CERT') || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE')
    return `The certificate of ${host} is not trusted: ${message}`
  return `Could not connect to ${host}: ${message}`
}

export async function sendRequest(input: SendInput, signal?: AbortSignal): Promise<SendResult> {
  const started = performance.now()
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const elapsed = () => Math.round(performance.now() - started)
  const timer = AbortSignal.timeout(timeout)
  const aborted = input.retainLateAnswer
    ? (signal ?? new AbortController().signal)
    : signal
      ? AbortSignal.any([signal, timer])
      : timer
  let scheme = ''
  try {
    scheme = new URL(input.url).protocol
  } catch {
    // Said below, as for any address that cannot be sent to.
  }
  if (!SENDABLE.has(scheme))
    return {
      outcome: { state: 'failed', reason: 'Not an address that can be sent to.' },
      ms: elapsed(),
    }
  let response: Response
  try {
    response = await follow(input, aborted)
  } catch (error) {
    const { code, message } = where(error)
    if (timer.aborted && !input.retainLateAnswer)
      return {
        outcome: {
          state: 'unknown',
          reason: `No answer in ${Math.round(timeout / 1000)} s.`,
          after_ms: elapsed(),
        },
        ms: elapsed(),
      }
    if (signal?.aborted)
      return {
        outcome: {
          state: 'unknown',
          reason: 'Stopped before the answer came.',
          after_ms: elapsed(),
        },
        ms: elapsed(),
      }
    if (
      (code && NEVER_ARRIVED.has(code)) ||
      (error instanceof TypeError && /Invalid URL|Headers|header/i.test(message))
    )
      return {
        outcome: { state: 'failed', reason: failedWords(input.url, code, message) },
        ms: elapsed(),
      }
    return {
      outcome: {
        state: 'unknown',
        reason: `The connection went before the answer came: ${message}`,
        after_ms: elapsed(),
      },
      ms: elapsed(),
    }
  }
  const type = response.headers.get('content-type') ?? ''
  const chunks: Buffer[] = []
  let bytes = 0
  let cut = false
  try {
    if (response.body) {
      const reader = response.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > BODY_KEEP) {
          cut = true
          chunks.push(Buffer.from(value.subarray(0, value.byteLength - (bytes - BODY_KEEP))))
          bytes = BODY_KEEP
          await reader.cancel().catch(() => {})
          break
        }
        chunks.push(Buffer.from(value))
      }
    }
  } catch (error) {
    const { message } = where(error)
    return {
      outcome: {
        state: 'unknown',
        reason:
          timer.aborted && !input.retainLateAnswer
            ? `The answer did not finish in ${Math.round(timeout / 1000)} s.`
            : signal?.aborted
              ? 'Stopped before the answer finished.'
              : `The answer broke off: ${message}`,
        after_ms: elapsed(),
      },
      ms: elapsed(),
    }
  }
  const raw = Buffer.concat(chunks)
  const body = TEXTUAL.test(type.split(';')[0]!.trim())
    ? raw.toString('utf8')
    : `(${raw.byteLength} bytes of ${type.split(';')[0]})`
  const ms = elapsed()
  const headers: { key: string; value: string }[] = []
  response.headers.forEach((value, key) => headers.push({ key, value }))
  return {
    outcome: {
      state: 'answered',
      response: {
        status: response.status,
        reason: response.statusText,
        ms,
        bytes: raw.byteLength,
        headers,
        body,
        ...(cut ? { cut: true } : {}),
      },
    },
    body,
    ms,
  }
}
