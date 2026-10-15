/** A project's saved requests on disk: `.abele/requests/<collection>/<name>.http`, environments in
 * `env/<name>.json` with machine-only values in `env/<name>.local.json`, and every send in
 * `.history/`, keyed by the request. The folder ignores its history and local values for git; the
 * requests and environments themselves are the owner's to commit or not. */
import { createHash, randomBytes } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type {
  HttpEnvironmentDoc,
  HttpRequestDoc,
  HttpResponseDoc,
  HttpSendSummary,
  HttpVar,
} from '@abele/node-protocol'
import { parseRequestFile, writeRequestFile } from './format.js'

export const REQUESTS_FOLDER = '.abele/requests'
const ENV = 'env'
const HISTORY = '.history'
/** Sends kept per request; older ones go with their answers. */
export const HISTORY_KEEP = 50
/** The most of an answer's body kept on disk. */
export const BODY_KEEP = 5 * 1024 * 1024
/** The largest request file read; the list leaves out anything larger. */
const REQUEST_MAX = 2 * 1024 * 1024
const IGNORE = `# What was sent and machine-only values stay on this machine.\n${HISTORY}/\n${ENV}/*.local.json\n`

const fail = (code: string): never => {
  throw new Error(code)
}

/** Whether a path in the folder is in the environments folder, in any case: on a file system that
 * ignores case `Env/` is that folder too. */
const inEnv = (rel: string) => rel.split(/[\\/]/)[0]!.toLowerCase() === ENV

/** An environment's file. Its name is one name in `env/`, and never `<other>.local`, which is the
 * file of another environment's machine-only values. */
const envFile = (name: string, local = false) => {
  if (!name || /[\\/]|^\.|\.local$/i.test(name)) fail('http_bad_path')
  return `${ENV}/${name}${local ? '.local' : ''}.json`
}

function writeAtomic(path: string, text: string | Buffer) {
  const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, path)
}

function sameFile(a: string, b: string) {
  const x = statSync(a)
  const y = statSync(b)
  return x.ino === y.ino && x.dev === y.dev
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return undefined
  }
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) return []
  const out: T[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as T)
    } catch {
      // A line cut by a crash mid-write: the rest is whole.
    }
  }
  return out
}

/** What a send kept besides its body: the request as it went, keys blanked, and the answer. */
export interface HttpSendRecord {
  summary: HttpSendSummary
  request: { method: string; url: string; headers: { key: string; value: string }[]; body?: string }
  response?: Omit<HttpResponseDoc, 'body' | 'more'>
  failed?: string
  unknown?: { reason: string; after_ms: number }
}

const historyKey = (requestId: string | undefined) =>
  createHash('sha256')
    .update(requestId ?? '')
    .digest('hex')
    .slice(0, 16)

export const newSendId = (requestId: string | undefined) =>
  `s${historyKey(requestId)}${randomBytes(5).toString('hex')}`

export class HttpStore {
  readonly root: string
  constructor(readonly project: string) {
    this.root = join(project, REQUESTS_FOLDER)
  }

  /** A path under the folder, refusing anything that would leave it: `..`, or a link on the way,
   * which something else writing in the project could have put there to point outside. */
  private inside(rel: string) {
    const full = resolve(this.root, rel)
    if (full !== this.root && !full.startsWith(this.root + sep)) fail('http_bad_path')
    let at = this.project
    for (const part of relative(this.project, full).split(sep)) {
      at = join(at, part)
      try {
        if (lstatSync(at).isSymbolicLink()) fail('http_bad_path')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break
        throw error
      }
    }
    return full
  }

  private ensure() {
    this.inside(HISTORY)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    const ignore = join(this.root, '.gitignore')
    if (!existsSync(ignore)) writeFileSync(ignore, IGNORE, { mode: 0o600 })
  }

  // ── Requests ──

  list() {
    const collections = new Map<string, { id: string; name: string; doc: HttpRequestDoc }[]>()
    const walk = (dir: string) => {
      let names: string[]
      try {
        names = readdirSync(dir)
      } catch {
        return
      }
      for (const name of names.sort((a, b) => a.localeCompare(b))) {
        if (name.startsWith('.')) continue
        const full = join(dir, name)
        const rel = relative(this.root, full).split(sep).join('/')
        let stat
        try {
          stat = lstatSync(full)
        } catch {
          continue
        }
        // A link is not followed: it could lead out of the project.
        if (stat.isSymbolicLink()) continue
        if (stat.isDirectory()) {
          if (rel.toLowerCase() === ENV) continue
          if (!collections.has(rel)) collections.set(rel, [])
          walk(full)
        } else if (name.endsWith('.http') && stat.size <= REQUEST_MAX) {
          const collection = dirname(rel) === '.' ? '' : dirname(rel)
          const doc = parseRequestFile(readFileSync(full, 'utf8'), name.slice(0, -5))
          if (!collections.has(collection)) collections.set(collection, [])
          collections.get(collection)!.push({ id: rel, name: doc.name, doc })
        }
      }
    }
    walk(this.root)
    return [...collections].map(([name, requests]) => ({
      name,
      requests: requests.map((r) => {
        const last = this.history(r.id, 1)[0]
        return {
          id: r.id,
          name: r.name,
          method: r.doc.method,
          url: r.doc.url,
          ...(last
            ? {
                last: {
                  ...(last.status !== undefined ? { status: last.status } : {}),
                  ...(last.failed ? { failed: true } : {}),
                  ...(last.unknown ? { unknown: true } : {}),
                },
              }
            : {}),
        }
      }),
    }))
  }

  get(id: string): HttpRequestDoc {
    const file = this.inside(id)
    if (!existsSync(file)) fail('http_request_not_found')
    if (statSync(file).size > REQUEST_MAX) fail('http_request_too_large')
    return parseRequestFile(readFileSync(file, 'utf8'), basename(id).slice(0, -5))
  }

  save(id: string, doc: HttpRequestDoc, options: { from?: string; create?: boolean } = {}) {
    if (inEnv(id) || (options.from && inEnv(options.from))) fail('http_bad_path')
    this.ensure()
    const file = this.inside(id)
    const moving = options.from && options.from !== id
    const from = moving ? this.inside(options.from!) : undefined
    if (from && !existsSync(from)) fail('http_request_not_found')
    // The same file by another case of its name, where the file system ignores case: a rename.
    const recase = from !== undefined && existsSync(file) && sameFile(from, file)
    if ((options.create || moving) && existsSync(file) && !recase) fail('http_request_exists')
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    if (recase) renameSync(from, file)
    writeAtomic(file, writeRequestFile(doc))
    if (from) {
      if (!recase) rmSync(from, { force: true })
      // Its history follows it.
      const was = this.historyDir(options.from)
      if (existsSync(was)) {
        const now = this.historyDir(id)
        rmSync(now, { recursive: true, force: true })
        renameSync(was, now)
      }
    }
    return { id }
  }

  delete(id: string) {
    const file = this.inside(id)
    if (!existsSync(file)) fail('http_request_not_found')
    rmSync(file, { force: true })
    rmSync(this.historyDir(id), { recursive: true, force: true })
  }

  createCollection(name: string) {
    if (inEnv(name)) fail('http_bad_path')
    this.ensure()
    const dir = this.inside(name)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    return { name }
  }

  // ── Environments ──

  environments(): string[] {
    try {
      return readdirSync(this.inside(ENV))
        .filter((n) => n.endsWith('.json') && !n.endsWith('.local.json'))
        .map((n) => n.slice(0, -5))
        .sort((a, b) => a.localeCompare(b))
    } catch {
      return []
    }
  }

  environment(name: string): HttpEnvironmentDoc {
    const file = this.inside(envFile(name))
    if (!existsSync(file)) fail('http_environment_not_found')
    const saved = readJson<{ vars?: HttpVar[]; step_header?: boolean }>(file) ?? {}
    const local =
      readJson<{ vars?: { key: string; value?: string }[] }>(this.inside(envFile(name, true)))
        ?.vars ?? []
    const vars = (Array.isArray(saved.vars) ? saved.vars : [])
      .filter((v) => v && typeof v.key === 'string' && v.key)
      .map((v) => {
        const own = local.find((l) => l.key === v.key)
        const value = v.secret ? undefined : (own?.value ?? v.value)
        return {
          key: v.key,
          ...(typeof value === 'string' ? { value } : {}),
          ...(v.secret ? { secret: true } : {}),
          ...(v.off ? { off: true } : {}),
        }
      })
    const localKeys = local.filter((l) => vars.some((v) => v.key === l.key)).map((l) => l.key)
    return {
      name,
      vars,
      ...(saved.step_header ? { step_header: true } : {}),
      ...(localKeys.length ? { local: localKeys } : {}),
    }
  }

  /** Writes an environment; a value kept in the local file stays there, a secret is never written. */
  saveEnvironment(env: Omit<HttpEnvironmentDoc, 'local'>) {
    const savedFile = envFile(env.name)
    this.ensure()
    mkdirSync(this.inside(ENV), { recursive: true, mode: 0o700 })
    const localFile = this.inside(envFile(env.name, true))
    const local = readJson<{ vars?: { key: string; value?: string }[] }>(localFile)?.vars ?? []
    const isLocal = (key: string) => local.some((l) => l.key === key)
    writeAtomic(
      this.inside(savedFile),
      `${JSON.stringify(
        {
          vars: env.vars.map((v) => ({
            key: v.key,
            ...(!v.secret && !isLocal(v.key) && v.value !== undefined ? { value: v.value } : {}),
            ...(v.secret ? { secret: true } : {}),
            ...(v.off ? { off: true } : {}),
          })),
          ...(env.step_header ? { step_header: true } : {}),
        },
        null,
        2
      )}\n`
    )
    if (local.length)
      writeAtomic(
        localFile,
        `${JSON.stringify(
          {
            vars: local
              .map((l) => {
                const v = env.vars.find((x) => x.key === l.key)
                return v && !v.secret ? { key: l.key, value: v.value ?? '' } : undefined
              })
              .filter(Boolean),
          },
          null,
          2
        )}\n`
      )
    return this.environment(env.name)
  }

  deleteEnvironment(name: string) {
    const file = this.inside(envFile(name))
    if (!existsSync(file)) fail('http_environment_not_found')
    rmSync(file, { force: true })
    rmSync(this.inside(envFile(name, true)), { force: true })
  }

  // ── History ──

  private historyDir(requestId: string | undefined) {
    return this.inside(`${HISTORY}/${historyKey(requestId)}`)
  }
  private sendDir(sendId: string) {
    if (!/^s[0-9a-f]{26}$/.test(sendId)) fail('http_send_not_found')
    return this.inside(`${HISTORY}/${sendId.slice(1, 17)}`)
  }

  history(requestId: string, limit = HISTORY_KEEP): HttpSendSummary[] {
    return readJsonl<HttpSendSummary>(join(this.historyDir(requestId), 'index.jsonl'))
      .reverse()
      .slice(0, limit)
  }

  /** Keeps a finished send: its record, its body, a line in the request's history. */
  keep(requestId: string | undefined, record: HttpSendRecord, body?: string) {
    this.ensure()
    const dir = this.historyDir(requestId)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const id = record.summary.id
    writeAtomic(join(dir, `${id}.json`), JSON.stringify(record))
    if (body !== undefined) writeAtomic(join(dir, `${id}.body`), body)
    appendFileSync(join(dir, 'index.jsonl'), `${JSON.stringify(record.summary)}\n`, { mode: 0o600 })
    const all = readJsonl<HttpSendSummary>(join(dir, 'index.jsonl'))
    if (all.length > HISTORY_KEEP + 10) {
      const kept = all.slice(-HISTORY_KEEP)
      for (const old of all.slice(0, -HISTORY_KEEP)) {
        rmSync(join(dir, `${old.id}.json`), { force: true })
        rmSync(join(dir, `${old.id}.body`), { force: true })
      }
      writeAtomic(join(dir, 'index.jsonl'), kept.map((s) => `${JSON.stringify(s)}\n`).join(''))
    }
  }

  record(sendId: string): HttpSendRecord {
    const record = readJson<HttpSendRecord>(join(this.sendDir(sendId), `${sendId}.json`))
    return record ?? fail('http_send_not_found')
  }

  body(sendId: string): string {
    const file = join(this.sendDir(sendId), `${sendId}.body`)
    if (!existsSync(file)) {
      this.record(sendId)
      return ''
    }
    return readFileSync(file, 'utf8')
  }
}
