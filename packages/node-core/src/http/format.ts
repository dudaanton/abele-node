/** A saved request as a `.http` file, the way REST Client and the JetBrains client write one: the
 * method and the address, headers, a blank line, the body. What `.http` has no words for goes in
 * `# @` comment lines above it: the name, the scripts, the checks and the lines left out. A file
 * written by hand reads too; comment lines this does not know are dropped when it is written back. */
import type { HttpPairDoc, HttpRequestDoc } from '@abele/node-protocol'

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

/** Encodes what would break the query line, and leaves `{{var}}` and `${abele_key:name}` as typed. */
const encode = (s: string) =>
  encodeURIComponent(s)
    .replace(/%7B/gi, '{')
    .replace(/%7D/gi, '}')
    .replace(/%24/g, '$')
    .replace(/%3A/gi, ':')
const decode = (s: string) => {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

function splitQuery(address: string): { url: string; params: HttpPairDoc[] } {
  const at = address.indexOf('?')
  if (at < 0) return { url: address, params: [] }
  const params = address
    .slice(at + 1)
    .split('&')
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=')
      return eq < 0
        ? { key: decode(part), value: '' }
        : { key: decode(part.slice(0, eq)), value: decode(part.slice(eq + 1)) }
    })
  return { url: address.slice(0, at), params }
}

const pairText = (p: HttpPairDoc) =>
  `${encode(p.key)}${p.value || p.key ? `=${encode(p.value)}` : ''}`

function headerOf(line: string): HttpPairDoc | undefined {
  const colon = line.indexOf(':')
  if (colon <= 0) return undefined
  return { key: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() }
}

type BodyFormat = NonNullable<HttpRequestDoc['body']>['format']

function inferFormat(headers: HttpPairDoc[], text: string): BodyFormat {
  const type = headers.find((h) => !h.off && /^content-type$/i.test(h.key))?.value ?? ''
  if (/x-www-form-urlencoded/i.test(type)) return 'form'
  if (/json/i.test(type)) return 'json'
  if (!type && /^\s*[[{]/.test(text)) {
    try {
      JSON.parse(text)
      return 'json'
    } catch {
      return 'text'
    }
  }
  return 'text'
}

export function parseRequestFile(text: string, fallbackName: string): HttpRequestDoc {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const doc: HttpRequestDoc = {
    name: fallbackName,
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    scripts: {},
    checks: [],
  }
  const offParams: HttpPairDoc[] = []
  const offHeaders: HttpPairDoc[] = []
  let bodyFormat: BodyFormat | undefined
  let i = 0
  // Comments and blank lines before the request line.
  for (; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (!line) continue
    const meta = /^(?:#|\/\/)\s*@([a-z-]+)\s*(.*)$/.exec(line)
    if (meta) {
      const [, tag, rest] = meta
      const value = rest!.trim()
      if (tag === 'name' && value) doc.name = value.slice(0, 200)
      else if (tag === 'before' && value) doc.scripts.before = value
      else if (tag === 'after' && value) doc.scripts.after = value
      else if (tag === 'check' && value) doc.checks.push(value)
      else if (tag === 'off-param') {
        const { params } = splitQuery(`?${value}`)
        offParams.push(...params.map((p) => ({ ...p, off: true })))
      } else if (tag === 'off-header') {
        const h = headerOf(value)
        if (h) offHeaders.push({ ...h, off: true })
      } else if (tag === 'body' && ['json', 'text', 'form'].includes(value))
        bodyFormat = value as BodyFormat
      continue
    }
    if (/^(#|\/\/)/.test(line)) continue
    break
  }
  const request = lines[i]?.trim()
  if (request) {
    const words = request.split(/\s+/)
    let address = request
    if (METHODS.has(words[0]!.toUpperCase())) {
      doc.method = words[0]!.toUpperCase() as HttpRequestDoc['method']
      address = request.slice(words[0]!.length).trim()
    }
    address = address.replace(/\s+HTTP\/[\d.]+$/i, '')
    const { url, params } = splitQuery(address)
    doc.url = url
    doc.params = params
    i++
  }
  for (; i < lines.length; i++) {
    const line = lines[i]!
    if (!line.trim()) {
      i++
      break
    }
    if (/^\s*(#|\/\/)/.test(line)) continue
    const h = headerOf(line)
    if (h) doc.headers.push(h)
  }
  doc.params.push(...offParams)
  doc.headers.push(...offHeaders)
  const body = lines.slice(i).join('\n').replace(/\n+$/, '')
  if (body) doc.body = { format: bodyFormat ?? inferFormat(doc.headers, body), text: body }
  return doc
}

/** Every field above the body is one line of the file: a line break or another control
 * character in it would start a line of its own, a header or a request that was never written. */
const line = (text: string) => text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()

export function writeRequestFile(doc: HttpRequestDoc): string {
  const out: string[] = [`# @name ${line(doc.name)}`]
  if (doc.scripts.before) out.push(`# @before ${line(doc.scripts.before)}`)
  if (doc.scripts.after) out.push(`# @after ${line(doc.scripts.after)}`)
  for (const check of doc.checks) out.push(`# @check ${line(check)}`)
  for (const p of doc.params.filter((p) => p.off)) out.push(`# @off-param ${pairText(p)}`)
  for (const h of doc.headers.filter((h) => h.off))
    out.push(`# @off-header ${line(h.key)}: ${line(h.value)}`)
  if (doc.body && inferFormat(doc.headers, doc.body.text) !== doc.body.format)
    out.push(`# @body ${doc.body.format}`)
  const query = doc.params
    .filter((p) => !p.off)
    .map(pairText)
    .join('&')
  out.push(`${doc.method} ${line(doc.url).replace(/\s+/g, '%20')}${query ? `?${query}` : ''}`)
  for (const h of doc.headers.filter((h) => !h.off)) out.push(`${line(h.key)}: ${line(h.value)}`)
  if (doc.body?.text) out.push('', doc.body.text)
  return `${out.join('\n')}\n`
}
