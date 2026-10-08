// Only fake Node processes: no adapter, provider, Claude executable or shared resource.
import { spawn } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Dap } from '../debug-dap.mjs'
const fixture = fileURLToPath(import.meta.url)
const [mode, scenario, directory] = process.argv.slice(2)
if (mode === 'grandchild') {
  process.on('SIGTERM', () => {}) // exercise bounded SIGKILL escalation
  console.log(JSON.stringify({ grandchildPid: process.pid }))
  setInterval(() => {}, 1000)
} else if (mode === 'leader') {
  const grandchild = spawn(process.execPath, [fixture, 'grandchild'], {
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  grandchild.stdout.once('data', (b) => {
    process.stdout.write(b)
    if (scenario === 'leader-exits') process.exit(0)
  })
} else {
  const { ProbeRuntime } = await import('../debug-runtime.mjs')
  const runtime = new ProbeRuntime()
  const dap = runtime.trackDap(new Dap(new PassThrough(), new PassThrough(), { timeout: 60000 }))
  const pending = dap.request('never')
  // Observe this request immediately, including cleanup rejection.
  void pending.catch(() => {})
  const child = runtime.start(process.execPath, [fixture, 'leader', scenario])
  console.log(`STARTED ${child.pid}`)
  while (!child.text.includes('grandchildPid')) await runtime.pause(10)
  console.log(child.text.trim())
  try {
    if (scenario === 'save-fails') throw new Error('synthetic probe failure')
    await runtime.pause(60000)
  } catch (error) {
    if (!runtime.signal.aborted) process.exitCode = 1
  } finally {
    try {
      await runtime.finish(() =>
        writeFile(
          scenario === 'save-fails' ? directory : `${directory}/saved.json`,
          JSON.stringify({ pending: dap.pending.size, aborted: runtime.signal.aborted })
        )
      )
    } catch (error) {
      console.error(error.message)
      process.exitCode = 1
    }
  }
}
