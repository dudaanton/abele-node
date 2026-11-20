import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { ClaudeContext } from '../packages/provider-claude/src/context.js'
import { ClaudeStreamDecoder } from '../packages/provider-claude/src/stream.js'
import { SessionContextSchema } from '../packages/node-protocol/src/live.js'

const metadata = {
  totalTokens: 170000,
  maxTokens: 200000,
  percentage: 85,
  categories: [{ name: 'Messages', tokens: 170000 }],
}
it.each([false, true])('ignores synthetic API errors with a compaction boundary: %s', (compact) => {
  const published: Record<string, unknown>[] = []
  const context = new ClaudeContext((data) => published.push(data))
  const measured = { type: 'assistant', message: { usage: { input_tokens: 7000 } } }
  context.observe(measured)
  if (compact) context.observe({ type: 'system', subtype: 'compact_boundary' })
  const before = context.report(metadata)
  const publications = published.length
  const zero = {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  }
  for (const error of [
    {
      type: 'assistant',
      isApiErrorMessage: true,
      message: { model: '<synthetic>', usage: zero },
    },
    { type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 1 } } },
    { ...measured, isApiErrorMessage: true },
    { type: 'assistant', message: { usage: zero } },
  ]) {
    expect(context.observe(error)).toBe(false)
    expect(context.report(metadata)).toEqual(before)
  }
  expect(published).toHaveLength(publications)
  expect(before.total_tokens).toBe(compact ? null : 7000)
  expect(before.percentage).toBe(compact ? null : 3.5)
  expect(context.observe(measured)).toBe(true)
  expect(context.report(metadata).total_tokens).toBe(7000)
})

it('uses only the latest main assistant input usage across several compactions', () => {
  const context = new ClaudeContext()
  expect(SessionContextSchema.parse(context.report()).total_tokens).toBeNull()
  const records = new ClaudeStreamDecoder().push(
    readFileSync(new URL('./fixtures/claude-context.jsonl', import.meta.url))
  )
  const totals: (number | null)[] = []
  for (const record of records) {
    context.observe(record)
    totals.push(context.report(metadata).total_tokens)
  }
  expect(totals).toEqual([150000, null, 12000, 12000, 12000, null, 9000, 11000, null, 7000])
  expect(context.report(metadata)).toMatchObject({
    total_tokens: 7000,
    max_tokens: 200000,
    percentage: 3.5,
    categories: [],
  })
  expect(SessionContextSchema.parse(context.report(metadata)).total_tokens).toBe(7000)
})
it('ignores invalid usage and counts optional cache counters once', () => {
  const context = new ClaudeContext()
  const assistant = (usage: unknown) => ({
    type: 'assistant',
    message: { usage },
  })
  context.observe(assistant({ input_tokens: 100 }))
  expect(context.report(metadata).total_tokens).toBe(100)
  for (const input_tokens of [-1, NaN, Infinity, '100']) {
    context.observe(assistant({ input_tokens }))
    expect(context.report(metadata).total_tokens).toBe(100)
  }
  for (const cache_creation_input_tokens of [-1, NaN, Infinity, '100']) {
    context.observe(assistant({ input_tokens: 10, cache_creation_input_tokens }))
    expect(context.report(metadata).total_tokens).toBe(100)
  }
  context.observe(
    assistant({ input_tokens: Number.MAX_VALUE, cache_read_input_tokens: Number.MAX_VALUE })
  )
  expect(context.report(metadata).total_tokens).toBe(100)
  context.observe(
    assistant({
      input_tokens: 10,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 5000,
    })
  )
  expect(context.report(metadata).total_tokens).toBe(60)
})
it('publishes current usage while rejecting control replies superseded by compaction', async () => {
  const published: Record<string, unknown>[] = []
  const context = new ClaudeContext((data) => published.push(data))
  const assistant = (input_tokens: number) => ({
    type: 'assistant',
    message: { usage: { input_tokens } },
  })
  context.observe(assistant(150000))
  let resolve!: (value: Record<string, unknown>) => void
  const pending = context.refresh(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  context.observe({ type: 'system', subtype: 'compact_boundary' })
  expect(published.at(-1)?.total_tokens).toBeNull()
  await context.refresh(async () => metadata)
  context.observe(assistant(7000))
  resolve({ ...metadata, maxTokens: 1000000 })
  await pending
  expect(published.at(-1)).toMatchObject({
    total_tokens: 7000,
    max_tokens: 200000,
    percentage: 3.5,
  })
  context.observe({
    type: 'system',
    subtype: 'compact_boundary',
    parent_tool_use_id: 'sample-child',
  })
  expect(context.report().total_tokens).toBe(7000)
  await context.refresh(async () => {
    throw new Error('control unavailable')
  })
  expect(context.report().total_tokens).toBe(7000)
})

it('keeps matching categories and rejects older metadata requests', async () => {
  const context = new ClaudeContext()
  let resolve!: (value: Record<string, unknown>) => void
  const pending = context.refresh(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  context.observe({ type: 'assistant', message: { usage: { input_tokens: 170000 } } })
  await context.refresh(async () => metadata)
  resolve({ ...metadata, maxTokens: 1000000 })
  await pending
  expect(context.report()).toMatchObject({
    total_tokens: 170000,
    max_tokens: 200000,
    categories: metadata.categories,
  })
})
