import { expect, it } from 'vitest'
import { pinnedSchemas } from '../packages/provider-codex/src/schema.js'
it('selects the reviewed 0.162.1 closure separately from 0.160.1', () => {
  expect(Object.keys(pinnedSchemas(false, '0.162.1').files)).toHaveLength(743)
  expect(Object.keys(pinnedSchemas(true, '0.162.1').files)).toHaveLength(888)
  expect(pinnedSchemas(false, '0.162.1').files['v2/Turn.ts']).not.toBe(
    pinnedSchemas().files['v2/Turn.ts']
  )
})
it('pins result and approval-response contracts as well as request/notification parameter closures', () => {
  for (const experimental of [false, true]) {
    const pins = pinnedSchemas(experimental)
    for (const file of [
      'v2/ThreadStartResponse.ts',
      'v2/ThreadResumeResponse.ts',
      'v2/ModelListResponse.ts',
      'v2/ConfigReadResponse.ts',
      'v2/ToolRequestUserInputResponse.ts',
    ])
      expect(pins.files[file], file).toMatch(/^[a-f0-9]{64}$/)
  }
})
