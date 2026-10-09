import { expect, it } from 'vitest'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import * as sdk from '@earendil-works/pi-coding-agent'
import { createSdkHost, type HostConfiguration } from '../packages/provider-pi/src/sdk-runtime.js'
import { normalizeResponsesInput } from '../packages/provider-pi/src/responses-input.js'

it('omits only absent Responses content logprobs without mutating evidence or tool data', () => {
  const payload = {
    input: [
      {
        type: 'reasoning',
        encrypted_content: 'opaque',
        content: [
          { type: 'reasoning_text', text: 'x', logprobs: null, other: null },
          { type: 'reasoning_text', text: 'y', logprobs: [{ token: 'y', logprob: -0.1 }] },
        ],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'x', logprobs: null }],
      },
      { type: 'function_call', call_id: 'call', arguments: '{"logprobs":null}' },
      { type: 'function_call_output', call_id: 'call', output: [{ logprobs: null }] },
    ],
    tools: [{ parameters: { properties: { logprobs: { default: null } } } }],
  }
  const before = structuredClone(payload)
  const normalized = normalizeResponsesInput(payload) as typeof payload
  expect(normalized.input[0]!.content![0]).toEqual({
    type: 'reasoning_text',
    text: 'x',
    other: null,
  })
  expect(normalized.input[0]!.content![1]).toEqual(before.input[0]!.content![1])
  expect(normalized.input[1]!.content![0]).not.toHaveProperty('logprobs')
  expect(normalized.input.slice(2)).toEqual(before.input.slice(2))
  expect(normalized.tools).toEqual(before.tools)
  expect(payload).toEqual(before)
  expect(normalizeResponsesInput(normalized)).toEqual(normalized)
  for (const value of [null, 'text', { input: 'text' }, { messages: [{ logprobs: null }] }])
    expect(normalizeResponsesInput(value)).toBe(value)
})

// Exercise the installed SDK's response parser, native JSONL and request serializer.
// Only the loopback HTTP backend is fake; no CLI, credentials or live model is used.
it.each(['text-only', 'null', 'array', 'absent'] as const)(
  'reopens Responses history with %s logprobs and retains matched tool calls/results',
  async (mode) => {
    mkdirSync('.scratch', { recursive: true })
    const cwd = realpathSync(mkdtempSync(resolve('.scratch/pi-responses-')))
    const requests: any[] = [],
      errors: string[] = [],
      approvals: any[] = []
    const server = createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      const request = JSON.parse(body)
      requests.push(request)
      const calls = new Set<string>()
      for (const [i, item] of request.input.entries()) {
        for (const [j, block] of (Array.isArray(item.content) ? item.content : []).entries()) {
          if (block.logprobs === null) {
            const param = `input[${i}].content[${j}].logprobs`
            const message = `Invalid type for '${param}': expected an array of unknown values, but got null instead.`
            errors.push(message)
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(
              JSON.stringify({
                error: { type: 'invalid_request_error', code: 'invalid_type', message, param },
              })
            )
            return
          }
        }
        if (item.type === 'function_call') calls.add(item.call_id)
        if (item.type === 'function_call_output' && !calls.delete(item.call_id)) {
          errors.push('Tool result without a preceding call')
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: { message: errors.at(-1) } }))
          return
        }
      }
      const n = requests.length
      const output: any[] = []
      if (n === 1 && mode !== 'text-only') {
        output.push({
          type: 'reasoning',
          id: 'rs_first',
          status: 'completed',
          encrypted_content: 'opaque-reasoning-signature',
          summary: [{ type: 'summary_text', text: 'Greeting.' }],
          content: [
            {
              type: 'reasoning_text',
              text: 'Greeting.',
              ...(mode === 'absent' ? {} : { logprobs: mode === 'null' ? null : [] }),
            },
          ],
        })
      }
      if (n === 2) {
        output.push({
          type: 'function_call',
          id: 'fc_read',
          call_id: 'call_read',
          name: 'read',
          arguments: JSON.stringify({ path: 'README.md' }),
          status: 'completed',
        })
      } else {
        output.push({
          type: 'message',
          id: `msg_${n}`,
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: n === 1 ? 'Hello.' : 'Done.',
              annotations: [],
              logprobs: null,
            },
          ],
        })
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const event = (data: any) =>
        res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`)
      event({ type: 'response.created', response: { id: `resp_${n}` } })
      for (const [output_index, item] of output.entries()) {
        event({ type: 'response.output_item.added', output_index, item })
        event({ type: 'response.output_item.done', output_index, item })
      }
      event({
        type: 'response.completed',
        response: {
          id: `resp_${n}`,
          status: 'completed',
          output,
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        },
      })
      res.end()
    })
    let host: Awaited<ReturnType<typeof createSdkHost>> | undefined
    try {
      await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
      const port = (server.address() as { port: number }).port
      mkdirSync(join(cwd, 'sessions'))
      writeFileSync(join(cwd, 'README.md'), 'Fake workspace content\n')
      writeFileSync(
        join(cwd, 'models.json'),
        JSON.stringify({
          providers: {
            fixture: {
              baseUrl: `http://127.0.0.1:${port}/v1`,
              apiKey: 'fake-test-key',
              api: 'openai-responses',
              models: [
                {
                  id: 'tiny',
                  name: 'Fake',
                  reasoning: true,
                  input: ['text'],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 32768,
                  maxTokens: 512,
                },
              ],
            },
          },
        })
      )
      const config: HostConfiguration = {
        cwd,
        sessionDir: join(cwd, 'sessions'),
        agentDir: cwd,
        provider: 'fixture',
        model: 'tiny',
        profile: 'isolated',
        maxTokens: 512,
      }
      let mapping: any
      const open = () =>
        createSdkHost(
          sdk,
          { ...config, ...mapping },
          async (request) => {
            approvals.push(request)
            return { choice: 'allow', delivered: () => true }
          },
          AbortSignal.timeout(15000),
          (event) => {
            if (event.type === 'pi.session.bound') mapping = event.data
          }
        )
      host = await open()
      expect(await host.prompt('Say Hello.')).toMatchObject({ subtype: 'success' })
      await host.dispose()
      host = undefined
      const native = readFileSync(mapping.native_session_file, 'utf8')
      expect(native).toContain('Hello.')
      if (mode !== 'text-only') {
        expect(native).toContain('opaque-reasoning-signature')
        const assistant = native
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .find((entry) => entry.message?.role === 'assistant').message
        const signature = JSON.parse(
          assistant.content.find((block: any) => block.type === 'thinking').thinkingSignature
        )
        if (mode === 'null') expect(signature.content[0].logprobs).toBeNull()
      }
      host = await open()
      const result = await host.prompt('Read README.md.')
      expect(errors).toEqual([])
      expect(result).toMatchObject({ subtype: 'success' })
      expect(approvals).toHaveLength(1)
      expect(approvals[0]).toMatchObject({ tool_name: 'read' })
      await host.dispose()
      host = undefined
      host = await open()
      expect(await host.prompt('Continue after the read.')).toMatchObject({ subtype: 'success' })
      expect(errors).toEqual([])
      expect(requests).toHaveLength(4)
      for (const request of requests.slice(2)) {
        const call = request.input.find((item: any) => item.type === 'function_call')
        const result = request.input.find((item: any) => item.type === 'function_call_output')
        expect(call).toMatchObject({ call_id: 'call_read', name: 'read' })
        expect(result).toMatchObject({ call_id: call.call_id })
        expect(request.input.indexOf(call)).toBeLessThan(request.input.indexOf(result))
        expect(result.output).toContain('Fake workspace content')
      }
      if (mode !== 'text-only') {
        const reasoning = requests[1].input.find((item: any) => item.type === 'reasoning')
        expect(reasoning.encrypted_content).toBe('opaque-reasoning-signature')
        if (mode === 'array') expect(reasoning.content[0].logprobs).toEqual([])
        else expect(reasoning.content[0]).not.toHaveProperty('logprobs')
      }
    } finally {
      await host?.dispose()
      server.closeAllConnections()
      await new Promise<void>((done) => server.close(() => done()))
      rmSync(cwd, { recursive: true, force: true })
    }
  }
)
