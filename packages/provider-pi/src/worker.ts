import { pathToFileURL } from 'node:url'
import { systemProcessProbe, descendants } from '@abele/provider-claude'
import { ParentMessageSchema } from './wire.js'
import type { PiEvent, PiTurnResult } from './host.js'
import { managedBashOperations } from './processes.js'
import { createWorkerCore } from './worker-core.js'
process.umask(0o077)
const abort = new AbortController()
const core = createWorkerCore(send, abort.signal, () => !!process.connected)
const { owned, groups, ask, debuggerCall } = core
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let host:
  | {
      prompt(text: string): Promise<PiTurnResult>
      completionResult(result: PiTurnResult): PiTurnResult
      abort(): Promise<void>
      dispose(): Promise<void>
    }
  | undefined
let started = false,
  output = 0,
  unacked = 0
function send(message: any): void {
  if (!process.connected) throw new Error('pi_parent_lost')
  process.send!(message, (error) => {
    if (error) void stop()
  })
}
function emit(event: PiEvent) {
  const message = { kind: 'event', event }
  const bytes = Buffer.byteLength(JSON.stringify(message))
  output += bytes
  unacked += bytes
  if (bytes > 1024 * 1024 || output > 16 * 1024 * 1024 || unacked > 2 * 1024 * 1024) {
    void stop()
    throw new Error('pi_output_limit')
  }
  send(message)
}
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  abort.abort()
  core.release()
  clearInterval(inventory)
  // A hung SDK abort must not prevent independent group cleanup. Never exit
  // merely because a timer fired: that would abandon live descendants.
  await Promise.race([
    (async () => {
      try {
        await host?.abort()
        await host?.dispose()
      } catch {}
    })(),
    delay(200),
  ])
  for (;;) {
    try {
      await core.cleanupOwned()
      break
    } catch {
      await delay(1000)
    } // retain the anchors for restart/operator recovery
  }
  process.exit(1)
}
process.once('disconnect', () => {
  void stop()
})
process.once('SIGTERM', () => {
  void stop()
})
process.once('SIGINT', () => {
  void stop()
})
const inventory = setInterval(() => {
  try {
    const evidence = descendants(process.pid)
    for (const p of evidence) owned.set(p.pid, p)
    send({ kind: 'inventory', evidence })
  } catch {
    void stop()
  }
}, 250)
process.on('message', (raw) => {
  void (async () => {
    const m = ParentMessageSchema.parse(raw)
    if (m.kind === 'stop') return stop()
    if (m.kind === 'ack') {
      unacked = Math.max(0, unacked - m.bytes)
      return
    }
    if (core.handle(m, stopping) || m.kind !== 'start') return
    if (started) throw new Error('duplicate_pi_start')
    started = true
    let result: any, reason: string | undefined
    try {
      const module = await import(pathToFileURL(m.hostModule).href)
      host = await module.createHost(m.config, ask, abort.signal, emit, {
        ...(m.config.debugger_tools?.length
          ? {
              debugger: {
                tools: m.config.debugger_tools,
                call: debuggerCall,
                publish: (_args: unknown, result: any) => result,
                close() {},
              },
            }
          : {}),
        bashOperations: (shellPath?: string) =>
          managedBashOperations(groups, abort.signal, shellPath),
      })
      result = await host!.prompt(m.text)
      if (abort.signal.aborted) reason = 'pi_aborted'
      await host!.dispose()
      // Session shutdown hooks can fail through onError while dispose resolves.
      // Read accumulated errors at the last lifecycle boundary, before done.
      result = host!.completionResult(result)
    } catch {
      reason = abort.signal.aborted ? 'pi_aborted' : 'pi_host_failed'
    }
    clearInterval(inventory)
    try {
      await core.cleanupOwned()
    } catch {
      return stop()
    }
    send({ kind: 'done', ...(result ? { result } : {}), ...(reason ? { reason } : {}) })
    // The daemon owns group escalation and cleanup, including descendants created by extensions.
    process.disconnect()
    process.exit(0)
  })().catch(() => {
    void stop()
  })
})
const identity = systemProcessProbe.identity(process.pid)
if (!identity || identity.group !== process.pid) process.exit(1)
owned.set(identity.pid, identity)
send({ kind: 'ready', evidence: identity })
