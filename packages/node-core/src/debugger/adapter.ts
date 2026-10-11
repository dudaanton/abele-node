import type { DebuggerObservation } from '@abele/node-protocol'
export type { DebuggerObservation } from '@abele/node-protocol'

/** Node-owned normalized seam. A driver must correlate responses to requests and
 * attach the current incarnation. Raw DAP IDs/requests never cross the public API.
 * B2's bounded transport/driver normalizes DAP here; authorization is still
 * required before any seam is wired to client RPC or tools. */
export interface DebuggerAdapterSink {
  observe(session: string, incarnation: string, observation: DebuggerObservation): unknown
}
