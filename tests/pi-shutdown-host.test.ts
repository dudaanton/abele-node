import { expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSdkHost } from '../packages/provider-pi/src/sdk-runtime.js'
// @ts-expect-error Model-free SDK facade, also used by the worker fixture.
import { createSdkDouble } from './fixtures/pi-sdk-double.mjs'

it('reports swallowed SDK shutdown errors only after disposal, before bounded completion', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pi-shutdown-host-'))
  const sessionDir = join(root, 'sessions')
  mkdirSync(sessionDir)
  const { sdk, state } = createSdkDouble({ shutdownError: true })
  const events: any[] = []
  const host = await createSdkHost(
    sdk,
    {
      cwd: root,
      sessionDir,
      agentDir: root,
      provider: 'fixture',
      model: 'tiny',
      profile: 'isolated',
      maxTokens: 512,
    },
    async () => ({ choice: 'deny', delivered: () => false }),
    new AbortController().signal,
    (event) => events.push(event)
  )
  try {
    const result = await host.prompt('successful fake prompt')
    expect(host.completionResult(result)).toMatchObject({ subtype: 'success', is_error: false })
    expect(state.shutdowns).toBe(0)
    await host.dispose()
    expect(state.shutdowns).toBe(1)
    expect(host.completionResult(result)).toMatchObject({
      subtype: 'success',
      is_error: false,
    })
    const types = events.map((event) => event.type)
    expect(types.indexOf('pi.agent_settled')).toBeLessThan(types.indexOf('pi.extension.warning'))
    expect(JSON.stringify(events)).not.toContain('FAKE_SHUTDOWN_SECRET')
  } finally {
    if (!state.shutdowns) await host.dispose()
    rmSync(root, { recursive: true, force: true })
  }
})
