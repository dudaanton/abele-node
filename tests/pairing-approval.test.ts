import { expect, it } from 'vitest'
import { selectPendingPairing } from '../packages/node-daemon/src/paired.js'
import { humanOutput } from '../packages/node-daemon/src/output.js'
const first = {
  installation_id: 'first-id',
  fingerprint: 'a'.repeat(64),
  state: 'pending' as const,
  device_name: 'Test device',
  created_at: 1,
}
it('selects exact pending names or captured IDs, rejects duplicates and unsafe labels', () => {
  const duplicate = { ...first, installation_id: 'second-id' }
  expect(() => selectPendingPairing([first, duplicate], 'Test device')).toThrow(
    'ambiguous_device_name'
  )
  expect(selectPendingPairing([first, duplicate], 'Test device', 'first-id')).toEqual(first)
  expect(() => selectPendingPairing([first], 'test device')).toThrow('pending_device_not_found')
  expect(() => selectPendingPairing([{ ...first, state: 'confirmed' }], 'Test device')).toThrow(
    'pending_device_not_found'
  )
  for (const name of ['bad\u001b[0m', 'bad\u202ename', 'bad\nname'])
    expect(() =>
      selectPendingPairing([{ ...first, device_name: name }], undefined, first.installation_id)
    ).toThrow()
})
it('lists short fingerprints, age and IDs without emitting controls from legacy labels', () => {
  const output = humanOutput(
    ['approve-pair'],
    [{ ...first, device_name: 'bad\u202ename\u001b[0m' }]
  )
  expect(output).toContain('aaaa aaaa')
  expect(output).toContain('first-id')
  expect(output).toContain('ago')
  expect(output).not.toContain('\u202e')
  expect(output).not.toContain('\u001b')
})
it('escapes every remaining C1 control in human labels without changing JSON or stored labels', () => {
  for (let code = 0x80; code <= 0x9f; code++) {
    const control = String.fromCharCode(code)
    const entry = { ...first, device_name: `legacy${control}2J` }
    const before = JSON.stringify(entry)
    expect(humanOutput(['approve-pair'], [entry])).not.toContain(control)
    expect(JSON.stringify(entry)).toBe(before)
  }
})
