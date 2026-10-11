import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  OwnedDebugProcess,
  processStartIdentity,
} from '../../packages/node-core/src/debugger/process.js'

describe('node-owned debugger processes', () => {
  it('records OS ownership evidence and proves owned termination', async () => {
    const child = await OwnedDebugProcess.spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {}
    )
    expect(child.evidence.pid).toBe(child.pid)
    expect(child.evidence.executable_sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(child.evidence.start_identity).toBe(await processStartIdentity(child.pid))
    await child.terminate()
    expect(child.alive).toBe(false)
    await child.terminate()
  })
  it('refuses signals after a PID identity mismatch and still allows verified cleanup', async () => {
    let mismatch = false
    const child = await OwnedDebugProcess.spawn(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {},
      async (pid) => (mismatch ? 'reused' : processStartIdentity(pid))
    )
    try {
      mismatch = true
      await expect(child.terminate()).rejects.toThrow('pid_reused')
      expect(child.alive).toBe(true)
    } finally {
      mismatch = false
      await child.terminate()
    }
  })
  it('uses argv/env without a shell; handles failed spawn and early exit without leftover processes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dap-process-'))
    try {
      const child = await OwnedDebugProcess.spawn(
        process.execPath,
        ['-e', 'process.stdout.write(process.env.TEST); setInterval(()=>{},1000)'],
        { cwd: dir, env: { TEST: '; echo injected' } }
      )
      expect(await child.waitForText(/; echo injected/, 2000)).toBeDefined()
      await child.terminate()
      await expect(OwnedDebugProcess.spawn(join(dir, 'absent'), [], {})).rejects.toThrow()
      const short = await OwnedDebugProcess.spawn(process.execPath, ['-e', ''], {})
      await short.waitForExit(2000)
      await short.terminate()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
