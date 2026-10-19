import { expect, it } from 'vitest'
import { LspStatusSchema } from '../src/lsp.js'

const row = { language: 'rust', server: null, version: null, found: false }

it('accepts an optional string diagnostic without weakening strict status validation', () => {
  const diagnostic = 'rust-analyzer component unavailable; run rustup component add rust-analyzer'
  expect(LspStatusSchema.parse([row])).toEqual([row])
  expect(LspStatusSchema.parse([{ ...row, diagnostic }])).toEqual([{ ...row, diagnostic }])
  expect(LspStatusSchema.safeParse([{ ...row, diagnostic: 42 }]).success).toBe(false)
  expect(LspStatusSchema.safeParse([{ ...row, unexpected: 'field' }]).success).toBe(false)
})
