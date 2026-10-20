import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TraceStore, TRACE_INLINE_BYTES } from '../../packages/node-core/src/trace/store.js'

const dirs: string[] = []
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'trace-store-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

const started = new Date('2026-01-02T03:04:05.000Z')

describe('a run on disk', () => {
  it('names new runs in local time and preserves the ISO instant', () => {
    const date = new Date('2026-01-02T23:04:05Z')
    date.getFullYear = () => 2026
    date.getMonth = () => 0
    date.getDate = () => 3
    date.getHours = () => 2
    date.getMinutes = () => 4
    date.getSeconds = () => 5
    const store = new TraceStore(scratch())
    const run = store.create({ session: 's', started: date, points: [] })
    expect(run.id).toMatch(/^20260103-020405-/)
    expect(store.read(run.id).run).toMatchObject({
      name: '2026-01-03 02:04:05',
      started_at: '2026-01-02T23:04:05.000Z',
    })
  })

  it('keeps its steps in order and its values whole, small ones in the step', () => {
    const root = scratch()
    const store = new TraceStore(root)
    const run = store.create({ session: 'debug-1', name: 'Sample run', started, points: [] })
    const small = run.value('id', '"C-100"')
    const big = run.value('xml', `<doc>${'x'.repeat(100_000)}</doc>`)
    run.append({ kind: 'probe', label: 'parse', at: 12, values: [small, big] })
    run.append({ kind: 'error', label: 'SampleError', at: 30, values: [] })
    run.close('done', 45)

    const read = store.read(run.id)
    expect(read.run).toMatchObject({
      id: run.id,
      name: 'Sample run',
      state: 'done',
      length_ms: 45,
      steps: 2,
    })
    expect(read.steps.map((s) => [s.id, s.kind])).toEqual([
      ['t0001', 'probe'],
      ['t0002', 'error'],
    ])
    expect(small.inline).toBe('"C-100"')
    expect(big.inline).toBeUndefined()
    expect(big.format).toBe('xml')
    expect(store.text(run.id, read.steps[0]!.values[1]!)).toBe(`<doc>${'x'.repeat(100_000)}</doc>`)
  })

  it('stores one file for the same content taken twice, named by its hash, packed when large', () => {
    const root = scratch()
    const store = new TraceStore(root)
    const run = store.create({ session: 'debug-1', started, points: [] })
    const text = JSON.stringify({ rows: Array.from({ length: 20_000 }, (_, i) => i) })
    const a = run.value('rows', text)
    const b = run.value('again', text)
    expect(a.sha256).toBe(createHash('sha256').update(text).digest('hex'))
    expect(b.sha256).toBe(a.sha256)
    expect(readdirSync(join(root, run.id, 'blobs'))).toEqual([`${a.sha256}.gz`])
    expect(a.bytes).toBe(Buffer.byteLength(text))
    expect(TRACE_INLINE_BYTES).toBeLessThan(text.length)
  })

  it('reads a timeline whose last line was cut by a crash', () => {
    const root = scratch()
    const store = new TraceStore(root)
    const run = store.create({ session: 'debug-1', started, points: [] })
    run.append({ kind: 'probe', label: 'one', at: 1, values: [] })
    appendFileSync(join(root, run.id, 'timeline.jsonl'), '{"id":"t0002","kin')
    expect(store.read(run.id).steps).toHaveLength(1)
    expect(store.list()[0]).toMatchObject({ id: run.id, state: 'recording' })
  })

  it('lists the newest run first, renames and deletes a run with its files', () => {
    const root = scratch()
    const store = new TraceStore(root)
    const first = store.create({ session: 's', started, points: [] })
    first.close('done', 1)
    const second = store.create({
      session: 's',
      started: new Date(started.getTime() + 1000),
      points: [],
    })
    second.close('cut', 2)
    expect(store.list().map((r) => r.id)).toEqual([second.id, first.id])
    store.rename(first.id, 'Named')
    expect(store.read(first.id).run.name).toBe('Named')
    store.delete(first.id)
    expect(existsSync(join(root, first.id))).toBe(false)
    expect(store.list().map((r) => r.id)).toEqual([second.id])
  })

  it('refuses names that would leave its folder', () => {
    const store = new TraceStore(scratch())
    expect(() => store.read('../etc')).toThrow(/trace_run_not_found/)
    expect(() =>
      store.text('x', { name: 'n', format: 'text', bytes: 1, sha256: '../../a' })
    ).toThrow()
  })

  it('keeps marks beside the run', () => {
    const root = scratch()
    const store = new TraceStore(root)
    const run = store.create({ session: 's', started, points: [] })
    run.append({ kind: 'probe', label: 'one', at: 1, values: [] })
    store.mark(run.id, { step: 't0001', name: 'v', path: '$.a', comment: 'look here' })
    expect(store.marks(run.id)).toEqual([
      expect.objectContaining({ step: 't0001', name: 'v', path: '$.a', comment: 'look here' }),
    ])
    expect(readFileSync(join(root, run.id, 'marks.jsonl'), 'utf8')).toContain('look here')
  })
})
