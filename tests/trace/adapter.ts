import { runInNewContext } from 'node:vm'
import type { wire } from '../debugger/dap-wire.js'

/** A scripted adapter: it answers the driver's requests and evaluates expressions for real in a
 * sandbox standing for the paused frame, quoting string results as an adapter shows them. */
export function adapter(
  w: ReturnType<typeof wire>,
  frame: () => Record<string, unknown>,
  root = '/project'
) {
  let breakpointId = 100
  const sandbox = frame()
  let stopped = true
  let threads = [1]
  let depth = 2
  let subtle = false
  let topLine = 4
  const answered = new Set<number>()
  const tick = () => {
    for (const m of w.messages) {
      if (m.type !== 'request' || answered.has(m.seq)) continue
      answered.add(m.seq)
      switch (m.command) {
        case 'initialize':
          w.reply(m, {
            supportsConditionalBreakpoints: true,
            supportsConfigurationDoneRequest: true,
          })
          w.send({ type: 'event', event: 'initialized' })
          break
        case 'setBreakpoints':
          w.reply(m, {
            breakpoints: m.arguments.breakpoints.map((b: any) => ({
              id: ++breakpointId,
              verified: true,
              line: b.line,
              column: 1,
            })),
          })
          break
        case 'stackTrace':
          w.reply(m, {
            stackFrames: [
              {
                id: 7,
                name: 'parsePage',
                line: topLine,
                column: 1,
                source: { path: `${root}/src/page.ts` },
                ...(subtle ? { presentationHint: 'subtle' } : {}),
              },
              {
                id: 8,
                name: 'loadDocument',
                line: 9,
                column: 1,
                source: { path: `${root}/src/service.ts` },
              },
            ],
            totalFrames: depth,
          })
          break
        case 'evaluate':
          try {
            w.reply(m, { result: `'${String(runInNewContext(m.arguments.expression, sandbox))}'` })
          } catch (e) {
            w.send({
              type: 'response',
              request_seq: m.seq,
              command: m.command,
              success: false,
              message: (e as Error).message,
            })
          }
          break
        case 'threads':
          w.reply(m, { threads: threads.map((id) => ({ id, name: `Thread ${id}` })) })
          break
        case 'continue':
          stopped = false
          w.reply(m, { allThreadsContinued: true })
          w.send({
            type: 'event',
            event: 'continued',
            body: { threadId: 1, allThreadsContinued: true },
          })
          break
        default:
          w.reply(m)
      }
    }
  }
  const timer = setInterval(tick, 1)
  return {
    stop: () => clearInterval(timer),
    get running() {
      return !stopped
    },
    hit(dapIds: number[] | undefined, reason = 'breakpoint', description?: string) {
      stopped = true
      w.send({
        type: 'event',
        event: 'stopped',
        body: {
          threadId: 1,
          allThreadsStopped: true,
          reason,
          hitBreakpointIds: dapIds,
          description,
        },
      })
    },
    lastBreakpointId: () => breakpointId,
    /** The threads it lists when asked. */
    threads(ids: number[]) {
      threads = ids
    },
    stackDepth(value: number, skipped = false, line = 4) {
      depth = value
      subtle = skipped
      topLine = line
    },
  }
}
