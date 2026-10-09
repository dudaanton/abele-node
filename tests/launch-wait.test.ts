import { expect, it, vi } from 'vitest'
const ps = vi.hoisted(() => vi.fn())
vi.mock('node:child_process', () => ({ spawnSync: ps }))
import {
  daemonProcessPresent,
  processAbsent,
  waitForLaunch,
} from '../packages/node-daemon/src/launch-wait.js'

it('recognizes only the recorded daemon entry and state, and detects PID reuse', () => {
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
  try {
    const entry = '/release/packages/node-daemon/dist/cli.js',
      state = '/state with spaces'
    ps.mockReturnValue({
      status: 0,
      stdout: `node ${entry} start --state-dir ${state} --port 7777`,
    })
    expect(daemonProcessPresent(1234, entry, state)).toBe(true)
    ps.mockReturnValue({ status: 0, stdout: 'node --test unrelated.test.mjs' })
    expect(daemonProcessPresent(1234, entry, state)).toBe(false)
    ps.mockReturnValue({ status: 0, stdout: `node ${entry} start --state-dir /different-state` })
    expect(daemonProcessPresent(1234, entry, state)).toBe(false)
    ps.mockReturnValue({ status: 0, stdout: `node ${entry} start --state-dir ${state}-other` })
    expect(daemonProcessPresent(1234, entry, state)).toBe(false)
    ps.mockReturnValue({ status: 1, stdout: '' })
    expect(() => daemonProcessPresent(1234, entry, state)).toThrow(
      'daemon_process_ownership_unconfirmed'
    )
    kill.mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    })
    expect(daemonProcessPresent(1234, entry, state)).toBe(false)
  } finally {
    kill.mockRestore()
  }
})

it('waits through transient observations', async () => {
  let polls = 0
  await waitForLaunch(
    () => ++polls === 4,
    () => 'last output',
    2000
  )
  expect(polls).toBe(4)
})

it('reports the last diagnostic at the deadline', async () => {
  await expect(
    waitForLaunch(
      () => false,
      () => 'stopping: last output',
      10
    )
  ).rejects.toThrow('stopping: last output')
})

it('requires positive kernel absence, including when probing is denied', () => {
  const kill = vi.spyOn(process, 'kill')
  try {
    kill.mockImplementation(() => true)
    expect(processAbsent(1234)).toBe(false)
    kill.mockImplementation(() => {
      throw Object.assign(new Error('denied'), { code: 'EPERM' })
    })
    expect(processAbsent(1234)).toBe(false)
    kill.mockImplementation(() => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' })
    })
    expect(processAbsent(1234)).toBe(true)
  } finally {
    kill.mockRestore()
  }
})
