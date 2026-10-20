// What both SDK workers share: durable process-group claims, node questions and node tools,
// spoken over whatever channel the worker has to the daemon (an IPC pipe or a session host).
import { randomUUID } from 'node:crypto'
import { ProcessSupervisor, type ProcessIdentity } from '@abele/provider-claude'
import type { Ask, Answer } from './host.js'

export type WorkerSend = (message: any) => void
export function createWorkerCore(send: WorkerSend, abort: AbortSignal, connected: () => boolean) {
  // Local obligations survive loss of the daemon and its SQLite owner.
  const owned = new Map<number, ProcessIdentity>()
  const registrations = new Map<
    string,
    { kind: string; evidence: ProcessIdentity; resolve(): void; reject(error: Error): void }
  >()
  let groupClaims = 0
  async function register(kind: 'process_claim' | 'group_reaped', evidence: ProcessIdentity) {
    if (abort.aborted || !connected()) throw new Error('pi_parent_lost')
    const id = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        registrations.delete(id)
        reject(new Error('process_registration_deadline'))
      }, 5000)
      registrations.set(id, {
        kind,
        evidence,
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
      if (!abort.aborted) await register('group_reaped', evidence)
      for (const [pid, member] of owned) if (member.group === evidence.group) owned.delete(pid)
    },
  }
  // Bounded by the supervisor's per-turn question limit; late answers to cancelled
  // dialogs are ignored, never retargeted to a newer question or granted.
  const cancelled = new Set<string>()
  const debuggerPending = new Map<
    string,
    { name: string; args: unknown; started: number; resolve(result: any): void; cleanup(): void }
  >()
  function debuggerCall(name: string, args: unknown, signal?: AbortSignal): Promise<any> {
    return new Promise((resolve) => {
      const id = randomUUID(),
        started = Date.now()
      let timer: ReturnType<typeof setTimeout> | undefined
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const lost = (timeout = false) => {
        debuggerPending.delete(id)
        cleanup()
        if (connected() && !abort.aborted) send({ kind: 'debugger_cancel', id })
        resolve({
          reason: timeout ? 'lsp_timeout' : 'cancelled',
          ...(timeout
            ? {
                code: 'lsp_timeout',
                message:
                  'Language intelligence did not respond within 30 seconds. Check the language server and project dependencies, or use file search.',
              }
            : {}),
          elapsed_ms: Math.max(0, Date.now() - started),
          snapshot: null,
          observation: 'unknown',
        })
      }
      const onAbort = () => lost()
      if (signal?.aborted || abort.aborted || debuggerPending.size >= 64) return lost()
      debuggerPending.set(id, {
        name,
        args,
        started,
        resolve,
        cleanup,
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      if (name === 'lsp') timer = setTimeout(() => lost(true), 30000)
      send({ kind: 'debugger_call', id, name, args })
    })
  }
  const pending = new Map<
    string,
    {
      action: Parameters<Ask>[0]
      resolve: (a: Answer) => void
      answer?: { choice: 'allow' | 'deny'; value?: string }
      lost: () => void
      signal: AbortSignal
    }
  >()
  const ask: Ask = (action, signal) =>
    new Promise((resolve) => {
      const id = randomUUID()
      const lost = () => {
        const existed = pending.delete(id)
        signal.removeEventListener('abort', lost)
        if (existed && connected() && !abort.aborted) {
          cancelled.add(id)
          send({ kind: 'question_cancel', id })
        }
        resolve({ choice: 'deny', delivered: () => false })
      }
      if (signal.aborted || abort.aborted || pending.size >= 64) return lost()
      pending.set(id, { action, resolve, signal, lost })
      signal.addEventListener('abort', lost, { once: true })
      send({ kind: 'question', id, action })
    })
  /** Handles the replies every worker understands; false for anything else. */
  function handle(m: any, stopping: boolean): boolean {
    if (m.kind === 'debugger_result') {
      const p = debuggerPending.get(m.id)
      if (p) {
        debuggerPending.delete(m.id)
        p.cleanup()
        p.resolve(m.result)
      }
      return true
    }
    if (m.kind === 'registered') {
      const registration = registrations.get(m.id)
      if (!registration) {
        if (stopping) return true
        throw new Error('invalid_process_registration')
      }
      registrations.delete(m.id)
      if (m.confirmed) registration.resolve()
      else registration.reject(new Error('process_registration_failed'))
      return true
    }
    if (m.kind === 'answer') {
      const p = pending.get(m.id)
      if (!p && cancelled.has(m.id)) return true
      if (!p || p.answer) throw new Error('invalid_approval_delivery')
      p.answer = { choice: m.choice, ...(m.value !== undefined ? { value: m.value } : {}) }
      send({ kind: 'consume', id: m.id })
      return true
    }
    if (m.kind === 'confirmed') {
      const p = pending.get(m.id)
      if (!p && cancelled.has(m.id)) return true
      if (!p?.answer) throw new Error('invalid_approval_confirmation')
      pending.delete(m.id)
      p.signal.removeEventListener('abort', p.lost)
      p.resolve(
        m.confirmed && !abort.aborted && !p.signal.aborted
          ? { ...p.answer, delivered: () => true }
          : { choice: 'deny', delivered: () => false }
      )
      return true
    }
    return false
  }
  /** A new daemon took over: everything still waiting on the old one is asked again. An answer
   * the old daemon gave but never confirmed is asked to be confirmed, which a new one refuses. */
  function resync() {
    for (const [id, p] of pending)
      send(p.answer ? { kind: 'consume', id } : { kind: 'question', id, action: p.action })
    for (const [id, r] of registrations) send({ kind: r.kind, id, evidence: r.evidence })
    for (const [id, p] of debuggerPending)
      send({ kind: 'debugger_call', id, name: p.name, args: p.args })
  }
  /** Ends everything waiting on the daemon; nothing waiting is ever granted. */
  function release() {
    for (const p of debuggerPending.values()) {
      p.cleanup()
      p.resolve({
        reason: 'connection_lost',
        elapsed_ms: Math.max(0, Date.now() - p.started),
        snapshot: null,
        observation: 'unknown',
      })
    }
    debuggerPending.clear()
    for (const r of registrations.values()) r.reject(new Error('pi_parent_lost'))
    registrations.clear()
    for (const p of pending.values()) {
      p.signal.removeEventListener('abort', p.lost)
      p.lost()
    }
  }
  const cleanupOwned = () => ProcessSupervisor.cleanup([...owned.values()], 100)
  return { owned, groups, ask, debuggerCall, handle, resync, release, cleanupOwned }
}
