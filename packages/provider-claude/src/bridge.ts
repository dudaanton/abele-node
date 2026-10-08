// Versioned stdio MCP executable. A lost/expired IPC request can only yield denial.
import { createConnection } from 'node:net'
const limit = 256 * 1024
const canonical = (v: any): string =>
  Array.isArray(v)
    ? '[' + v.map(canonical).join(',') + ']'
    : v && typeof v === 'object'
      ? '{' +
        Object.keys(v)
          .sort()
          .map((k) => JSON.stringify(k) + ':' + canonical(v[k]))
          .join(',') +
        '}'
      : JSON.stringify(v)
const deny = { behavior: 'deny', message: 'Node approval unavailable, invalid or expired' }
function approve(args: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const socket = createConnection(process.env.ABELE_APPROVAL_SOCKET ?? '')
    let bytes = Buffer.alloc(0)
    let done = false
    let candidate: any
    const finish = (value: unknown) => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(
      () => finish(deny),
      Number(process.env.ABELE_APPROVAL_TTL ?? 60000) + 3000
    )
    socket.on('error', () => finish(deny))
    socket.on('close', () => finish(deny))
    socket.on('connect', () =>
      socket.write(
        JSON.stringify({
          version: 1,
          token: process.env.ABELE_APPROVAL_TOKEN,
          session_id: process.env.ABELE_SESSION_ID,
          run_id: process.env.ABELE_RUN_ID,
          generation: process.env.ABELE_GENERATION,
          args,
        }) + '\n'
      )
    )
    socket.on('data', (chunk) => {
      bytes = Buffer.concat([bytes, chunk])
      if (bytes.length > limit) return finish(deny)
      let nl: number
      while ((nl = bytes.indexOf(10)) !== -1) {
        const line = bytes.subarray(0, nl)
        bytes = bytes.subarray(nl + 1)
        try {
          const answer = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))
          if (candidate) {
            if (answer.confirmed !== true) return finish(deny)
            return finish(candidate)
          }
          if (!['allow', 'deny'].includes(answer.behavior)) return finish(deny)
          // Values must be the exact approved original JSON; key order is immaterial.
          if (
            answer.behavior === 'allow' &&
            canonical(answer.updatedInput) !== canonical((args as any)?.input)
          )
            return finish(deny)
          candidate = answer
          // Do not grant until the node confirms its durable bridge-delivery fact.
          socket.write(JSON.stringify({ delivered: true }) + '\n')
        } catch {
          return finish(deny)
        }
      }
    })
  })
}
// MCP is JSON-RPC, not provider stream JSON: frame separately with the same byte bounds.
let pending = Buffer.alloc(0)
process.stdin.on('data', (chunk: Buffer) => {
  pending = Buffer.concat([pending, chunk])
  if (pending.length > limit) process.exit(1)
  let nl: number
  while ((nl = pending.indexOf(10)) !== -1) {
    const line = pending.subarray(0, nl)
    pending = pending.subarray(nl + 1)
    let r: any
    try {
      r = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))
    } catch {
      process.exit(1)
    }
    if (r.id === undefined) continue
    void respond(r).catch(() =>
      reply(r.id, { content: [{ type: 'text', text: JSON.stringify(deny) }] })
    )
  }
})
process.stdin.on('end', () => process.exit(0))
function reply(id: unknown, result: unknown) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n')
}
async function respond(r: any) {
  if (r.method === 'initialize')
    reply(r.id, {
      protocolVersion: r.params?.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'abele-approval', version: '1' },
    })
  else if (r.method === 'tools/list')
    reply(r.id, {
      tools: [
        {
          name: 'permission',
          description:
            'Request a node-owned human permission decision for this exact tool invocation',
          inputSchema: {
            type: 'object',
            properties: {
              tool_name: { type: 'string' },
              tool_use_id: { type: 'string' },
              input: { type: 'object', additionalProperties: true },
            },
            required: ['tool_name', 'tool_use_id', 'input'],
          },
        },
      ],
    })
  else if (r.method === 'tools/call' && r.params?.name === 'permission')
    reply(r.id, {
      content: [{ type: 'text', text: JSON.stringify(await approve(r.params.arguments)) }],
    })
  else if (r.method === 'ping') reply(r.id, {})
  else
    process.stdout.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: r.id,
        error: { code: -32601, message: 'Unsupported MCP method' },
      }) + '\n'
    )
}
