import { describe, expect, it } from 'vitest'
import {
  briefOf,
  diffValues,
  findIn,
  formatOf,
  leavesOf,
  pageOf,
  shapeOf,
  sliceOf,
  TRACE_CAPS,
} from '../../packages/node-core/src/trace/values.js'

const contract = JSON.stringify({
  id: 'C-100',
  items: [
    { id: 'i-1', amount: '12.50', note: 'first' },
    { id: 'i-2', amount: '7.00' },
  ],
  owner: { name: 'Sample Owner', tags: [] },
})

describe('what a value is', () => {
  it('tells JSON, XML, numbers and plain text apart', () => {
    expect(formatOf(contract)).toBe('json')
    expect(formatOf('<?xml version="1.0"?><a/>')).toBe('xml')
    expect(formatOf('<doc><x/></doc>')).toBe('xml')
    expect(formatOf('1250')).toBe('number')
    expect(formatOf('hello there')).toBe('text')
  })

  it('reads in one line: the keys of an object with the lengths of its lists', () => {
    expect(briefOf(contract, 'json')).toBe('{ id, items: 2, owner }')
    expect(briefOf('[1,2,3]', 'json')).toBe('[3 items]')
    expect(briefOf('"plain"', 'json')).toBe('"plain"')
    expect(briefOf('<?xml version="1.0"?><doc/>', 'xml')).toBe('<doc>')
    expect(briefOf('x'.repeat(200), 'text').length).toBeLessThanOrEqual(62)
  })
})

describe('the shape of a value', () => {
  it('merges the elements of a list and marks keys only some of them have', () => {
    const shape = shapeOf(contract, 'json')
    expect(shape.type).toBe('object')
    const items = shape.children!.find((c) => c.key === 'items')!
    expect(items).toMatchObject({ type: 'array', count: 2 })
    const element = items.children![0]!
    expect(element.key).toBe('[*]')
    const note = element.children!.find((c) => c.key === 'note')!
    expect(note).toMatchObject({ type: 'string', optional: true, example: '"first"' })
    expect(element.children!.find((c) => c.key === 'amount')!.optional).toBeUndefined()
  })

  it('counts the elements of an XML tree by name', () => {
    const shape = shapeOf('<doc><item a="1"/><item/><head>t</head></doc>', 'xml')
    expect(shape).toMatchObject({ key: 'doc', type: '<doc>' })
    expect(shape.children!.find((c) => c.key === 'item')).toMatchObject({ count: 2 })
  })

  it('fits a large JSON value in a hundred lines quickly', () => {
    const big = JSON.stringify({
      rows: Array.from({ length: 20000 }, (_, i) => ({
        id: `r-${i}`,
        value: i,
        flag: i % 2 === 0,
        extra: i % 3 === 0 ? { deep: [i] } : undefined,
      })),
    })
    expect(big.length).toBeGreaterThan(1_000_000)
    const started = Date.now()
    const shape = shapeOf(big, 'json')
    expect(Date.now() - started).toBeLessThan(2000)
    const lines = (function count(n: typeof shape): number {
      return 1 + (n.children ?? []).reduce((s, c) => s + count(c), 0)
    })(shape)
    expect(lines).toBeLessThan(100)
  })
})

describe('a slice by path', () => {
  it('takes one element by its path, as formatted lines', () => {
    const s = sliceOf(contract, 'json', '$.items[1]', TRACE_CAPS.panel)
    expect(JSON.parse(s.lines.join('\n'))).toEqual({ id: 'i-2', amount: '7.00' })
    expect(s.truncated).toBe(false)
  })

  it('collects one key across all elements', () => {
    const s = sliceOf(contract, 'json', '$.items[*].amount', TRACE_CAPS.panel)
    expect(JSON.parse(s.lines.join('\n'))).toEqual(['12.50', '7.00'])
  })

  it('says where to go on when it stops at its limit, and the limit cannot be lifted', () => {
    const long = JSON.stringify(Array.from({ length: 500 }, (_, i) => i))
    const s = sliceOf(long, 'json', '$', { lines: 10_000, bytes: 1_000_000 }, 'agent')
    expect(s.lines.length).toBeLessThanOrEqual(TRACE_CAPS.agent.lines)
    expect(s.truncated).toBe(true)
    expect(s.next).toBe(s.lines.length)
  })

  it('says plainly when the path is not in the value', () => {
    expect(() => sliceOf(contract, 'json', '$.nothing.here', TRACE_CAPS.panel)).toThrow(
      /trace_path_not_found/
    )
  })

  it('pages through the whole text by lines', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
    const p = pageOf(text, 'text', 10, { lines: 5, bytes: 10_000 })
    expect(p.lines).toEqual(['line 10', 'line 11', 'line 12', 'line 13', 'line 14'])
    expect(p.next).toBe(15)
    expect(p.total).toBe(30)
  })
})

describe('what changed between two values', () => {
  it('groups changes over the elements of a list and sums them up', () => {
    const before = JSON.stringify({
      items: Array.from({ length: 50 }, (_, i) => ({ id: i, amount: String(i) })),
    })
    const after = JSON.stringify({
      items: Array.from({ length: 50 }, (_, i) => ({ id: i, amount: i, total: i })),
      done: true,
    })
    const d = diffValues(before, 'json', after, 'json')
    expect(d.changes).toContainEqual(
      expect.objectContaining({
        path: '$.items[*].amount',
        kind: 'type',
        before: 'string',
        after: 'number',
        count: 50,
      })
    )
    expect(d.changes).toContainEqual(expect.objectContaining({ path: '$.done', kind: 'added' }))
    expect(d.summary).toMatch(/2 added/)
    expect(d.summary).toMatch(/1 changed type/)
  })

  it('says what a single value was rather than how much of it stayed', () => {
    const d = diffValues('2', 'json', '5', 'json')
    expect(d.summary).toBe('was 2')
    expect(d.changes).toEqual([
      expect.objectContaining({ path: '$', kind: 'value', before: '2', after: '5' }),
    ])
    expect(diffValues('"2"', 'json', '2', 'json').summary).toBe('was "2" (string)')
    expect(diffValues('<total>2</total>', 'xml', '<total>5</total>', 'xml').summary).toBe('was "2"')
  })

  it('says nothing changed when nothing did', () => {
    expect(diffValues(contract, 'json', contract, 'json').summary).toBe('The same')
  })
})

describe('finding a value', () => {
  it('lists every leaf with its path and type', () => {
    const leaves = leavesOf(contract, 'json')
    expect(leaves).toContainEqual({ path: '$.items[0].id', type: 'string', value: 'i-1' })
    expect(leaves).toContainEqual({ path: '$.owner.name', type: 'string', value: 'Sample Owner' })
  })

  it('finds a value, a number written as a string when asked to be loose, and a key', () => {
    expect(findIn(contract, 'json', { value: 'i-2' })).toEqual(['$.items[1].id'])
    expect(findIn(contract, 'json', { value: 7 })).toEqual([])
    expect(findIn(contract, 'json', { value: 7, loose: true })).toEqual(['$.items[1].amount'])
    expect(findIn(contract, 'json', { key: 'name' })).toEqual(['$.owner.name'])
    expect(findIn('<a>C-100</a>', 'xml', { value: 'C-100' })).toEqual(['text'])
  })
})

describe('the whole text, page by page', () => {
  it('lays out XML written on one line an element a line', () => {
    const p = pageOf(
      '<?xml version="1.0"?><doc><item a="1">one</item><item/><n><m>x</m></n></doc>',
      'xml',
      0,
      TRACE_CAPS.panel
    )
    expect(p.lines).toEqual([
      '<?xml version="1.0"?>',
      '<doc>',
      '  <item a="1">one</item>',
      '  <item/>',
      '  <n>',
      '    <m>x</m>',
      '  </n>',
      '</doc>',
    ])
  })

  it('cuts a line too long for any screen into pieces', () => {
    const p = pageOf('y'.repeat(5000), 'text', 0, { lines: 10, bytes: 100_000 })
    expect(p.lines.map((l) => l.length)).toEqual([2000, 2000, 1000])
  })
})

describe('values no one would write by hand', () => {
  it('reads deeply nested or broken XML quickly', () => {
    const deep = '<a>'.repeat(50_000) + 'x' + '</a>'.repeat(50_000)
    const broken = '<!--'.repeat(20_000) + '<' + 'b'.repeat(100_000)
    const started = Date.now()
    expect(pageOf(deep, 'xml', 0, TRACE_CAPS.panel).lines[100]).toMatch(/^ {64}<a>$/)
    shapeOf(deep, 'xml')
    leavesOf(deep, 'xml')
    pageOf(broken, 'xml', 0, TRACE_CAPS.panel)
    shapeOf(broken, 'xml')
    briefOf(broken, 'xml')
    const opens = '<'.repeat(1_000_000) + '>'
    pageOf(opens, 'xml', 0, TRACE_CAPS.panel)
    shapeOf(opens, 'xml')
    briefOf(opens, 'xml')
    expect(Date.now() - started).toBeLessThan(2000)
  })
})
