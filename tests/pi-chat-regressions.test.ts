import { afterEach, expect, it, vi } from 'vitest'
import { createWorkerCore } from '../packages/provider-pi/src/worker-core.js'
import { piSessionUpdates, sessionUpdatesOf, SessionSettingsSchema } from '@abele/node-protocol'
import { PiProviderAdapter } from '@abele/provider-pi'
import { registerDebuggerContext } from '../packages/provider-pi/src/debugger.js'
import { nodeToolFailure } from '../packages/provider-pi/src/tool-error.js'

afterEach(() => vi.useRealTimers())
it('keeps language and session tool results in the next model context', async () => {
  let handler: any
  registerDebuggerContext(
    {
      on: ((_name: string, fn: any) => {
        handler = fn
      }) as any,
    },
    {
      tools: ['lsp', 'node_sessions'].map((name) => ({ name, description: '', inputSchema: {} })),
      call: async () => {
        throw Error('unexpected debugger refresh')
      },
      publish: (_args, result) => result,
      close() {},
    }
  )
  const messages = ['lsp', 'node_sessions'].map((toolName) => ({
    role: 'toolResult',
    toolName,
    content: [{ type: 'text', text: '{"locations":[]}' }],
  }))
  expect(await handler({ messages }, {})).toEqual({ messages })
})
it('describes refused and unavailable language servers as completed failures', () => {
  expect(nodeToolFailure('lsp', Error('untrusted_folder')).message).toContain('not trusted')
  expect(nodeToolFailure('lsp', Error('lsp_unavailable')).message).toContain('project dependencies')
})
it('accepts the qualified model ids the pi worker offers', () => {
  const settings = { model: 'openai/gpt-6.1-sol:fast' }
  expect(SessionSettingsSchema.parse(settings)).toEqual(settings)
  expect(() =>
    new PiProviderAdapter({ stateDir: '/fixture' }).validateSettings(settings)
  ).not.toThrow()
})
it('bounds an unanswered lsp bridge call and cancels the daemon request', async () => {
  vi.useFakeTimers()
  const sent: any[] = []
  const core = createWorkerCore(
    (m) => sent.push(m),
    new AbortController().signal,
    () => true
  )
  let result: any
  const pending = core.debuggerCall('lsp', {}).then((r) => {
    result = r
  })
  await vi.advanceTimersByTimeAsync(30000)
  expect(result).toMatchObject({ code: 'lsp_timeout' })
  expect(result.message).toContain('30 seconds')
  expect(sent.at(-1)).toMatchObject({ kind: 'debugger_cancel', id: sent[0].id })
  core.release()
  await pending
})
it('replays each accepted owner message under its durable input id', () => {
  const updates = ['first', 'revision', 'rename', 'continue', 'test'].flatMap((text, i) =>
    sessionUpdatesOf({
      type: 'input.accepted',
      actor: { kind: 'installation' },
      data: { input_id: `i${i}`, text },
    })
  )
  expect(updates).toEqual(
    ['first', 'revision', 'rename', 'continue', 'test'].map((text, i) => ({
      kind: 'user_message',
      message_id: `i${i}`,
      text,
    }))
  )
  expect(
    sessionUpdatesOf({
      type: 'input.accepted',
      actor: { kind: 'installation' },
      data: { input_id: 'mapped', text: 'already mapped', mapped: true },
    })
  ).toEqual([])
})
it('keeps the extension identity and error readable in replay', () => {
  expect(
    piSessionUpdates('pi.extension.error', {
      extension: 'pi-mcp-adapter',
      error: 'server unavailable',
      event: 'session_start',
    })
  ).toEqual([
    {
      kind: 'notice',
      level: 'error',
      code: 'extension_error',
      text: 'pi extension pi-mcp-adapter failed (session_start): server unavailable',
    },
  ])
})
