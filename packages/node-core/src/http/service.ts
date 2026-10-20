/** The node's side of saved requests (`http.v1.*`): the project's request files, its environments,
 * sending and what came back. A send answers at once and is followed with `http.v1.send.status`:
 * a request may take longer than the channel waits for any answer. Keys come with the send, by
 * value, and live in memory until it ends; nothing written holds them. */
import { ChannelError, type AuthorityContext } from '@abele/channel-protocol'
import {
  HTTP_V1_CAPABILITY,
  HttpMethodSchemas,
  type HttpMethodNameV1,
  type HttpOutcomeDoc,
  type HttpSendSummary,
} from '@abele/node-protocol'
import type { NodeCore } from '../index.js'
import { applicationListeners } from '../debugger/programs.js'
import type { TraceChain } from '../trace/recorder.js'
import { masker, sendRequest, MASK } from './send.js'
import { HttpStore, newSendId, type HttpSendRecord } from './store.js'

/** The start of a body that travels with an answer; the rest is read in pages of this size. */
export const BODY_PAGE = 96 * 1024
/** Sends out at once on one node. */
const MAX_IN_FLIGHT = 16
/** A finished send stays answerable in memory this long after it ended. */
const KEEP_DONE_MS = 10 * 60_000

const fail = (error: unknown): never => {
  if (error instanceof ChannelError) throw error
  const message = error instanceof Error ? error.message : String(error)
  if (/^http_[a-z_]+$/.test(message)) throw new ChannelError(message)
  throw new ChannelError('http_failed', message.slice(0, 256))
}

/** Cuts a text at a byte length without splitting a character. */
function page(text: string, from: number) {
  const buf = Buffer.from(text, 'utf8')
  let end = Math.min(buf.length, from + BODY_PAGE)
  // Back off to the start of a character.
  while (end < buf.length && (buf[end]! & 0xc0) === 0x80) end--
  return {
    text: buf.subarray(from, end).toString('utf8'),
    ...(end < buf.length ? { next: end } : {}),
    bytes: buf.length,
  }
}

interface InFlight {
  project: string
  summary: HttpSendSummary
  outcome: HttpOutcomeDoc
  chain?: TraceChain
  abort: AbortController
  endedAt?: number
  done: Promise<void>
}

const SENSITIVE = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i

export class HttpService {
  private readonly sends = new Map<string, InFlight>()
  constructor(private readonly core: NodeCore) {}

  capabilities() {
    return { http_v1: HTTP_V1_CAPABILITY }
  }
  methods(): string[] {
    return Object.keys(HttpMethodSchemas)
  }
  close() {
    for (const s of this.sends.values()) s.abort.abort()
  }
  /** Lets every send under way finish; for tests and shutdown. */
  async settled() {
    await Promise.all([...this.sends.values()].map((s) => s.done))
  }

  private root(project: string): string {
    const row = this.core.db
      .prepare('SELECT root_path FROM projects WHERE project_id=?')
      .get(project) as { root_path?: string } | undefined
    if (!row?.root_path) throw new ChannelError('not_found')
    return String(row.root_path)
  }
  store(project: string) {
    return new HttpStore(this.root(project))
  }

  request(actor: AuthorityContext, method: string, raw: unknown): unknown {
    this.core.authority.check(actor, 'request')
    if (!Object.hasOwn(HttpMethodSchemas, method)) throw new ChannelError('unsupported_method')
    const parsed = HttpMethodSchemas[method as HttpMethodNameV1].safeParse(raw)
    if (!parsed.success) throw new ChannelError('invalid_params')
    try {
      return this.handle(method as HttpMethodNameV1, parsed.data as Record<string, any>)
    } catch (error) {
      return fail(error)
    }
  }

  private handle(method: HttpMethodNameV1, p: Record<string, any>): unknown {
    switch (method) {
      case 'http.v1.destination':
        return this.destination(p.project_id, p.url)
      case 'http.v1.list': {
        const store = this.store(p.project_id)
        return {
          folder: store.root,
          collections: store.list(),
          environments: store.environments(),
        }
      }
      case 'http.v1.request.get':
        return { id: p.id, request: this.store(p.project_id).get(p.id) }
      case 'http.v1.request.save':
        return this.store(p.project_id).save(p.id, p.request, { from: p.from, create: p.create })
      case 'http.v1.request.delete':
        this.store(p.project_id).delete(p.id)
        return { deleted: true }
      case 'http.v1.collection.create':
        return this.store(p.project_id).createCollection(p.name)
      case 'http.v1.env.get':
        return this.store(p.project_id).environment(p.name)
      case 'http.v1.env.save':
        return this.store(p.project_id).saveEnvironment(p.environment)
      case 'http.v1.env.delete':
        this.store(p.project_id).deleteEnvironment(p.name)
        return { deleted: true }
      case 'http.v1.send':
        return p.route_by_destination ? this.routeSend(p) : this.send(p)
      case 'http.v1.send.status':
        return this.status(p.project_id, p.send_id)
      case 'http.v1.history': {
        const store = this.store(p.project_id)
        return { sends: store.history(p.id, p.limit) }
      }
      case 'http.v1.body': {
        const store = this.store(p.project_id)
        const live = this.sends.get(p.send_id)
        if (live && !live.endedAt) throw new ChannelError('http_send_under_way')
        return page(store.body(p.send_id), p.from ?? 0)
      }
    }
  }

  private send(p: Record<string, any>) {
    const store = this.store(p.project_id)
    this.sweep()
    if ([...this.sends.values()].filter((s) => !s.endedAt).length >= MAX_IN_FLIGHT)
      throw new ChannelError('http_too_many_sends')
    const mask = masker(p.secrets)
    const id = newSendId(p.request_id)
    const headers: { key: string; value: string }[] = [...p.headers]
    // Into a recording: the run this session writes, if it writes one now.
    let chain: TraceChain | undefined
    if (p.debug_session_id) {
      if (!this.core.debugger.enabled) throw new ChannelError('http_not_recording')
      chain = this.core.trace.recorder.chain(p.debug_session_id, { method: p.method, url: p.url })
      if (!chain) throw new ChannelError('http_not_recording')
      if (p.step_header) headers.push({ key: 'X-Abele-Step', value: chain.id })
    }
    const kept = {
      method: p.method,
      url: mask(p.url),
      headers: headers.map((h) => ({
        key: h.key,
        value: SENSITIVE.test(h.key) && p.secrets.length ? maskWhole(mask, h.value) : mask(h.value),
      })),
      ...(p.body !== undefined ? { body: mask(p.body) } : {}),
    }
    const summary: HttpSendSummary = {
      id,
      at: new Date().toISOString(),
      ...(p.environment ? { environment: p.environment } : {}),
      method: p.method,
      url: kept.url,
      ...(chain ? { run: { run_id: chain.runId } } : {}),
    }
    const abort = new AbortController()
    const entry: InFlight = {
      project: p.project_id,
      summary,
      outcome: { state: 'sending' },
      abort,
      ...(chain ? { chain } : {}),
      done: Promise.resolve(),
    }
    this.sends.set(id, entry)
    entry.done = sendRequest(
      {
        method: p.method,
        url: p.url,
        headers,
        body: p.body,
        timeoutMs: p.timeout_ms,
        secrets: p.secrets,
      },
      abort.signal
    )
      .then(async (result) => {
        const outcome = maskOutcome(result.outcome, mask)
        const body = result.body === undefined ? undefined : mask(result.body)
        const done: HttpSendSummary = {
          ...summary,
          ms: result.ms,
          ...(outcome.state === 'answered'
            ? { status: outcome.response.status, bytes: outcome.response.bytes }
            : outcome.state === 'failed'
              ? { failed: true }
              : { unknown: true }),
        }
        if (chain) {
          // Recording availability must not turn a received answer into an unknown send.
          await this.core.trace.recorder.flushHttp(p.debug_session_id).catch((error) => {
            console.debug('[http] Could not confirm the recording association', error)
          })
          let host = ''
          try {
            host = new URL(p.url).host
          } catch {
            // Not an address: the step says the method and what was written.
          }
          const step = chain.close({
            label: `${p.method} ${pathOf(kept.url)}`,
            ...(outcome.state === 'answered' ? { status: outcome.response.status } : {}),
            ...(host ? { host } : {}),
            values: [
              { name: 'request', text: JSON.stringify(kept) },
              outcome.state === 'answered'
                ? { name: 'response', text: body ?? '' }
                : {
                    name: 'response',
                    failed: outcome.state === 'failed' ? outcome.reason : outcome.reason,
                  },
            ],
          })
          if (step) done.run = { run_id: chain.runId, step }
          else delete done.run
        }
        const record: HttpSendRecord = {
          summary: done,
          request: kept,
          ...(outcome.state === 'answered'
            ? {
                response: (({ body: _b, more: _m, ...rest }) => rest)(outcome.response),
              }
            : outcome.state === 'failed'
              ? { failed: outcome.reason }
              : { unknown: { reason: outcome.reason, after_ms: outcome.after_ms } }),
        }
        try {
          store.keep(p.request_id, record, body)
        } catch (error) {
          console.debug('[http] Send not kept', error)
        }
        entry.summary = done
        entry.outcome = outcome
      })
      .catch((error) => {
        console.debug('[http] Send failed', error)
        entry.outcome = {
          state: 'unknown',
          reason: 'The node lost track of this send.',
          after_ms: 0,
        }
      })
      .finally(() => {
        entry.endedAt = Date.now()
      })
    return { send_id: id, ...(chain ? { run_id: chain.runId } : {}) }
  }
  async destination(project: string, raw: string) {
    this.root(project)
    const url = new URL(raw)
    if (!['http:', 'https:'].includes(url.protocol)) throw new ChannelError('invalid_params')
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
      return { debug_session_id: null, candidates: [], reason: 'remote' as const }
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
    const pids = (await applicationListeners())
      .filter((row) => row.ports.includes(port))
      .map((row) => row.pid)
    const candidates = this.core.debugger.enabled
      ? await this.core.debuggerLaunches.owningSessions(project, pids)
      : []
    if (candidates.length > 256) throw new ChannelError('http_destination_too_many_sessions')
    return {
      debug_session_id: candidates.length === 1 ? candidates[0]! : null,
      candidates,
      reason:
        candidates.length === 1
          ? ('owned' as const)
          : candidates.length
            ? ('ambiguous' as const)
            : ('unobserved' as const),
    }
  }
  private async routeSend(p: Record<string, any>) {
    const owner = await this.destination(p.project_id, p.url)
    if (!owner.debug_session_id) throw new ChannelError('http_destination_unobserved')
    if (p.debug_session_id && p.debug_session_id !== owner.debug_session_id)
      throw new ChannelError('http_recording_owner_mismatch')
    return this.send({ ...p, debug_session_id: owner.debug_session_id })
  }

  private status(project: string, sendId: string) {
    const live = this.sends.get(sendId)
    if (live && live.project === project)
      return {
        send: live.summary,
        outcome: wireOutcome(live.outcome),
        ...(live.chain ? { code_steps: live.chain.steps } : {}),
      }
    // Gone from memory: read back what was kept.
    const store = this.store(project)
    const record = store.record(sendId)
    return {
      send: record.summary,
      outcome: record.response
        ? wireOutcome({
            state: 'answered',
            response: { ...record.response, body: store.body(sendId) },
          })
        : record.failed
          ? { state: 'failed', reason: record.failed }
          : {
              state: 'unknown',
              reason: record.unknown?.reason ?? 'No answer.',
              after_ms: record.unknown?.after_ms ?? 0,
            },
    }
  }

  private sweep() {
    const now = Date.now()
    for (const [id, s] of this.sends)
      if (s.endedAt && now - s.endedAt > KEEP_DONE_MS) this.sends.delete(id)
  }
}

/** A key header of a send with keys: blanked where a key shows in it, and whole where none does,
 * since a key may be in it encoded (Basic, a signature). */
function maskWhole(mask: (t: string) => string, value: string) {
  const masked = mask(value)
  return masked.includes(MASK) ? masked : MASK
}

function maskOutcome(
  outcome: Exclude<HttpOutcomeDoc, { state: 'sending' }>,
  mask: (t: string) => string
) {
  if (outcome.state === 'answered')
    return {
      ...outcome,
      response: {
        ...outcome.response,
        headers: outcome.response.headers.map((h) => ({ key: h.key, value: mask(h.value) })),
        body: mask(outcome.response.body),
      },
    }
  return { ...outcome, reason: mask(outcome.reason) }
}

/** An answer as it travels: the start of its body, the rest left on the node. */
function wireOutcome(outcome: HttpOutcomeDoc): HttpOutcomeDoc {
  if (outcome.state !== 'answered') return outcome
  const first = page(outcome.response.body, 0)
  return {
    state: 'answered',
    response: {
      ...outcome.response,
      body: first.text,
      ...(first.next !== undefined ? { more: true } : {}),
    },
  }
}

function pathOf(url: string) {
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}`
  } catch {
    return url
  }
}
