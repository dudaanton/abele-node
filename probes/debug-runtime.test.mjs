import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { stopGroup } from './debug-runtime.mjs'

test('a group transitioning through EPERM while reaping is awaited until ESRCH', async () => {
  let clock = 0,
    checks = 0
  const signals = []
  await stopGroup(
    { pid: 123, exited: Promise.resolve() },
    {
      kill: (_pid, signal) => {
        if (signal !== 0) {
          signals.push(signal)
          return
        }
        if (++checks === 1) return
        throw Object.assign(new Error('group transition'), {
          code: checks === 2 ? 'EPERM' : 'ESRCH',
        })
      },
      pause: async (ms) => {
        clock += ms
      },
      now: () => clock,
      graceMs: 40,
    }
  )
  assert.deepEqual(signals, ['SIGTERM'])
})

test('persistent group permission denial remains a cleanup failure', async () => {
  let clock = 0
  await assert.rejects(
    stopGroup(
      { pid: 123, exited: Promise.resolve() },
      {
        kill: () => {
          throw Object.assign(new Error('not permitted'), { code: 'EPERM' })
        },
        pause: async (ms) => {
          clock += ms
        },
        now: () => clock,
        graceMs: 40,
      }
    ),
    { code: 'EPERM' }
  )
})

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
async function until(check) {
  for (let i = 0; i < 300; i++) {
    if (check()) return
    await delay(10)
  }
  throw new Error('fake process deadline exceeded')
}
for (const [scenario, signal, expectedCode] of [
  ['signal-int', 'SIGINT', 130],
  ['signal-term', 'SIGTERM', 143],
  ['leader-exits', 'SIGTERM', 143],
  ['save-fails', undefined, 1],
]) {
  test(`probe cleanup: ${scenario}`, { timeout: 10000 }, async () => {
    await mkdir('.scratch', { recursive: true })
    const directory = await mkdtemp(resolve('.scratch/probe-lifecycle-'))
    const runner = spawn(
      process.execPath,
      ['probes/fixtures/debug-runtime.mjs', 'run', scenario, directory],
      {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    let stdout = '',
      stderr = ''
    runner.stdout.on('data', (b) => {
      stdout += b
    })
    runner.stderr.on('data', (b) => {
      stderr += b
    })
    let ownerPid, grandchildPid
    try {
      await until(() => stdout.includes('grandchildPid') || runner.exitCode !== null)
      assert.equal(runner.exitCode, null, stderr)
      ownerPid = Number(/STARTED (\d+)/.exec(stdout)[1])
      grandchildPid = Number(/"grandchildPid":(\d+)/.exec(stdout)[1])
      assert.ok(alive(grandchildPid))
      if (scenario === 'leader-exits') await until(() => !alive(ownerPid))
      if (signal) runner.kill(signal)
      await until(() => runner.exitCode !== null || runner.signalCode !== null)
      assert.equal(runner.exitCode, expectedCode, stderr)
      await until(() => !alive(grandchildPid))
      assert.equal(alive(ownerPid), false)
      if (signal)
        assert.deepEqual(JSON.parse(await readFile(`${directory}/saved.json`, 'utf8')), {
          pending: 0,
          aborted: true,
        })
      else assert.match(stderr, /EISDIR/)
    } finally {
      // The red implementation leaks separate groups. The regression runner must not.
      ownerPid ??= Number(/STARTED (\d+)/.exec(stdout)?.[1])
      for (const pid of [ownerPid, runner.pid])
        if (pid) {
          try {
            process.kill(-pid, 'SIGKILL')
          } catch {}
        }
      if (grandchildPid) {
        try {
          process.kill(grandchildPid, 'SIGKILL')
        } catch {}
      }
      await until(() => runner.exitCode !== null || runner.signalCode !== null)
      await rm(directory, { recursive: true, force: true })
    }
  })
}
