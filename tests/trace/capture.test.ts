import { createHash } from 'node:crypto'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import {
  captureChunk,
  captureEnd,
  captureStart,
  decode,
  parseTake,
  readChunk,
  readLength,
  unquote,
} from '../../packages/node-core/src/trace/capture.js'

/** Runs the expressions the way an adapter would in the paused program, quoting string results. */
function takeWhole(
  context: Record<string, unknown>,
  expression: string,
  chars?: number,
  bare = false
) {
  const sandbox = bare ? { ...context } : { ...context, Buffer }
  const evaluate = (e: string) => `'${String(runInNewContext(e, sandbox))}'`
  const length = readLength(evaluate(captureStart(expression, 'k1')))
  let text = ''
  for (let at = 0; at < length;) {
    const chunk = readChunk(evaluate(captureChunk('k1', at, chars)), at)
    text += chunk.text
    at = chunk.end
  }
  expect(unquote(evaluate(captureEnd('k1')))).toBe('ok')
  expect(runInNewContext('Object.keys(globalThis.__abeleTrace)', sandbox)).toEqual([])
  return decode(text)
}

describe('taking a value whole from the paused program', () => {
  it('keeps a long string exactly, across chunk borders and multi-byte characters', () => {
    const xml = `<?xml version="1.0"?><doc>${'é𝄞x'.repeat(200_000)}</doc>`
    const taken = takeWhole({ xmlText: xml }, 'xmlText', 1000)
    expect(taken.string).toBe(true)
    expect(createHash('sha256').update(taken.text).digest('hex')).toBe(
      createHash('sha256').update(xml).digest('hex')
    )
  })

  it('reads a value in a realm with neither Buffer nor btoa', () => {
    const text = 'plain é𝄞 ' + 'ab'.repeat(5000)
    const taken = takeWhole({ text }, 'text', 777, true)
    expect(taken.text).toBe(text)
  })

  it('takes five megabytes in one piece', () => {
    const big = {
      rows: Array.from({ length: 100_000 }, (_, i) => ({ id: `row-${i}`, n: i * 1.5 })),
    }
    const taken = takeWhole({ big }, 'big')
    expect(taken.text.length).toBeGreaterThan(3_000_000)
    expect(JSON.parse(taken.text)).toEqual(JSON.parse(JSON.stringify(big)))
  })

  it('keeps what JSON loses: cycles, maps, sets, buffers, dates, classes, undefined, functions', () => {
    const value = runInNewContext(
      `
      class Contract { constructor() { this.id = 'C-1' } }
      const c = new Contract()
      c.self = c
      ;({
        contract: c,
        when: new Date('2026-01-02T03:04:05.000Z'),
        index: new Map([['a', 1]]),
        tags: new Set(['x']),
        nothing: undefined,
        run: function go() {},
        bytes: Buffer.from('hi'),
        list: [c, 2],
      })`,
      { Buffer }
    )
    const taken = JSON.parse(takeWhole({ value }, 'value').text)
    expect(taken.contract).toEqual({ '@class': 'Contract', id: 'C-1', self: '[Circular]' })
    expect(taken.when).toBe('2026-01-02T03:04:05.000Z')
    expect(taken.index).toEqual({ '[Map]': [['a', 1]] })
    expect(taken.tags).toEqual({ '[Set]': ['x'] })
    expect(taken.nothing).toBe('[undefined]')
    expect(taken.run).toBe('[Function go]')
    expect(taken.bytes).toEqual({ '[Buffer]': 2, base64: 'aGk=' })
    // A value met twice but not inside itself is written out both times.
    expect(taken.list[0]).toMatchObject({ id: 'C-1' })
  })

  it('names a take by what follows as, or by the expression itself', () => {
    expect(parseTake('ctx.request.id as requestId')).toEqual({
      expression: 'ctx.request.id',
      name: 'requestId',
    })
    expect(parseTake('result')).toEqual({ expression: 'result', name: 'result' })
  })

  it('refuses a chunk an adapter has changed', () => {
    expect(() => readChunk('"12:not base64!"', 0)).toThrow(/trace_capture_invalid/)
    expect(() => readLength('"undefined"')).toThrow(/trace_capture_invalid/)
  })
})
