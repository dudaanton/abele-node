import { mkdtempSync, rmSync, readFileSync, copyFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeProviderAdapter } from '@abele/provider-claude'
import { PiProviderAdapter } from '@abele/provider-pi'
import {
  registerDebuggerTools,
  registerDebuggerContext,
} from '../../packages/provider-pi/src/debugger.js'
import { debuggerToolDefinitions } from '@abele/node-core'

const tool = debuggerToolDefinitions.find((t) => t.name === 'debug_status')!
function bridge() {
  let revision = 0
  const call = vi.fn(async () => ({
    snapshot: {
      debug_session_id: 'selected',
      incarnation: 'fixture-incarnation',
      state_revision: ++revision,
      execution: 'mixed',
    },
  }))
  const publish = vi.fn((_args, result) => result)
  return { tools: [tool], call, publish, close: vi.fn() }
}

describe('trusted provider debugger bindings (no inference)', () => {
  it('Claude lists and calls node debugger MCP tools during its single input invocation', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'debug-claude-'))
    const debuggerBridge = bridge()
    const permission = vi.fn(async () => ({ choice: 'deny' as const, delivered: () => false }))
    const executable = join(cwd, 'fake-provider.mjs')
    copyFileSync(fileURLToPath(new URL('../fixtures/claude.mjs', import.meta.url)), executable)
    chmodSync(executable, 0o700)
    const adapter = new ClaudeProviderAdapter({ executable, profile: 'isolated' })
    let run: Awaited<ReturnType<typeof adapter.startTurn>> | undefined
    try {
      run = await adapter.startTurn(
        {
          cwd,
          text: 'debugger-tools',
          session_id: '11111111-1111-4111-8111-111111111111',
          run_id: 'trusted-run',
        },
        { debugger: debuggerBridge, event() {}, processes() {}, permission }
      )
      expect(await run.done).toMatchObject({ result: { subtype: 'success' } })
      const output = JSON.parse(readFileSync(join(cwd, 'debugger-results.json'), 'utf8'))
      expect(output.tools.map((t: any) => t.name)).toEqual(['debug_status'])
      expect(output.results.map((r: any) => r.snapshot.state_revision)).toEqual([1, 2])
      expect(debuggerBridge.call).toHaveBeenCalledTimes(2)
      expect(debuggerBridge.publish).toHaveBeenCalledTimes(2)
      expect(permission).not.toHaveBeenCalled()
      expect(debuggerBridge.close).toHaveBeenCalledTimes(1)
    } finally {
      await run?.interrupt()
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 10000)
  it('MCP sleep settles a lost node connection with elapsed time and unknown state', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'debug-mcp-loss-'))
    const b = bridge()
    b.tools = [debuggerToolDefinitions.find((t) => t.name === 'debug_sleep')!]
    b.call.mockRejectedValue(Error('connection_lost'))
    const executable = join(cwd, 'fake-provider.mjs')
    copyFileSync(fileURLToPath(new URL('../fixtures/claude.mjs', import.meta.url)), executable)
    chmodSync(executable, 0o700)
    const adapter = new ClaudeProviderAdapter({ executable, profile: 'isolated' })
    let run: Awaited<ReturnType<typeof adapter.startTurn>> | undefined
    try {
      run = await adapter.startTurn(
        {
          cwd,
          text: 'debugger-sleep-loss',
          session_id: '11111111-1111-4111-8111-111111111111',
          run_id: 'trusted-run',
        },
        {
          debugger: b,
          event() {},
          processes() {},
          permission: async () => ({ choice: 'deny', delivered: () => false }),
        }
      )
      expect(await run.done).toMatchObject({ result: { subtype: 'success' } })
      const result = JSON.parse(readFileSync(join(cwd, 'debugger-results.json'), 'utf8')).results[0]
      expect(result).toMatchObject({
        reason: 'connection_lost',
        snapshot: null,
        observation: 'unknown',
      })
      expect(result.elapsed_ms).toBeGreaterThanOrEqual(0)
    } finally {
      await run?.interrupt()
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 10000)
  it('pi supervised IPC delivers debugger calls and settles the bridge with the run', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'debug-pi-'))
    const b = bridge(),
      events: any[] = []
    const adapter = new PiProviderAdapter({
      stateDir: cwd,
      hostModule: fileURLToPath(new URL('../fixtures/pi-debugger-host.mjs', import.meta.url)),
      profile: 'isolated',
    })
    let run: Awaited<ReturnType<typeof adapter.startTurn>> | undefined
    try {
      run = await adapter.startTurn(
        {
          cwd,
          text: 'scripted investigation',
          session_id: '11111111-1111-4111-8111-111111111111',
          run_id: 'trusted-run',
        },
        {
          debugger: b,
          event: (e) => events.push(e),
          processes() {},
          permission: async () => {
            throw Error('debugger must not await queued input')
          },
        }
      )
      expect(await run.done).toMatchObject({ result: { subtype: 'success' } })
      expect(events.find((e) => e.type === 'pi.debugger.fixture').data.result).toMatchObject({
        snapshot: { execution: 'mixed' },
      })
      expect(b.publish).toHaveBeenCalledTimes(1)
      expect(b.close).toHaveBeenCalledTimes(1)
    } finally {
      await run?.interrupt()
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 10000)
  it('pi cancellation reports elapsed time and never dispatches an already-aborted timer', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'debug-pi-cancel-'))
    const b = bridge(),
      events: any[] = []
    b.tools = [debuggerToolDefinitions.find((t) => t.name === 'debug_sleep')!]
    const adapter = new PiProviderAdapter({
      stateDir: cwd,
      hostModule: fileURLToPath(new URL('../fixtures/pi-debugger-host.mjs', import.meta.url)),
      profile: 'isolated',
    })
    let run: Awaited<ReturnType<typeof adapter.startTurn>> | undefined
    try {
      run = await adapter.startTurn(
        {
          cwd,
          text: 'cancel-sleep',
          session_id: '11111111-1111-4111-8111-111111111111',
          run_id: 'trusted-run',
        },
        {
          debugger: b,
          event: (e) => events.push(e),
          processes() {},
          permission: async () => ({ choice: 'deny', delivered: () => false }),
        }
      )
      expect(await run.done).toMatchObject({ result: { subtype: 'success' } })
      const result = events.find((e) => e.type === 'pi.debugger.fixture').data.result
      expect(result).toMatchObject({ reason: 'cancelled', snapshot: null, observation: 'unknown' })
      expect(result.elapsed_ms).toBeGreaterThanOrEqual(0)
      expect(b.call).not.toHaveBeenCalled()
    } finally {
      await run?.interrupt()
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 10000)
  it('pi and plugin-style embeddings execute the same bridge directly, never queue input', async () => {
    const b = bridge()
    const tools: any[] = []
    registerDebuggerTools({ registerTool: (tool: any) => tools.push(tool) }, b)
    const signal = new AbortController().signal
    const args = { debug_session_id: 'selected' }
    const result = await tools[0].execute('model-call-id', args, signal)
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      snapshot: { execution: 'mixed', state_revision: 1 },
    })
    expect(b.call).toHaveBeenCalledWith('debug_status', args, signal)
    expect(b.publish).toHaveBeenCalledWith(args, expect.anything())
    expect(tools[0].parameters.additionalProperties).toBe(false)
  })
  it('pi refreshes existing debugger tool context at a safe request boundary without sending input', async () => {
    const b = bridge()
    let context!: (event: any, ctx: any) => Promise<any>
    registerDebuggerContext(
      {
        on: (_event: any, handler: any) => {
          context = handler
          return () => {}
        },
      } as any,
      b
    )
    const message = {
      role: 'toolResult',
      toolName: 'debug_status',
      toolCallId: 'call',
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            requested: { data: 'retained value' },
            snapshot: {
              debug_session_id: 'selected',
              incarnation: 'fixture-incarnation',
              state_revision: 0,
            },
          }),
        },
      ],
    }
    const updated = await context({ messages: [message] }, {})
    expect(JSON.parse(updated.messages[0].content[0].text)).toMatchObject({
      requested: { data: 'retained value' },
      current_observation: { snapshot: { state_revision: 1, execution: 'mixed' } },
    })
    b.call.mockResolvedValueOnce({ code: 'unauthorized', snapshot: null } as any)
    const revoked = await context({ messages: [message] }, {})
    expect(JSON.parse(revoked.messages[0].content[0].text)).toMatchObject({
      snapshot: null,
      code: 'unauthorized',
    })
    expect(revoked.messages[0].content[0].text).not.toContain('retained value')
    expect(message.content[0]!.text).toContain('retained value')
  })
  it('publication is checked again at provider delivery after an intervening revocation', async () => {
    const b = bridge()
    b.publish.mockImplementation(() => ({ code: 'unauthorized', snapshot: null }))
    const tools: any[] = []
    registerDebuggerTools({ registerTool: (tool: any) => tools.push(tool) }, b)
    const result = await tools[0].execute('call', { debug_session_id: 'selected' })
    expect(JSON.parse(result.content[0].text)).toEqual({ code: 'unauthorized', snapshot: null })
  })
})
