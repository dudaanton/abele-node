import { it, expect, vi } from 'vitest'
const ps = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawnSync: ps }))
import { systemProcessProbe } from '@abele/provider-claude'

it.each([0, 1])('requires kernel ESRCH to confirm an empty ps result with exit %s', (status) => {
  ps.mockReturnValue({ status, stdout: '' })
  const kill = vi.spyOn(process, 'kill')
  try {
    kill.mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    })
    expect(systemProcessProbe.identity(99999999)).toBeUndefined()
    kill.mockImplementation(() => true)
    expect(() => systemProcessProbe.identity(99999999)).toThrow('process_probe_unavailable')
    kill.mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' })
    })
    expect(() => systemProcessProbe.identity(99999999)).toThrow('process_probe_unavailable')
  } finally {
    kill.mockRestore()
  }
})
