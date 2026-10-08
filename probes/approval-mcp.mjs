// Minimal stdio MCP permission responder for ONE disposable scratch command.
// Not a generic approval service. No credentials, third-party packages, or network listener.
import { appendFileSync } from 'node:fs'
let pending = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  pending += chunk
  let newline
  while ((newline = pending.indexOf('\n')) !== -1) {
    const message = JSON.parse(pending.slice(0, newline))
    pending = pending.slice(newline + 1)
    if (message.id === undefined) continue
    let result
    if (message.method === 'initialize') {
      result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'stage0-approval', version: '0.0.0' },
      }
    } else if (message.method === 'tools/list') {
      result = {
        tools: [
          {
            name: 'permission',
            description: 'Approve only the disposable stage 0 echo command',
            inputSchema: {
              type: 'object',
              properties: {
                tool_name: { type: 'string' },
                input: { type: 'object', additionalProperties: true },
                tool_use_id: { type: 'string' },
              },
              required: ['tool_name', 'input'],
            },
          },
        ],
      }
    } else if (message.method === 'tools/call') {
      const args = message.params.arguments
      const allow =
        process.argv[2] !== 'deny' &&
        args.tool_name === 'Bash' &&
        args.input?.command === 'printf hello > hello.txt'
      appendFileSync(
        'mcp-evidence.jsonl',
        JSON.stringify({ method: message.method, args, allow }) + '\n'
      )
      const answer = allow
        ? { behavior: 'allow', updatedInput: args.input }
        : { behavior: 'deny', message: 'Not the one disposable command' }
      result = { content: [{ type: 'text', text: JSON.stringify(answer) }] }
    } else if (message.method === 'ping') result = {}
    else {
      process.stdout.write(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: -32601, message: 'Unsupported probe method' },
        }) + '\n'
      )
      continue
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
  }
})
