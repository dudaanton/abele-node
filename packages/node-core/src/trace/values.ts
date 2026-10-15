/** What is worked out of a recorded value on the node: its format, a one-line brief, its shape,
 * a bounded slice by path, a structural diff and its leaves for find/follow. Pure functions over
 * the value's text; callers bound the input size before calling. */

export type TraceFormat = 'json' | 'xml' | 'text' | 'number'

export interface TraceShapeNode {
  key?: string
  type: string
  count?: number
  optional?: boolean
  example?: string
  children?: TraceShapeNode[]
}

export interface TraceCap {
  lines: number
  bytes: number
}

/** Panel views and agent tools have their own ceilings. A caller can ask for less, never more. */
export const TRACE_CAPS = {
  panel: { lines: 200, bytes: 16 * 1024 },
  agent: { lines: 80, bytes: 6 * 1024 },
} as const satisfies Record<string, TraceCap>

/** Values larger than this are stored and paged, but not parsed for shape, diff or leaves. */
export const TRACE_PARSE_LIMIT = 32 * 1024 * 1024

const SHAPE_DEPTH = 8
const SHAPE_KEYS = 40
const EXAMPLE = 40

export function formatOf(text: string): TraceFormat {
  const t = text.trimStart()
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text.trim())) return 'number'
  if (t.startsWith('<')) return 'xml'
  if (t.startsWith('{') || t.startsWith('[') || t.startsWith('"')) {
    try {
      JSON.parse(text)
      return 'json'
    } catch {
      return 'text'
    }
  }
  if (t === 'true' || t === 'false' || t === 'null') return 'json'
  return 'text'
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

export function briefOf(text: string, format: TraceFormat): string {
  if (format === 'number') return text.trim()
  if (format === 'xml') {
    for (const t of xmlTokens(text))
      if ('tag' in t && !/^<[/?!]/.test(t.tag)) return `<${tagName(t.tag)}>`
    return clip(text.trim(), 60)
  }

  if (format === 'json' && text.length <= TRACE_PARSE_LIMIT) {
    try {
      const v: unknown = JSON.parse(text)
      if (Array.isArray(v)) return `[${v.length} items]`
      if (v && typeof v === 'object') {
        const keys = Object.entries(v as Record<string, unknown>).map(([k, x]) =>
          Array.isArray(x) ? `${k}: ${x.length}` : k
        )
        const shown = keys.slice(0, 6).join(', ')
        return clip(`{ ${shown}${keys.length > 6 ? ', …' : ''} }`, 60)
      }
      return clip(JSON.stringify(v), 60)
    } catch {
      /* falls through to text */
    }
  }
  return clip(JSON.stringify(text.replace(/\s+/g, ' ').trim()), 62)
}

const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v

const exampleOf = (v: unknown) => clip(JSON.stringify(v) ?? String(v), EXAMPLE)

/** Merges the shapes of values seen at one place: a list's elements, an object's key across them. */
function mergeShape(values: unknown[], key: string | undefined, depth: number): TraceShapeNode {
  const types = new Set(values.map(typeOf))
  const node: TraceShapeNode = { type: [...types].join(' | ') }
  if (key !== undefined) node.key = key
  if (depth >= SHAPE_DEPTH) return node
  const arrays = values.filter(Array.isArray) as unknown[][]
  const objects = values.filter((v) => typeOf(v) === 'object') as Record<string, unknown>[]
  if (arrays.length) {
    node.count = arrays.reduce((n, a) => n + a.length, 0)
    const elements = arrays.flat()
    if (elements.length) node.children = [mergeShape(elements, '[*]', depth + 1)]
  } else if (objects.length) {
    const keys: string[] = []
    const seen = new Set<string>()
    for (const o of objects)
      for (const k of Object.keys(o))
        if (!seen.has(k)) {
          seen.add(k)
          keys.push(k)
        }
    node.children = keys.slice(0, SHAPE_KEYS).map((k) => {
      const present = objects.filter((o) => Object.prototype.hasOwnProperty.call(o, k))
      const child = mergeShape(
        present.map((o) => o[k]),
        k,
        depth + 1
      )
      if (present.length < objects.length) child.optional = true
      return child
    })
    if (keys.length > SHAPE_KEYS)
      node.children.push({ key: '…', type: `${keys.length - SHAPE_KEYS} more keys` })
  } else {
    const leaf = values.find((v) => v !== null && v !== undefined)
    if (leaf !== undefined || values.length) node.example = exampleOf(leaf ?? values[0])
  }
  return node
}

interface XmlNode {
  name: string
  children: XmlNode[]
  text: string
}

/** A forgiving tokenizer: enough to count elements and read their text, not a validating parser. */
type XmlToken = { tag: string } | { text: string; cdata?: boolean } | { comment: string }

/** XML split into tags, text, comments and CDATA in one pass, by `indexOf`: whatever the input,
 * each character is looked at a bounded number of times. Anything unclosed ends as text. */
function* xmlTokens(text: string): Generator<XmlToken> {
  let i = 0
  // The next `>` stays ahead of the scan until passed: a run of `<` costs one search, not one each.
  let gt = -1
  while (i < text.length) {
    const lt = text.indexOf('<', i)
    if (lt < 0) {
      yield { text: text.slice(i) }
      return
    }
    if (lt > i) yield { text: text.slice(i, lt) }
    const block = text.startsWith('<!--', lt)
      ? ['-->', 4]
      : text.startsWith('<![CDATA[', lt)
        ? [']]>', 9]
        : undefined
    if (block) {
      const end = text.indexOf(block[0] as string, lt + (block[1] as number))
      if (end < 0) {
        yield { text: text.slice(lt) }
        return
      }
      const inner = text.slice(lt + (block[1] as number), end)
      yield block[0] === '-->' ? { comment: inner } : { text: inner, cdata: true }
      i = end + 3
      continue
    }
    if (gt <= lt) gt = text.indexOf('>', lt + 1)
    if (gt < 0) {
      yield { text: text.slice(lt) }
      return
    }
    const stray = text.indexOf('<', lt + 1)
    if (stray >= 0 && stray < gt) {
      yield { text: text.slice(lt, stray) }
      i = stray
      continue
    }
    yield { tag: text.slice(lt, gt + 1) }
    i = gt + 1
  }
}

const tagName = (tag: string) => /^<\/?\s*([^\s/>]+)/.exec(tag)?.[1] ?? ''

/** A forgiving reader: enough to count elements and read their text, not a validating parser. */
function parseXml(text: string): XmlNode {
  const root: XmlNode = { name: '#document', children: [], text: '' }
  const stack = [root]
  for (const t of xmlTokens(text)) {
    const top = stack[stack.length - 1]!
    if ('text' in t) top.text += t.text
    else if ('tag' in t) {
      const tag = t.tag
      if (tag.startsWith('<?') || tag.startsWith('<!')) continue
      const name = tagName(tag)
      if (!name) continue
      if (tag.startsWith('</')) {
        const at = stack.map((n) => n.name).lastIndexOf(name)
        if (at > 0) stack.length = at
      } else {
        const node: XmlNode = { name, children: [], text: '' }
        top.children.push(node)
        // Deeper elements are counted where the depth cap leaves them, keeping closing tags cheap.
        if (!tag.endsWith('/>') && stack.length < 256) stack.push(node)
      }
    }
  }
  return root
}

function xmlShape(nodes: XmlNode[], depth: number): TraceShapeNode {
  const name = nodes[0]!.name
  const node: TraceShapeNode = { key: name, type: `<${name}>` }
  if (nodes.length > 1) node.count = nodes.length
  const text = nodes.map((n) => n.text.trim()).find(Boolean)
  if (text) node.example = clip(JSON.stringify(text), EXAMPLE)
  if (depth >= SHAPE_DEPTH) return node
  const groups = new Map<string, XmlNode[]>()
  for (const n of nodes)
    for (const c of n.children) groups.set(c.name, [...(groups.get(c.name) ?? []), c])
  if (groups.size)
    node.children = [...groups.values()].slice(0, SHAPE_KEYS).map((g) => {
      const child = xmlShape(g, depth + 1)
      child.count = g.length
      return child
    })
  return node
}

export function shapeOf(text: string, format: TraceFormat): TraceShapeNode {
  if (text.length > TRACE_PARSE_LIMIT)
    return { type: format, example: `too large to read its shape (${text.length} characters)` }
  if (format === 'xml') {
    if (text.length > TRACE_XML_LIMIT)
      return { type: 'xml', example: `too large to read its shape (${text.length} characters)` }
    const doc = parseXml(text)
    return doc.children[0]
      ? xmlShape([doc.children[0]], 0)
      : { type: 'xml', example: clip(text, EXAMPLE) }
  }
  if (format === 'json') return mergeShape([JSON.parse(text) as unknown], undefined, 0)
  if (format === 'number') return { type: 'number', example: text.trim() }
  const lines = text.split('\n').length
  return { type: 'text', count: lines, example: clip(JSON.stringify(text.slice(0, 200)), EXAMPLE) }
}

type Step = { key: string } | { index: number } | { all: true }

/** `$.a.b[3]`, `$["odd key"]`, `$.items[*].id`. */
export function parsePath(path: string): Step[] {
  if (!path.startsWith('$')) throw new Error('trace_path_invalid')
  const out: Step[] = []
  const re = /\.([A-Za-z_$][\w$-]*)|\[(\d+)\]|\[\*\]|\["((?:[^"\\]|\\.)*)"\]/y
  let at = 1
  while (at < path.length) {
    re.lastIndex = at
    const m = re.exec(path)
    if (!m) throw new Error('trace_path_invalid')
    if (m[1] !== undefined) out.push({ key: m[1] })
    else if (m[2] !== undefined) out.push({ index: Number(m[2]) })
    else if (m[3] !== undefined) out.push({ key: JSON.parse(`"${m[3]}"`) as string })
    else out.push({ all: true })
    at = re.lastIndex
  }
  return out
}

const keyPath = (key: string) =>
  /^[A-Za-z_$][\w$-]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`

function select(value: unknown, steps: Step[]): { found: boolean; value: unknown } {
  let current: unknown[] = [value]
  let spread = false
  for (const s of steps) {
    const next: unknown[] = []
    for (const v of current) {
      if ('all' in s) {
        if (Array.isArray(v)) next.push(...(v as unknown[]))
        else if (v && typeof v === 'object') next.push(...Object.values(v))
      } else if ('index' in s) {
        if (Array.isArray(v) && s.index < v.length) next.push(v[s.index])
      } else if (v && typeof v === 'object' && Object.prototype.hasOwnProperty.call(v, s.key))
        next.push((v as Record<string, unknown>)[s.key])
    }
    if ('all' in s) spread = true
    current = next
    if (!current.length) return { found: false, value: undefined }
  }
  return { found: true, value: spread ? current : current[0] }
}

export interface TracePage {
  lines: string[]
  /** The line to go on from, when the page stopped at its ceiling. */
  next?: number
  truncated: boolean
  total: number
}

/** The ceiling is the smaller of what was asked and the caller's kind's own. */
function bound(ask: TraceCap, kind: keyof typeof TRACE_CAPS): TraceCap {
  const own = TRACE_CAPS[kind]
  return {
    lines: Math.max(1, Math.min(ask.lines, own.lines)),
    bytes: Math.max(64, Math.min(ask.bytes, own.bytes)),
  }
}

function cut(all: string[], from: number, cap: TraceCap): TracePage {
  const lines: string[] = []
  let bytes = 0
  let i = from
  for (; i < all.length && lines.length < cap.lines; i++) {
    const line = all[i]!
    const size = Buffer.byteLength(line) + 1
    if (bytes + size > cap.bytes) {
      // A single line longer than the whole budget is shown clipped rather than not at all.
      if (!lines.length) {
        lines.push(clip(line, cap.bytes))
        i++
      }
      break
    }
    lines.push(line)
    bytes += size
  }
  const truncated = i < all.length
  return truncated
    ? { lines, next: i, truncated, total: all.length }
    : { lines, truncated, total: all.length }
}

const LONG_LINE = 2000
const MAX_INDENT = 32
/** XML is laid out and read for its shape only this large; past it, raw lines and no shape. */
export const TRACE_XML_LIMIT = 8 * 1024 * 1024

/** XML laid out an element a line, indented by depth; text between tags stays with its tag. */
function xmlLines(text: string): string[] {
  const out: string[] = []
  let depth = 0
  for (const t of xmlTokens(text)) {
    if (!('tag' in t)) {
      const raw =
        'comment' in t ? `<!--${t.comment}-->` : t.cdata ? `<![CDATA[${t.text}]]>` : t.text
      const v = raw.trim()
      if (v && out.length) out[out.length - 1] += v
      else if (v) out.push(v)
      continue
    }
    const tag = t.tag
    const closing = tag.startsWith('</')
    const single = tag.endsWith('/>') || tag.startsWith('<?') || tag.startsWith('<!')
    if (closing) {
      depth = Math.max(0, depth - 1)
      const last = out[out.length - 1]
      // `<a>text</a>` stays on one line.
      if (last !== undefined && /^\s*<[^/!?][^>]*>[^<]*$/.test(last))
        out[out.length - 1] = last + tag
      else out.push('  '.repeat(Math.min(depth, MAX_INDENT)) + tag)
    } else {
      out.push('  '.repeat(Math.min(depth, MAX_INDENT)) + tag)
      if (!single) depth++
    }
  }
  return out
}

const linesOf = (text: string, format: TraceFormat) => {
  let lines: string[] | undefined
  if (format === 'json' && text.length <= TRACE_PARSE_LIMIT) {
    try {
      lines = JSON.stringify(JSON.parse(text), null, 2).split('\n')
    } catch {
      /* raw lines */
    }
  }
  if (format === 'xml' && text.length <= TRACE_XML_LIMIT && text.split('\n', 50).length < 50)
    lines = xmlLines(text)
  // A line no screen can show whole is cut into pieces a page can carry.
  return (lines ?? text.split('\n')).flatMap((l) =>
    l.length <= LONG_LINE
      ? [l]
      : Array.from({ length: Math.ceil(l.length / LONG_LINE) }, (_, i) =>
          l.slice(i * LONG_LINE, (i + 1) * LONG_LINE)
        )
  )
}

/** A page of the whole value as formatted lines. */
export function pageOf(
  text: string,
  format: TraceFormat,
  from: number,
  ask: TraceCap,
  kind: keyof typeof TRACE_CAPS = 'panel'
): TracePage {
  return cut(linesOf(text, format), Math.max(0, from), bound(ask, kind))
}

/** The part of a value at a path, formatted, bounded. XML and text are sliced by lines `L10-L40`. */
export function sliceOf(
  text: string,
  format: TraceFormat,
  path: string,
  ask: TraceCap,
  kind: keyof typeof TRACE_CAPS = 'panel',
  from = 0
): TracePage {
  const cap = bound(ask, kind)
  if (format !== 'json') {
    const m = /^L(\d+)(?:-L?(\d+))?$/.exec(path)
    const all = text.split('\n')
    if (path === '$' || !m) {
      if (path !== '$') throw new Error('trace_path_invalid')
      return cut(all, from, cap)
    }
    const start = Number(m[1]) - 1
    const end = m[2] ? Number(m[2]) : start + 1
    if (start >= all.length) throw new Error('trace_path_not_found')
    return cut(all.slice(start, end), from, cap)
  }
  const picked = select(JSON.parse(text) as unknown, parsePath(path))
  if (!picked.found) throw new Error('trace_path_not_found')
  return cut((JSON.stringify(picked.value, null, 2) ?? 'undefined').split('\n'), from, cap)
}

export interface TraceLeaf {
  path: string
  type: string
  value: string | number | boolean | null
}

const LEAF_LIMIT = 200_000

export function leavesOf(text: string, format: TraceFormat): TraceLeaf[] {
  if (text.length > TRACE_PARSE_LIMIT) return []
  if (format === 'number') return [{ path: '$', type: 'number', value: Number(text) }]
  if (format === 'text') return [{ path: '$', type: 'string', value: text }]
  const out: TraceLeaf[] = []
  if (format === 'xml' && text.length > TRACE_XML_LIMIT) return []
  if (format === 'xml') {
    const walk = (n: XmlNode, path: string) => {
      const t = n.text.trim()
      if (t && out.length < LEAF_LIMIT) out.push({ path: path || 'text', type: 'string', value: t })
      const counts = new Map<string, number>()
      for (const c of n.children) {
        const i = counts.get(c.name) ?? 0
        counts.set(c.name, i + 1)
        walk(c, `${path}/${c.name}[${i + 1}]`)
      }
    }
    const doc = parseXml(text)
    const only = doc.children.length === 1 ? doc.children[0] : undefined
    if (only && !only.children.length) {
      const t = only.text.trim()
      return t ? [{ path: 'text', type: 'string', value: t }] : []
    }
    walk(doc, '')
    return out
  }
  const walk = (v: unknown, path: string) => {
    if (out.length >= LEAF_LIMIT) return
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`))
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) walk(x, `${path}${keyPath(k)}`)
    else out.push({ path, type: typeOf(v), value: v as TraceLeaf['value'] })
  }
  walk(JSON.parse(text) as unknown, '$')
  return out
}

export interface TraceNeedle {
  value?: string | number | boolean
  key?: string
  /** A number and the same number written as a string count as one. */
  loose?: boolean
}

export const matches = (leaf: TraceLeaf, n: TraceNeedle) => {
  if (n.key !== undefined) {
    const last = /(?:\.([^.[\]]+)|\["((?:[^"\\]|\\.)*)"\])$/.exec(leaf.path)
    return (last?.[1] ?? (last?.[2] ? (JSON.parse(`"${last[2]}"`) as string) : '')) === n.key
  }
  if (n.value === undefined) return false
  if (leaf.value === n.value) return true
  if (!n.loose) return false
  const a = Number(leaf.value)
  const b = Number(n.value)
  return leaf.value !== null && leaf.value !== '' && !Number.isNaN(a) && a === b
}

export function findIn(text: string, format: TraceFormat, needle: TraceNeedle): string[] {
  return leavesOf(text, format)
    .filter((l) => matches(l, needle))
    .map((l) => l.path)
}

export interface TraceChange {
  path: string
  kind: 'added' | 'removed' | 'type' | 'value'
  before?: string
  after?: string
  /** How many concrete places the grouped path covers. */
  count: number
}

export interface TraceDiff {
  /** One line: `94% the same · 3 added · 2 changed type`. */
  summary: string
  changes: TraceChange[]
}

const general = (path: string) => path.replace(/\[\d+\]/g, '[*]')

export function diffValues(
  aText: string,
  aFormat: TraceFormat,
  bText: string,
  bFormat: TraceFormat,
  limit = 200
): TraceDiff {
  if (aText === bText) return { summary: 'The same', changes: [] }
  const a = leavesOf(aText, aFormat)
  const b = leavesOf(bText, bFormat)
  const aBy = new Map(a.map((l) => [l.path, l]))
  const bBy = new Map(b.map((l) => [l.path, l]))
  const groups = new Map<string, TraceChange>()
  const note = (path: string, kind: TraceChange['kind'], before?: string, after?: string) => {
    const key = `${kind}\u0000${general(path)}\u0000${before ?? ''}\u0000${after ?? ''}`
    const g = groups.get(key)
    if (g) g.count++
    else groups.set(key, { path: general(path), kind, before, after, count: 1 })
  }
  let same = 0
  for (const l of a) {
    const other = bBy.get(l.path)
    if (!other) note(l.path, 'removed', l.type)
    else if (other.type !== l.type) note(l.path, 'type', l.type, other.type)
    else if (other.value !== l.value)
      note(l.path, 'value', exampleOf(l.value), exampleOf(other.value))
    else same++
  }
  for (const l of b) if (!aBy.has(l.path)) note(l.path, 'added', undefined, l.type)
  const changes = [...groups.values()]
  // Values that differ everywhere are less telling than structure: added, removed, type first.
  const order = { added: 0, removed: 1, type: 2, value: 3 }
  changes.sort((x, y) => order[x.kind] - order[y.kind] || y.count - x.count)
  const count = (k: TraceChange['kind']) => changes.filter((c) => c.kind === k).length
  // One value on each side, in the same place, has no structure to measure: say what it was.
  const [was, now] = [a[0], b[0]]
  if (a.length === 1 && b.length === 1 && was && now && was.path === now.path)
    return {
      summary: `was ${exampleOf(was.value)}${was.type === now.type ? '' : ` (${was.type})`}`,
      changes,
    }
  // Nothing measurable on either side: the text differs, and that is all that is known.
  if (!a.length && !b.length) return { summary: 'Changed', changes }
  const total = Math.max(a.length, b.length, 1)
  const parts = [`${Math.floor((same / total) * 100)}% the same`]
  if (count('added')) parts.push(`${count('added')} added`)
  if (count('removed')) parts.push(`${count('removed')} removed`)
  if (count('type')) parts.push(`${count('type')} changed type`)
  if (count('value')) parts.push(`${count('value')} changed value`)
  return { summary: parts.join(' · '), changes: changes.slice(0, limit) }
}
