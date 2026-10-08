import { it, expect } from 'vitest'
import { PiExtensionUiBridge, PiSdkWorker } from '../packages/provider-pi/src/host.js'
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
