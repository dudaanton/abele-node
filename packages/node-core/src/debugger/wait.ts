import { randomUUID } from 'node:crypto'
import { ChannelError } from '@abele/channel-protocol'
import {
  DebuggerMethodSchemas,
  type DebuggerEvent,
  type DebuggerCursor,
} from '@abele/node-protocol'
import type { NodeCore } from '../index.js'
import type { DebuggerPrincipal } from './permissions.js'

type Reason = 'elapsed' | 'event' | 'cancelled' | 'connection_lost'
type Pending = {
  principal: DebuggerPrincipal
  session: string
  cancel(): void
  refresh(): void
  lost(): void
}
/** Timers and cursor listeners are independent of the coordinator FIFO and chat
 * input queue. No target request, polling, context injection or new turn. */
export class DebuggerWaits {
  private readonly pending = new Map<string, Pending>()
  constructor(private readonly core: NodeCore) {}
  start(
    principal: DebuggerPrincipal,
    method: 'wait' | 'sleep',
    raw: unknown,
    signal?: AbortSignal
  ): Promise<any> {
    const control = this.core.debuggerControl
    const parsed = DebuggerMethodSchemas[`debugger.v1.${method}`].safeParse(raw)
    if (!parsed.success) throw new ChannelError('invalid_params')
    const p = parsed.data
    const session = p.debug_session_id
    control.checkPublication(principal, session)
    if (this.pending.size >= 128) throw new ChannelError('debugger_wait_limit')
    const policy = control.permissions.policy()
    const duration = 'duration_ms' in p ? p.duration_ms : p.timeout_ms
    if (method === 'sleep' && duration > policy.sleep_max_ms)
      throw new ChannelError('sleep_duration_limit')
    let cursor: DebuggerCursor = this.core.debugger.snapshot(session).cursor
    if ('after_event_seq' in p)
      cursor = {
        ...cursor,
        event_seq: p.after_event_seq,
        incarnation: p.incarnation ?? cursor.incarnation,
      }
    const kinds = new Set('kinds' in p ? p.kinds : (p.wake_on ?? policy.sleep_wake_on))
    const started = Date.now(),
      id = p.wait_id ?? randomUUID(),
      key = control.principalKey(principal) + '\u0000' + id
    if (this.pending.has(key)) throw new ChannelError('wait_exists')
    return new Promise((resolve) => {
      let done = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let expiry: ReturnType<typeof setTimeout> | undefined
      let unsubscribe = () => {}
      const finish = (
        reason: Reason,
        event?: DebuggerEvent,
        code?: string,
        unavailable = false
      ) => {
        if (done) return
        done = true
        clearTimeout(timer)
        clearTimeout(expiry)
        unsubscribe()
        signal?.removeEventListener('abort', cancel)
        this.pending.delete(key)
        let snapshot = null
        try {
          if (!unavailable) {
            control.checkPublication(principal, session)
            snapshot = this.core.debugger.snapshot(session).snapshot
          }
        } catch {
          reason = 'cancelled'
          event = undefined
        }
        resolve({
          wait_id: id,
          reason,
          elapsed_ms: Math.max(0, Date.now() - started),
          ...(event && snapshot ? { event } : {}),
          ...(code ? { code } : {}),
          snapshot,
        })
      }
      const cancel = () => finish('cancelled')
      const refresh = () => {
        if (done) return
        try {
          control.checkPublication(principal, session)
          clearTimeout(expiry)
          if (principal.kind === 'agent') {
            const grant = control.permissions.grant(principal.grant_id)
            expiry = setTimeout(
              () => finish('cancelled'),
              Math.max(0, Date.parse(grant.expires_at) - Date.now())
            )
          }
          const snapshot = this.core.debugger.snapshot(session).snapshot
          if (snapshot.lifecycle === 'connection-lost') return finish('connection_lost')
          if (['terminated', 'detached', 'failed'].includes(snapshot.lifecycle))
            return finish('cancelled')
          const replay = this.core.debugger.replay(cursor)
          if (replay.kind === 'fresh_snapshot_required')
            return finish('event', undefined, 'fresh_snapshot_required')
          const event = replay.events.find((e) => kinds.has(e.kind))
          cursor = replay.cursor
          if (event) finish('event', event)
        } catch {
          finish('cancelled')
        }
      }
      this.pending.set(key, {
        principal,
        session,
        cancel,
        refresh,
        lost: () => finish('connection_lost', undefined, undefined, true),
      })
      // No asynchronous boundary between registration and replay: neither
      // already observed events nor an observation at admission can be missed.
      unsubscribe = this.core.debugger.subscribe(session, refresh)
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) cancel()
      else refresh()
      if (!done) timer = setTimeout(() => finish('elapsed'), duration)
    })
  }
  cancel(principal: DebuggerPrincipal, raw: unknown) {
    const p = DebuggerMethodSchemas['debugger.v1.cancelWait'].parse(raw)
    this.core.debuggerControl.checkPublication(principal, p.debug_session_id)
    const pending = this.pending.get(
      this.core.debuggerControl.principalKey(principal) + '\u0000' + p.wait_id
    )
    if (
      !pending ||
      pending.session !== p.debug_session_id ||
      this.core.debuggerControl.principalKey(pending.principal) !==
        this.core.debuggerControl.principalKey(principal)
    )
      throw new ChannelError('not_found')
    pending.cancel()
    return { cancelled: true, snapshot: this.core.debugger.snapshot(p.debug_session_id).snapshot }
  }
  refresh() {
    for (const p of [...this.pending.values()]) p.refresh()
  }
  close() {
    for (const p of [...this.pending.values()]) p.lost()
  }
}
