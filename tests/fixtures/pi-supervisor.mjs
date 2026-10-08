// Minimal fake daemon around the real adapter/process IPC; no SDK/inference.
import { writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { PiProviderAdapter } from '../../packages/provider-pi/dist/index.js'
const cwd = process.argv[2]
const processes = new Map()
const persist = () =>
  writeFileSync(cwd + '/processes.json', JSON.stringify([...processes.values()]))
const adapter = new PiProviderAdapter({ stateDir: cwd, profile: 'isolated', deadlineMs: 15000 })
const run = await adapter.startTurn(
  { session_id: randomUUID(), run_id: randomUUID(), cwd, text: process.argv[3] ?? 'descendants' },
  {
    event: () => {},
    processes: (evidence) => {
      for (const p of evidence) processes.set(p.pid, p)
      persist()
    },
    reaped: (leader) => {
      for (const [pid, p] of processes) if (p.group === leader.group) processes.delete(pid)
      persist()
    },
    permission: async () => ({ choice: 'allow', delivered: () => true }),
  }
)
process.once('SIGTERM', () => {
  void run.interrupt().finally(() => process.exit(0))
})
await run.done
