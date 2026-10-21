import { it, expect } from 'vitest'
import { PiExtensionUiBridge, PiSdkWorker } from '../packages/provider-pi/src/host.js'
it.each([
  'setFooter',
  'setHeader',
  'setTitle',
  'setWorkingMessage',
  'setWorkingVisible',
  'setWorkingIndicator',
  'setHiddenThinkingLabel',
  'setEditorText',
  'setEditorComponent',
  'pasteToEditor',
  'addAutocompleteProvider',
])('warns for headless %s without aborting extension lifecycle hooks', (method) => {
  const events: any[] = []
  const ui = new PiExtensionUiBridge(
    async () => ({ choice: 'deny', delivered: () => true }),
    new AbortController().signal,
    (e) => events.push(e)
  )
  expect(() => ui.context[method]('children', ['working'])).not.toThrow()
  expect(events).toContainEqual(expect.objectContaining({ type: 'pi.extension.warning' }))
  // The SDK spreads the UI context before hooks see it; the warning must survive.
  events.length = 0
  expect(() => ({ ...ui.context })[method]('children', ['working'])).not.toThrow()
  expect(events).toContainEqual(
    expect.objectContaining({
      type: 'pi.extension.warning',
      data: expect.objectContaining({ capability: method }),
    })
  )
})
it('keeps a final answer successful when an agent_end hook throws', async () => {
  let listener: (e: any) => void = () => {}
  let bindings: any
  const events: any[] = []
  const session = {
    sessionId: 'session',
    sessionFile: '/state/session.jsonl',
    subscribe: (cb: any) => {
      listener = cb
      return () => {}
    },
    bindExtensions: async (b: any) => {
      bindings = b
    },
    abort: async () => {},
    waitForIdle: async () => {},
    prompt: async (_text: string, options: any) => {
      options.preflightResult(true)
      listener({
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Done' }],
          stopReason: 'stop',
        },
      })
      bindings.onError({
        extensionPath: '/extensions/status.ts',
        event: 'agent_end',
        error: 'status unavailable',
      })
    },
  }
  const worker = new PiSdkWorker(
    { session, setRebindSession: () => {} },
    (e) => events.push(e),
    () => ({})
  )
  await worker.bind()
  expect(await worker.prompt('work')).toMatchObject({ subtype: 'success', is_error: false })
  expect(events.find((e) => e.type === 'pi.extension.warning')?.data).toMatchObject({
    extension: '/extensions/status.ts',
    error: 'status unavailable',
  })
  worker.dispose()
})
it.each(['custom', 'command'])(
  'does not complete success after SDK swallows %s extension-command errors',
  async (kind) => {
    const events: any[] = []
    let bindings: any
    const ui = new PiExtensionUiBridge(
      async () => ({ choice: 'deny', delivered: () => true }),
      new AbortController().signal,
      (e) => events.push(e)
    )
    const session = {
      sessionId: 'session',
      sessionFile: '/state/session.jsonl',
      subscribe: () => () => {},
      bindExtensions: async (b: any) => {
        bindings = b
      },
      abort: async () => {},
      waitForIdle: async () => {},
      prompt: async (_text: string, options: any) => {
        // 0.87.0 _tryExecuteExtensionCommand catches, reports, returns handled;
        // prompt then reports preflight(true) and resolves without assistant output.
        try {
          if (kind === 'custom') await bindings.uiContext.custom(() => {})
          else throw Error('FAKE_SECRET')
        } catch (error) {
          bindings.onError({ event: 'command:/fixture', error })
        }
        options.preflightResult(true)
      },
    }
    const worker = new PiSdkWorker(
      { session, setRebindSession: () => {} },
      (e) => events.push(e),
      () => ({ uiContext: ui.context, onError: () => events.push({ type: 'pi.extension.error' }) })
    )
    await worker.bind()
    expect(await worker.prompt('/fixture')).toMatchObject({
      subtype: 'error',
      is_error: true,
      terminal_reason: 'extension_error',
    })
    expect(events.map((e) => e.type)).toContain('pi.extension.error')
    expect(JSON.stringify(events)).not.toContain('FAKE_SECRET')
    worker.dispose()
  }
)
