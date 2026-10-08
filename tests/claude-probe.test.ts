import { it, expect, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import {
  identity,
  groupMembers,
  ProcessSupervisor,
} from '../packages/provider-claude/src/supervisor.js'
const failure = vi.hoisted(() => ({
  active: false,
  timeout: false,
  output: undefined as string | undefined,
}))
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>()
  return {
    ...real,
    spawnSync: vi.fn((...args: Parameters<typeof real.spawnSync>) => {
      if (failure.active && args[0] === '/bin/ps')
        return {
          pid: 0,
          output: [],
          stdout: failure.output ?? '',
          stderr: 'probe failed',
          status: failure.output !== undefined ? 0 : failure.timeout ? null : 2,
          signal: null,
          error: failure.timeout
            ? Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })
            : undefined,
        }
      return (real.spawnSync as Function)(...args)
    }),
  }
})
it('failed and timed-out ps identity probes are unknown, never evidence of absence', () => {
  try {
    for (const timeout of [false, true]) {
      failure.active = true
      failure.timeout = timeout
      expect(() => identity(process.pid)).toThrow(/process_probe_unavailable/)
    }
  } finally {
    failure.active = false
    failure.timeout = false
  }
  expect(spawnSync).toHaveBeenCalled()
})
it('requires affirmative zombie state, not a failed probe or an EPERM signal', () => {
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
  })
  try {
    failure.active = true
    failure.output = '12345 Z Thu Oct  8 13:00:00 2026\n'
    expect(identity(12345)).toBeUndefined()
    expect(kill).not.toHaveBeenCalled()
    failure.output = '12345 S Thu Oct  8 13:00:00 2026\n'
    expect(identity(12345)).toEqual({
      pid: 12345,
      group: 12345,
      fingerprint: 'Thu Oct  8 13:00:00 2026',
    })
    failure.output = '12345 invalid Thu Oct  8 13:00:00 2026\n'
    expect(() => identity(12345)).toThrow('process_probe_unavailable')
    failure.output = ''
    expect(() => identity(12345)).toThrow('process_probe_unavailable')
  } finally {
    failure.active = false
    failure.output = undefined
    kill.mockRestore()
  }
})
it('a reused zombie leader cannot authorize signals to a different group incarnation', () => {
  try {
    failure.active = true
    failure.output = '12345 Z Thu Oct  8 13:00:01 2026\n'
    expect(() =>
      groupMembers({ pid: 12345, group: 12345, fingerprint: 'Thu Oct  8 13:00:00 2026' })
    ).toThrow('process_identity_changed')
  } finally {
    failure.active = false
    failure.output = undefined
  }
})
it('cleanup fails closed when an injected identity probe cannot confirm a process is gone', async () => {
  const evidence = { pid: 99999999, group: 99999998, fingerprint: 'test' }
  await expect(
    ProcessSupervisor.cleanup([evidence], 0, {
      identity: () => {
        throw new Error('process_probe_unavailable')
      },
      groupMembers: () => [],
    })
  ).rejects.toThrow(/process_probe_unavailable/)
})
