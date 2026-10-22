import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  lstatSync,
  readSync,
  realpathSync,
  type Stats,
} from 'node:fs'
import { join } from 'node:path'
import { ChannelError, type AuthorityContext } from '@abele/channel-protocol'
import type { NodeLogTail } from '@abele/node-protocol'
import type { NodeCore } from './index.js'
import { masker, MASK } from './http/send.js'
import { stripCredentials } from './git-owner.js'

const SCAN_BYTES = 256 * 1024
const RESPONSE_BYTES = 192 * 1024
const LINE_BYTES = 8192
const sensitive =
  /token|secret|password|credential|api.?key|private.?key|authorization|cookie|claim.?key|(?:^|[-_])key$/i
const same = (a: Stats, b: Stats) => a.dev === b.dev && a.ino === b.ino

/** All enrolled installations currently own the node. Grants/agent IDs are not owner identities. */
export function checkLogOwner(core: NodeCore, actor: AuthorityContext) {
  core.authority.check(actor, 'read_node_log')
  if (!['local-token-v1', 'paired-wss-v1'].includes(actor.profile ?? ''))
    throw new ChannelError('owner_required')
}

interface FileTail {
  text: string
  status: NodeLogTail['files'][number]
}
function readTail(root: string, source: 'stdout' | 'stderr'): FileTail {
  const status: FileTail['status'] = { source, truncated: false }
  let fd: number | undefined
  try {
    const directory = lstatSync(root)
    if (!directory.isDirectory() || directory.isSymbolicLink() || realpathSync(root) !== root)
      return { text: '', status: { ...status, reason: 'unavailable' } }
    const file = join(root, source + '.log')
    // Never follow a leaf symlink or block opening a FIFO/device. No caller paths are accepted.
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    const currentDirectory = lstatSync(root)
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      !same(directory, currentDirectory) ||
      currentDirectory.isSymbolicLink() ||
      realpathSync(root) !== root
    )
      return { text: '', status: { ...status, reason: 'unavailable' } }
    const current = lstatSync(file)
    if (!same(stat, current) || current.isSymbolicLink())
      return { text: '', status: { ...status, reason: 'rotated' } }
    if (!stat.size) return { text: '', status: { ...status, reason: 'empty' } }
    const start = Math.max(0, stat.size - SCAN_BYTES)
    const bytes = Buffer.alloc(Math.min(stat.size, SCAN_BYTES))
    const count = readSync(fd, bytes, 0, bytes.length, start)
    status.truncated = start > 0
    let text = bytes.subarray(0, count).toString('utf8')
    // Drop the leading partial line, not its potentially secret suffix. In-progress trailing
    // lines are also withheld until a newline arrives. Never clip a line before redaction.
    if (start) text = text.includes('\n') ? text.slice(text.indexOf('\n') + 1) : ''
    const end = text.lastIndexOf('\n')
    if (end !== text.length - 1) status.truncated = true
    text = end >= 0 ? text.slice(0, end + 1) : ''
    return { text, status }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return {
      text: '',
      status: { ...status, reason: code === 'ENOENT' ? 'missing' : 'unavailable' },
    }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/** Learn labelled values across the bounded snapshot so echoes in either stream are masked too. */
function logMask(texts: string[]) {
  const secrets: string[] = []
  const protectBlocks = (text: string) =>
    text
      // Console inspection can spread a credential object across lines. Without a complete
      // structured record, discard its suffix rather than returning unlabelled child values.
      .replace(
        /((?<![\w.-])["']?(?:key|[\w.-]*(?:token|secret|password|credential|api[-_]?key|private[-_]?key|claim[-_]?key)[\w.-]*)["']?\s*[:=]\s*)[\[{]\s*\r?\n[\s\S]*/gi,
        '$1' + MASK
      )
      .replace(
        /-----BEGIN [^-]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY(?: BLOCK)?-----|$)/g,
        MASK
      )
      // A tail window may begin inside a key. Its closing marker makes the entire prefix unsafe.
      .replace(/^[\s\S]*?-----END [^-]*PRIVATE KEY(?: BLOCK)?-----/, MASK)
  const scrub = (value: unknown, depth = 0): unknown => {
    if (depth > 32) return MASK
    if (Array.isArray(value)) return value.map((item) => scrub(item, depth + 1))
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          key,
          sensitive.test(key) ? MASK : scrub(item, depth + 1),
        ])
      )
    return value
  }
  const safeJson = (text: string) =>
    text
      .split('\n')
      .map((line) => {
        try {
          return JSON.stringify(scrub(JSON.parse(line)))
        } catch {
          return line
        }
      })
      .join('\n')
  const collect = (value: unknown, hidden = false, depth = 0): void => {
    if (depth > 32 || secrets.length > 1024) throw new Error('log_redaction_bound')
    if (typeof value === 'string' && hidden && value)
      secrets.push(value, JSON.stringify(value).slice(1, -1))
    else if (Array.isArray(value)) for (const item of value) collect(item, hidden, depth + 1)
    else if (value && typeof value === 'object')
      for (const [key, item] of Object.entries(value))
        collect(item, hidden || sensitive.test(key), depth + 1)
  }
  try {
    collect(process.env)
  } catch {
    return (_text: string) => MASK
  }
  for (const snapshot of texts) {
    const text = protectBlocks(snapshot)
    for (const line of text.split('\n')) {
      let parsed: unknown
      try {
        parsed = JSON.parse(line)
      } catch {
        continue
      }
      try {
        collect(parsed)
      } catch {
        secrets.push(line)
      }
    }
    for (const match of text.matchAll(
      /(?<![\w.-])["']?(?:key|[\w.-]*(?:token|secret|password|credential|api[-_]?key|private[-_]?key|claim[-_]?key)[\w.-]*)["']?\s*(?:[:=]\s*|\s+)(?:"([^"\n]*)"|'([^'\n]*)'|([^\s,;}]+))/gi
    )) {
      const value = match[1] ?? match[2] ?? match[3]
      if (value) secrets.push(value)
    }
    for (const match of text.matchAll(
      /(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)["']?\s*[:=]\s*(?:"([^"\n]*)"|'([^'\n]*)'|([^\r\n,}]+))/gi
    )) {
      const value = match[1] ?? match[2] ?? match[3]
      if (value) secrets.push(value.trim())
      if (value && /^(?:Bearer|Basic)\s+/i.test(value))
        secrets.push(value.replace(/^\S+\s+/, '').trim())
      if (value)
        for (const cookie of value.split(';')) {
          const equal = cookie.indexOf('=')
          if (equal >= 0) secrets.push(cookie.slice(equal + 1).trim())
        }
    }
    for (const match of text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi)) {
      try {
        const url = new URL(match[0])
        if (url.password) secrets.push(decodeURIComponent(url.password))
        for (const [key, value] of url.searchParams) if (sensitive.test(key)) secrets.push(value)
      } catch {
        /* Malformed URLs still pass through Git's conservative credential stripping. */
      }
    }
  }
  if (secrets.length > 1024) return (_text: string) => MASK
  // Reuse HTTP masking (including URL/form encodings) and Git URL credential stripping.
  const mask = masker(secrets)
  const hideValue = (_match: string, label: string, value: string) =>
    label +
    (value.startsWith('"') ? JSON.stringify(MASK) : value.startsWith("'") ? "'" + MASK + "'" : MASK)
  return (text: string) =>
    stripCredentials(mask(safeJson(protectBlocks(text))))
      // Explicit assignments must be masked even when their value is too short for the
      // general echo masker (which intentionally ignores one/two-character strings).
      .replace(
        /((?<![\w.-])["']?(?:key|[\w.-]*(?:token|secret|password|credential|api[-_]?key|private[-_]?key|claim[-_]?key)[\w.-]*)["']?\s*(?:[:=]\s*|\s+))("[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi,
        hideValue
      )
      .replace(
        /((?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)["']?\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\r\n,}]+)/gi,
        hideValue
      )
      .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, MASK)
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, MASK)
      .replace(/\b(?:sk|pk|ghp|github_pat)[-_][A-Za-z0-9_-]{16,}\b/g, MASK)
      .replace(/\b[A-Za-z0-9_-]{40,}\b/g, MASK)
}

function parseLine(text: string, source: 'stdout' | 'stderr'): NodeLogTail['lines'][number] {
  let time: string | null = null
  let level: NodeLogTail['lines'][number]['level'] = 'unknown'
  let rawTime: unknown, rawLevel: unknown
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') {
      rawTime = parsed.time ?? parsed.timestamp ?? parsed.ts
      rawLevel = parsed.level ?? parsed.severity
    }
  } catch {
    /* Unstructured stderr and console lines are valid log entries. */
  }
  rawTime ??= text.match(/^\[?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d))/)?.[1]
  const ms =
    typeof rawTime === 'number' ? rawTime : typeof rawTime === 'string' ? Date.parse(rawTime) : NaN
  if (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15) {
    const iso = new Date(ms).toISOString()
    if (/^\d{4}-/.test(iso)) time = iso
  }
  rawLevel ??= text
    .slice(0, 100)
    .match(/(?:^|\s|\[)(warn(?:ing)?|error|fatal|info|debug|trace)\b/i)?.[1]
  if (typeof rawLevel === 'number')
    level = rawLevel >= 50 ? 'error' : rawLevel >= 40 ? 'warn' : rawLevel >= 30 ? 'info' : 'debug'
  else if (typeof rawLevel === 'string') {
    const value = rawLevel.toLowerCase()
    if (['error', 'fatal', 'critical'].includes(value)) level = 'error'
    else if (['warn', 'warning'].includes(value)) level = 'warn'
    else if (value === 'info') level = 'info'
    else if (['trace', 'debug'].includes(value)) level = 'debug'
  }
  return { time, level, text, source }
}

export function tailNodeLog(
  core: NodeCore,
  actor: AuthorityContext,
  params: Record<string, unknown>
): NodeLogTail {
  checkLogOwner(core, actor)
  const tails = (['stdout', 'stderr'] as const).map((source) =>
    readTail(join(core.stateDir, 'logs'), source)
  )
  const mask = logMask(tails.map((tail) => tail.text))
  let truncated = tails.some((tail) => tail.status.truncated)
  const lines: NodeLogTail['lines'] = []
  for (const tail of tails) {
    // Redact the complete snapshot first, including multi-line private keys.
    for (const text of mask(tail.text).split('\n')) {
      if (!text) continue
      if (Buffer.byteLength(text) > LINE_BYTES) {
        truncated = true
        continue
      }
      const line = parseLine(text.replace(/\r$/, ''), tail.status.source)
      if (params.since && (!line.time || Date.parse(line.time) < Date.parse(String(params.since))))
        continue
      if (params.level === 'warnings_and_errors' && !['warn', 'error'].includes(line.level))
        continue
      lines.push(line)
    }
  }
  lines.sort((a, b) =>
    a.time && b.time ? Date.parse(a.time) - Date.parse(b.time) : a.time ? -1 : b.time ? 1 : 0
  )
  const selected = lines.slice(-Number(params.limit))
  truncated ||= lines.length > Number(params.limit)
  let bytes = 0
  const bounded: NodeLogTail['lines'] = []
  for (const line of selected.reverse()) {
    const size = Buffer.byteLength(JSON.stringify(line)) + 1
    if (bytes + size > RESPONSE_BYTES) {
      truncated = true
      break
    }
    bytes += size
    bounded.unshift(line)
  }
  const reason = bounded.length
    ? undefined
    : tails.some((tail) => tail.status.reason === 'unavailable' || tail.status.reason === 'rotated')
      ? 'logs_unavailable'
      : tails.every((tail) => tail.status.reason === 'missing')
        ? 'logs_missing'
        : tails.every((tail) => ['empty', 'missing'].includes(tail.status.reason ?? ''))
          ? 'empty'
          : 'no_matching_lines'
  checkLogOwner(core, actor)
  return {
    lines: bounded,
    truncated,
    ...(reason ? { reason } : {}),
    files: tails.map((tail) => tail.status),
  }
}
