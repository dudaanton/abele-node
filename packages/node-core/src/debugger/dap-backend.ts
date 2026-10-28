import { ChannelError } from '@abele/channel-protocol'
import type { DebuggerBackend, DebuggerDispatchGuard } from './coordinator.js'
import type { DapSession } from './driver.js'

/** Trusted host binding, registered only after reviewed profile admission. No
 * launch, attach, restart, source export or arbitrary adapter request surface. */
export class DapDebuggerBackend implements DebuggerBackend {
  /** `stop` ends the whole run the session belongs to, where the run owns the process and the
   * session does not: the program's own session under the adapter's root. */
  constructor(
    readonly session: DapSession,
    private readonly stopRun?: () => Promise<unknown>
  ) {}
  supports(method: string) {
    const caps = this.session.snapshot.adapter_capabilities
    if (method === 'breakpointLocations') return caps.includes('supportsBreakpointLocationsRequest')
    if (method === 'setVariable') return caps.includes('supportsSetVariable')
    return [
      'step',
      'continue',
      'pause',
      'breakpoints.patch',
      'exceptionBreakpoints.set',
      'threads',
      'stack',
      'scopes',
      'sourceStatus',
      'variables',
      'evaluate',
      'detach',
      'terminate',
    ].includes(method)
  }
  dispatch(method: string, p: Record<string, any>, guard: DebuggerDispatchGuard) {
    return this.session.coordinated(
      guard,
      async () => {
        if (
          p.debug_session_id !== this.session.id ||
          (p.incarnation !== undefined && p.incarnation !== this.session.incarnation)
        )
          throw new ChannelError('stale_state')
        guard()
        const thread = p.thread_id ?? this.session.snapshot.selected_thread_id
        switch (method) {
          case 'breakpointLocations':
            return this.session.breakpointLocations(
              p.source_id,
              p.line,
              p.end_line,
              p.column,
              p.end_column
            )
          case 'sourceStatus':
            return this.session.sourceStatus(p.source_id, p.line, p.end_line)
          case 'step':
            return this.session.step(thread, p.kind, p.single_thread)
          case 'continue':
            return this.session.continue(thread, p.single_thread)
          case 'pause':
            return this.session.pause(thread)
          case 'breakpoints.patch':
            return this.session.patchBreakpoints(p.expected_breakpoint_revision, p.upsert, p.remove)
          case 'exceptionBreakpoints.set':
            return this.session.exceptionBreakpoints(p.filters)
          case 'threads':
            return this.session.threads()
          case 'stack':
            return this.session.stack(p.thread_id, p.start, p.count)
          case 'scopes':
            return this.session.scopes(p.frame_handle)
          case 'variables':
            return this.session.approvedVariables(p.handle, p.start, p.count, p.max_bytes, p.depth)
          case 'evaluate':
            return this.session.evaluate(p.frame_handle, p.expression, p.context)
          case 'setVariable':
            return this.session.setVariable(p.handle, p.name, p.value)
          case 'detach':
            return this.session.detach()
          case 'terminate':
            if (!this.stopRun) return this.session.terminate()
            await this.stopRun()
            return this.session.snapshot
          default:
            throw new ChannelError('unsupported_operation')
        }
      },
      method === 'detach'
    )
  }
}
