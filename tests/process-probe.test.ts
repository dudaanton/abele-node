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

it('treats a process macOS reports as exiting (state ?E) as still present', () => {
  ps.mockReturnValue({ status: 0, stdout: '29771 ?E   Mon Oct 19 14:07:31 2026    \n' })
  expect(systemProcessProbe.identity(29866)).toEqual({
    pid: 29866,
    group: 29771,
    fingerprint: 'Mon Oct 19 14:07:31 2026',
  })
  ps.mockReturnValue({ status: 0, stdout: '29771 Q   Mon Oct 19 14:07:31 2026\n' })
  expect(() => systemProcessProbe.identity(29866)).toThrow('process_probe_unavailable')
})
