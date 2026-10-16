// One long-lived pi SDK session, run under a session host that outlives the daemon. Messages are
// JSON lines: the daemon's on stdin, ours on stdout. Nothing else may write to stdout, so console
// output from the SDK or an extension goes to stderr.
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { descendants } from '@abele/provider-claude'
import { LiveParentMessageSchema, LiveConfigurationSchema } from './wire.js'
import type { PiEvent } from './host.js'
import { managedBashOperations } from './processes.js'
import { createWorkerCore } from './worker-core.js'
import { PiLiveController, type PiLiveHost } from './live-control.js'
process.umask(0o077)
const write = process.stdout.write.bind(process.stdout)
process.stdout.write = ((chunk: any, ...rest: any[]) =>
  (process.stderr.write as any)(chunk, ...rest)) as typeof process.stdout.write
const abort = new AbortController()
let open = true
function send(message: any): void {
  if (!open) throw new Error('pi_parent_lost')
  const line = JSON.stringify(message)
  if (Buffer.byteLength(line) > 1024 * 1024) throw new Error('pi_output_limit')
  write(line + '\n')
}
const core = createWorkerCore(send, abort.signal, () => open)
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let host: (PiLiveHost & { dispose(): Promise<void> }) | undefined
let controller: PiLiveController | undefined
const early: any[] = []
function emit(event: PiEvent) {
  try {
    controller?.observe(event)
  } catch {}
  send({ kind: 'event', event })
}
let stopping = false
async function stop(code = 1) {
  if (stopping) return
  stopping = true
  abort.abort()
  core.release()
  clearInterval(inventory)
  // A hung SDK abort must not prevent independent group cleanup.
  await Promise.race([
    (async () => {
      try {
        await host?.abort()
        await host?.dispose()
      } catch {}
    })(),
    delay(500),
  ])
  for (;;) {
    try {
      await core.cleanupOwned()
      break
    } catch {
      await delay(1000)
    } // retain the anchors for restart/operator recovery
  }
  process.exit(code)
}
process.once('SIGTERM', () => void stop())
process.once('SIGINT', () => void stop())
const inventory = setInterval(() => {
  try {
    for (const p of descendants(process.pid)) core.owned.set(p.pid, p)
  } catch {
    void stop()
  }
}, 250)
async function handle(raw: unknown) {
  const m = LiveParentMessageSchema.parse(raw)
  if (m.kind === 'stop') return stop(0)
  if (m.kind === 'attached') return core.resync()
  if (core.handle(m, stopping)) return
  if (!controller) return void early.push(m)
  if (m.kind === 'input') controller.send({ input_id: m.input_id, text: m.text })
  else if (m.kind === 'interrupt') await controller.interrupt()
  else if (m.kind === 'control')
    try {
      send({
        kind: 'control_result',
        id: m.id,
        ok: true,
        result: await controller.control(m.subtype, m.params),
      })
    } catch (error) {
      send({
        kind: 'control_result',
        id: m.id,
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 200) : 'control_failed',
      })
    }
}
let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (data: string) => {
  buffer += data
  if (buffer.length > 8 * 1024 * 1024) return void stop()
  let nl: number
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl)
    buffer = buffer.slice(nl + 1)
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return void stop()
    }
    void handle(message).catch(() => void stop())
  }
})
// The host is gone: nobody can see or stop this session any more.
process.stdin.once('end', () => {
  open = false
  void stop()
})
void (async () => {
  try {
    const config = LiveConfigurationSchema.parse(JSON.parse(readFileSync(process.argv[2]!, 'utf8')))
    const module = await import(pathToFileURL(config.hostModule).href)
    host = await module.createHost(config.config, core.ask, abort.signal, emit, {
      ...(config.config.debugger_tools?.length
        ? {
            debugger: {
              tools: config.config.debugger_tools,
              call: core.debuggerCall,
              publish: (_args: unknown, result: any) => result,
              close() {},
            },
          }
        : {}),
      bashOperations: (shellPath?: string) =>
        managedBashOperations(core.groups, abort.signal, shellPath),
    })
    controller = new PiLiveController(host!, emit)
    send({ kind: 'ready' })
    controller.announce()
    for (const m of early.splice(0)) await handle(m)
  } catch (error) {
    try {
      send({
        kind: 'failed',
        reason: abort.signal.aborted
          ? 'pi_aborted'
          : error instanceof Error && /^pi_[a-z_]+$/.test(error.message)
            ? error.message
            : 'pi_host_failed',
      })
    } catch {}
    void stop()
  }
})()
