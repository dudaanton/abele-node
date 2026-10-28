// Run after npm run build. Uses exactly the native owner used by the service.
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WatchService } from '../packages/node-core/dist/watch-service.js'

const started = Date.now()
const log = (event) => console.log(JSON.stringify({ ms: Date.now() - started, ...event }))
log({
  kind: 'probe',
  platform: process.platform,
  version: process.version,
  execPath: process.execPath,
})
for (const recursive of [false, true]) {
  const dir = mkdtempSync(join(tmpdir(), 'abele-watch-probe-'))
  const service = new WatchService({ platform: 'darwin', diagnostic: log })
  let error
  const events = []
  const wait = async (check) => {
    const until = Date.now() + 5000
    while (!check()) {
      if (error) throw error
      if (Date.now() >= until) throw new Error('probe_event_deadline')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    if (error) throw error
  }
  try {
    mkdirSync(join(dir, 'nested'))
    log({ kind: 'watch', dir, recursive })
    const handle = service.watch(dir, recursive, (event, name) => {
      events.push(String(name))
      log({ kind: 'event', recursive, event, name: String(name) })
    })
    handle.on('error', (reason) => {
      error = reason
    })
    await wait(() => handle.ready)
    log({ kind: 'ready', recursive })
    writeFileSync(join(dir, recursive ? 'nested/changed' : 'changed'), 'probe\n')
    log({ kind: 'write', recursive })
    await wait(() => events.some((name) => name.endsWith('changed')))
    log({ kind: 'success', recursive })
  } catch (reason) {
    log({ kind: 'failure', recursive, error: String(reason) })
    process.exitCode = 1
  } finally {
    await service.stop()
    log({ kind: 'stopped', recursive })
    rmSync(dir, { recursive: true, force: true })
  }
}
