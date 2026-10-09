import { it, expect, vi } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { ProcessSupervisor, systemProcessProbe } from '@abele/provider-claude'
import { processScenarioDeadline, processStepDeadlineMs } from '../scripts/process-test-budget.mjs'

it.each(['delayed exit', 'temporary probe failure', 'persistent live', 'persistent probe failure'])(
  'confirms only positive absence after SIGKILL: %s',
  async (mode) => {
    vi.useFakeTimers()
    const leader = { pid: 99999999, group: 99999999, fingerprint: 'owned' }
    let killedAt: number | undefined
    const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
      if (signal === 'SIGKILL') killedAt = Date.now()
      return true
    })
    const identity = () => {
      if (killedAt === undefined) return leader
      const elapsed = Date.now() - killedAt
      if (
        mode === 'persistent probe failure' ||
        (mode === 'temporary probe failure' && elapsed < 700)
      )
        throw new Error('process_probe_unavailable')
      return mode === 'persistent live' || elapsed < 700 ? leader : undefined
    }
    try {
      const cleanup = ProcessSupervisor.cleanup([leader], 10, {
        identity,
        groupMembers: () => {
          const member = identity()
          return member ? [member] : []
        },
      })
      const assertion =
        mode === 'persistent live'
          ? expect(cleanup).rejects.toThrow('process_cleanup_unconfirmed')
          : mode === 'persistent probe failure'
            ? expect(cleanup).rejects.toThrow('process_probe_unavailable')
            : expect(cleanup).resolves.toBeUndefined()
      await vi.runAllTimersAsync()
      await assertion
      expect(kill).toHaveBeenCalledWith(-leader.group, 'SIGKILL')
    } finally {
      kill.mockRestore()
      vi.useRealTimers()
    }
  }
)

it.each([false, true])(
  'cleans a zombie group leader without abandoning its live members (member: %s)',
  async (withMember) => {
    const child = spawn(
      process.execPath,
      [
        '-e',
        `const { spawn } = require('node:child_process');
         const member = ${withMember} ? spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }) : undefined;
         process.send({ member: member?.pid });
         setInterval(() => {}, 1000);`,
      ],
      { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
    )
    const exited = once(child, 'exit')
    let member: number | undefined
    try {
      const [ready] = await once(child, 'message')
      member = ready.member
      const leader = systemProcessProbe.identity(child.pid!)!
      expect(leader.group).toBe(child.pid)
      const memberProof = member ? systemProcessProbe.identity(member) : undefined
      if (member) expect(memberProof?.group).toBe(leader.group)
      child.kill('SIGKILL')
      // Keep this parent's event loop blocked: libuv cannot waitpid/reap the
      // child before cleanup's first synchronous inventory/signalling pass.
      const deadline = Date.now() + processStepDeadlineMs
      let zombie = false
      while (Date.now() < deadline) {
        const result = spawnSync('/bin/ps', ['-p', String(child.pid), '-o', 'stat='], {
          encoding: 'utf8',
        })
        if (result.stdout.trim().startsWith('Z')) {
          zombie = true
          break
        }
      }
      expect(zombie).toBe(true)
      await ProcessSupervisor.cleanup([leader], 10)
      expect(systemProcessProbe.identity(child.pid!)).toBeUndefined()
      if (member) expect(systemProcessProbe.identity(member)).toBeUndefined()
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      if (member) {
        try {
          process.kill(member, 'SIGKILL')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        }
      }
      await exited
    }
  },
  processScenarioDeadline(4)
)

it.each([true, false])(
  'reprobes an EPERM when the target exits between identity and signal (group: %s)',
  async (group) => {
    const target = { pid: 99999999, group: group ? 99999999 : 99999998, fingerprint: 'owned' }
    let gone = false
    const members = vi.fn(() => (gone ? [] : [target]))
    const identity = vi.fn(() => (gone ? undefined : target))
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      gone = true
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    })
    try {
      await expect(
        ProcessSupervisor.cleanup([target], 0, { identity, groupMembers: members })
      ).resolves.toBeUndefined()
      expect(kill).toHaveBeenCalledExactlyOnceWith(group ? -target.group : target.pid, 'SIGTERM')
      if (group) expect(members.mock.results[1]?.value).toEqual([])
      else expect(identity.mock.results[1]?.value).toBeUndefined()
    } finally {
      kill.mockRestore()
    }
  }
)

it.each(['live', 'process_inventory_unavailable', 'process_identity_changed'])(
  'never confirms cleanup after EPERM when the fresh group probe is %s',
  async (mode) => {
    const leader = { pid: 99999999, group: 99999999, fingerprint: 'owned' }
    let attempted = false
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      attempted = true
      throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' })
    })
    try {
      const cleanup = ProcessSupervisor.cleanup([leader], 0, {
        identity: () => leader,
        groupMembers: () => {
          if (attempted && mode !== 'live') throw new Error(mode)
          return [leader]
        },
      })
      if (mode === 'live') await expect(cleanup).rejects.toMatchObject({ code: 'EPERM' })
      else await expect(cleanup).rejects.toThrow(mode)
      expect(kill).toHaveBeenCalledExactlyOnceWith(-leader.group, 'SIGTERM')
    } finally {
      kill.mockRestore()
    }
  }
)
