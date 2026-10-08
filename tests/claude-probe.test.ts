import { it, expect, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { identity, ProcessSupervisor } from '../packages/provider-claude/src/supervisor.js'
const failure = vi.hoisted(() => ({ active: false, timeout: false }))
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>()
  return {
    ...real,
    spawnSync: vi.fn((...args: Parameters<typeof real.spawnSync>) => {
      if (failure.active && args[0] === '/bin/ps')
        return {
          pid: 0,
          output: [],
          stdout: '',
          stderr: 'probe failed',
          status: failure.timeout ? null : 2,
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
  }
  expect(spawnSync).toHaveBeenCalled()
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
