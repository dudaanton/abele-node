import { it, expect } from 'vitest'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { managedBashOperations } from '../packages/provider-pi/dist/processes.js'
import { systemProcessProbe, type ProcessIdentity } from '@abele/provider-claude'
import { processScenarioDeadline, withProcessDeadline } from '../scripts/process-test-budget.mjs'
it.each(['execute', 'abort'])(
  'holds a shell behind durable group registration before %s and confirms reaping before release',
  async (mode) => {
    const dir = mkdtempSync(join(tmpdir(), 'abele-pi-claim-')),
      controller = new AbortController()
    let admitted!: () => void,
      ready!: () => void,
      proof!: ProcessIdentity,
      released = false
    const registered = new Promise<void>((r) => (ready = r)),
      commit = new Promise<void>((r) => (admitted = r))
    const ops = managedBashOperations(
      {
        claim: async (p) => {
          proof = p
          ready()
          await commit
        },
        reaped: async (p) => {
          expect(p).toEqual(proof)
          expect(systemProcessProbe.groupMembers(p)).toEqual([])
          released = true
        },
      },
      controller.signal
    )
    const run = ops.exec('printf admitted > marker', dir, { onData: () => {} })
    // Attach rejection before cancellation so the fake does not create unhandled errors.
    const outcome = run.then(
      (result) => ({ result }),
      (error) => ({ error: error.message })
    )
    try {
      await withProcessDeadline(
        () =>
          Promise.race([
            registered,
            outcome.then((result) => {
              throw new Error('anchor did not become ready: ' + JSON.stringify(result))
            }),
          ]),
        'bash anchor registration'
      )
      expect(existsSync(join(dir, 'marker'))).toBe(false)
      expect(systemProcessProbe.identity(proof.pid)).toBeTruthy()
      if (mode === 'abort') controller.abort()
      admitted()
      const result = await outcome
      if (mode === 'execute') {
        expect(result).toMatchObject({ result: { exitCode: 0 } })
        expect(readFileSync(join(dir, 'marker'), 'utf8')).toBe('admitted')
      } else {
        expect(result).toMatchObject({ error: 'aborted' })
        expect(existsSync(join(dir, 'marker'))).toBe(false)
      }
      expect(released).toBe(true)
    } finally {
      controller.abort()
      admitted()
      await outcome
      rmSync(dir, { recursive: true, force: true })
    }
  },
  processScenarioDeadline(4)
)
