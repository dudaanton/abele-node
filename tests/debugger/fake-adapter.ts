import { TextDecoder } from 'node:util'
import type { DebuggerAdapterSink, DebuggerObservation } from '@abele/node-core'
import type { DebuggerSnapshot } from '@abele/node-protocol'

/** Test-only DAP-shaped stream. Not a production transport or adapter launcher.
 * Keep correlation here so fixtures exercise replies in a different order than
 * requests, rather than calling the reducer in an artificially ordered sequence. */
export class FakeAdapter {
  private bytes = Buffer.alloc(0)
  private nextRequest = 1
  private readonly pending = new Map<
    number,
    {
      command: 'threads' | 'setBreakpoints'
      revision?: number
      ids?: string[]
      inventory_revision?: number
    }
  >()
  constructor(
    private readonly sink: DebuggerAdapterSink & {
      snapshot(session: string): { snapshot: DebuggerSnapshot }
    },
    private readonly session: string,
    private readonly incarnation: string
  ) {}
  request(
    command: 'threads' | 'setBreakpoints',
    context?: { revision: number; ids: string[] }
  ): number {
    const seq = this.nextRequest++
    this.pending.set(seq, {
      command,
      ...context,
      ...(command === 'threads'
        ? {
            inventory_revision: this.sink.snapshot(this.session).snapshot.thread_inventory_revision,
          }
        : {}),
    })
    return seq
  }
  feed(chunk: Uint8Array): void {
    this.bytes = Buffer.concat([this.bytes, chunk])
    for (;;) {
      const separator = this.bytes.indexOf('\r\n\r\n')
      if (separator < 0) {
        if (this.bytes.length > 1024) throw new Error('fake_header_limit')
        return
      }
      if (separator > 1024) throw new Error('fake_header_limit')
      const match = /^Content-Length: (0|[1-9][0-9]*)$/i.exec(
        this.bytes.subarray(0, separator).toString('ascii')
      )
      if (!match) throw new Error('fake_invalid_header')
      const length = Number(match[1])
      if (!Number.isSafeInteger(length) || length > 65536) throw new Error('fake_frame_limit')
      if (this.bytes.length < separator + 4 + length) return
      const body = this.bytes.subarray(separator + 4, separator + 4 + length)
      this.bytes = this.bytes.subarray(separator + 4 + length)
      this.receive(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)))
    }
  }
  private receive(message: Record<string, any>): void {
    if (message.type === 'request') throw new Error('fake_reverse_request_denied')
    if (message.type === 'response') {
      const request = this.pending.get(message.request_seq)
      if (!request || request.command !== message.command)
        throw new Error('fake_uncorrelated_response')
      this.pending.delete(message.request_seq)
      if (!message.success) return
      if (request.command === 'threads')
        this.emit({
          kind: 'threads',
          inventory_revision: request.inventory_revision!,
          threads: message.body.threads,
        })
      else
        this.emit({
          kind: 'breakpoints_result',
          revision: request.revision!,
          results: message.body.breakpoints.map((bp: any, index: number) => ({
            breakpoint_id: request.ids![index]!,
            verified: bp.verified,
            ...(bp.line === undefined ? {} : { line: bp.line }),
            ...(bp.message === undefined ? {} : { message: bp.message }),
          })),
        })
      return
    }
    if (message.type !== 'event') throw new Error('fake_invalid_message')
    const body = message.body ?? {}
    switch (message.event) {
      case 'stopped':
        this.emit({
          kind: 'stopped',
          thread_id: body.threadId,
          all_threads_stopped: body.allThreadsStopped === true,
          reason: body.reason,
          hit_breakpoint_ids: (body.hitBreakpointIds ?? []).map(String),
        })
        break
      case 'continued':
        this.emit({
          kind: 'continued',
          thread_id: body.threadId,
          all_threads_continued: body.allThreadsContinued === true,
        })
        break
      case 'thread':
        this.emit({ kind: 'thread', thread_id: body.threadId, reason: body.reason })
        break
      case 'output':
        this.emit({ kind: 'output', category: body.category ?? 'console', text: body.output })
        break
      case 'invalidated':
        this.emit({ kind: 'invalidated' })
        break
      case 'terminated':
        this.emit({ kind: 'lifecycle', lifecycle: 'terminated' })
        break
      default:
        throw new Error('fake_unsupported_event')
    }
  }
  private emit(observation: DebuggerObservation) {
    this.sink.observe(this.session, this.incarnation, observation)
  }
}
export function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message))
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
}
