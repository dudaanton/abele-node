import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  systemProcessProbe,
  descendants,
  ProcessSupervisor,
  type ProcessIdentity,
} from '@abele/provider-claude'
import { ParentMessageSchema } from './wire.js'
import type { Ask, Answer, PiEvent, PiTurnResult } from './host.js'
import { managedBashOperations } from './processes.js'
process.umask(0o077)
const abort = new AbortController()
// Local obligations survive loss of the daemon and its SQLite owner.
const owned = new Map<number, ProcessIdentity>()
const registrations = new Map<string, { resolve(): void; reject(error: Error): void }>()
let groupClaims = 0
async function register(kind: 'process_claim' | 'group_reaped', evidence: ProcessIdentity) {
  if (abort.signal.aborted || !process.connected) throw new Error('pi_parent_lost')
  const id = randomUUID()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      registrations.delete(id)
      reject(new Error('process_registration_deadline'))
    }, 5000)
    registrations.set(id, {
      resolve: () => {
        clearTimeout(timer)
        resolve()
      },
      reject: (error) => {
        clearTimeout(timer)
        reject(error)
      },
    })
    send({ kind, id, evidence })
  })
}
const groups = {
  claim: async (evidence: ProcessIdentity) => {
    if (++groupClaims > 256) throw new Error('pi_process_limit')
    // Register locally BEFORE awaiting the durable daemon acknowledgement.
    owned.set(evidence.pid, evidence)
    await register('process_claim', evidence)
  },
  reaped: async (evidence: ProcessIdentity) => {
    if (!abort.signal.aborted) await register('group_reaped', evidence)
    for (const [pid, member] of owned) if (member.group === evidence.group) owned.delete(pid)
  },
}
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function cleanupOwned() {
  await ProcessSupervisor.cleanup([...owned.values()], 100)
}
// Bounded by the supervisor's per-turn question limit; late answers to cancelled
// dialogs are ignored, never retargeted to a newer question or granted.
const cancelled = new Set<string>()
const pending = new Map<
  string,
  {
    resolve: (a: Answer) => void
    answer?: { choice: 'allow' | 'deny'; value?: string }
    lost: () => void
    signal: AbortSignal
  }
>()
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
function send(message: any) {
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
const ask: Ask = (action, signal) =>
  new Promise((resolve) => {
    const id = randomUUID()
    const lost = () => {
      const existed = pending.delete(id)
      signal.removeEventListener('abort', lost)
      if (existed && process.connected && !abort.signal.aborted) {
        cancelled.add(id)
        send({ kind: 'question_cancel', id })
      }
      resolve({ choice: 'deny', delivered: () => false })
    }
    if (signal.aborted || abort.signal.aborted || pending.size >= 64) return lost()
    pending.set(id, { resolve, signal, lost })
    signal.addEventListener('abort', lost, { once: true })
    send({ kind: 'question', id, action })
  })
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  abort.abort()
  for (const r of registrations.values()) r.reject(new Error('pi_parent_lost'))
  registrations.clear()
  for (const p of pending.values()) {
    p.signal.removeEventListener('abort', p.lost)
    p.lost()
  }
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
      await cleanupOwned()
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
    if (m.kind === 'registered') {
      const registration = registrations.get(m.id)
      if (!registration) {
        if (stopping) return
        throw new Error('invalid_process_registration')
      }
      registrations.delete(m.id)
      if (m.confirmed) registration.resolve()
      else registration.reject(new Error('process_registration_failed'))
      return
    }
    if (m.kind === 'answer') {
      const p = pending.get(m.id)
      if (!p && cancelled.has(m.id)) return
      if (!p || p.answer) throw new Error('invalid_approval_delivery')
      p.answer = { choice: m.choice, ...(m.value !== undefined ? { value: m.value } : {}) }
      send({ kind: 'consume', id: m.id })
      return
    }
    if (m.kind === 'confirmed') {
      const p = pending.get(m.id)
      if (!p && cancelled.has(m.id)) return
      if (!p?.answer) throw new Error('invalid_approval_confirmation')
      pending.delete(m.id)
      p.signal.removeEventListener('abort', p.lost)
      p.resolve(
        m.confirmed && !abort.signal.aborted && !p.signal.aborted
          ? { ...p.answer, delivered: () => true }
          : { choice: 'deny', delivered: () => false }
      )
      return
    }
    if (started) throw new Error('duplicate_pi_start')
    started = true
    let result: any, reason: string | undefined
    try {
      const module = await import(pathToFileURL(m.hostModule).href)
      host = await module.createHost(m.config, ask, abort.signal, emit, {
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
      await cleanupOwned()
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
