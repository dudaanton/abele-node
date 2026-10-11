// Versioned stdio MCP executable using the existing per-run protected IPC.
// No authority from tool arguments and no provider permission-setting bypass.
import { createConnection } from 'node:net'
const limit = 256 * 1024
const unavailable = { code: 'debugger_unavailable', snapshot: null, observation: 'unknown' }
const pending = new Map<string, AbortController>()
function request(
  action: 'list' | 'call',
  name: unknown,
  args: unknown,
  signal: AbortSignal
): Promise<any> {
  return new Promise((resolve) => {
    const started = Date.now()
    const socket = createConnection(process.env.ABELE_APPROVAL_SOCKET ?? '')
    let buffer = Buffer.alloc(0),
      done = false
    const finish = (value: unknown) => {
      if (done) return
      done = true
      clearTimeout(timer)
      signal.removeEventListener('abort', cancelled)
      socket.destroy()
      resolve(value)
    }
    const failed = (reason: 'cancelled' | 'connection_lost') =>
      finish(
        name === 'debug_sleep' || name === 'debug_wait'
          ? {
              reason,
              elapsed_ms: Math.max(0, Date.now() - started),
              snapshot: null,
              observation: 'unknown',
            }
          : unavailable
      )
    const cancelled = () => failed('cancelled')
    const lost = () => failed('connection_lost')
    const timer = setTimeout(lost, 65000)
    signal.addEventListener('abort', cancelled, { once: true })
    if (signal.aborted) cancelled()
    socket.on('error', lost)
    socket.on('close', lost)
    socket.on('connect', () =>
      socket.write(
        JSON.stringify({
          version: 1,
          token: process.env.ABELE_APPROVAL_TOKEN,
          session_id: process.env.ABELE_SESSION_ID,
          run_id: process.env.ABELE_RUN_ID,
          generation: process.env.ABELE_GENERATION,
          kind: 'debugger',
          action,
          name,
          args,
        }) + '\n'
      )
    )
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > limit) return lost()
      const nl = buffer.indexOf(10)
      if (nl < 0) return
      try {
        finish(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, nl))))
      } catch {
        lost()
      }
    })
  })
}
function reply(id: unknown, result: unknown) {
  const message = JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n'
  if (Buffer.byteLength(message) > limit)
    return reply(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ ...unavailable, code: 'debugger_response_too_large' }),
        },
      ],
      isError: true,
    })
  process.stdout.write(message)
}
async function respond(r: any) {
  if (r.method === 'notifications/cancelled') {
    pending.get(String(r.params?.requestId))?.abort()
    return
  }
  if (r.id === undefined) return
  const key = String(r.id)
  if (pending.has(key) || pending.size >= 64) {
    reply(r.id, { content: [{ type: 'text', text: JSON.stringify(unavailable) }], isError: true })
    return
  }
  const abort = new AbortController()
  pending.set(key, abort)
  try {
    if (r.method === 'initialize')
      reply(r.id, {
        protocolVersion: r.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'abele-debugger', version: '1' },
      })
    else if (r.method === 'tools/list') {
      const result = await request('list', undefined, undefined, abort.signal)
      reply(r.id, { tools: Array.isArray(result.tools) ? result.tools : [] })
    } else if (r.method === 'tools/call') {
      const result = await request('call', r.params?.name, r.params?.arguments, abort.signal)
      reply(r.id, {
        content: [{ type: 'text', text: JSON.stringify(result) }],
        ...(result.code && !result.reason ? { isError: true } : {}),
      })
    } else if (r.method === 'ping') reply(r.id, {})
    else
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: r.id,
          error: { code: -32601, message: 'Unsupported MCP method' },
        }) + '\n'
      )
  } finally {
    pending.delete(key)
  }
}
let input = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk])
  if (input.length > limit) process.exit(1)
  let nl: number
  while ((nl = input.indexOf(10)) >= 0) {
    const line = input.subarray(0, nl)
    input = input.subarray(nl + 1)
    let r: any
    try {
      r = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))
    } catch {
      process.exit(1)
    }
    void respond(r).catch(() =>
      reply(r.id, { content: [{ type: 'text', text: JSON.stringify(unavailable) }], isError: true })
    )
  }
})
process.stdin.on('end', () => {
  for (const abort of pending.values()) abort.abort()
  process.exit(0)
})
