import { it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSdkHost, type HostConfiguration } from '../packages/provider-pi/src/sdk-runtime.js'
// @ts-expect-error deterministic SDK facade; no model requests
import { createSdkDouble } from './fixtures/pi-sdk-double.mjs'
it('resolves omitted model selection from user-only SDK settings, including isolated mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'abele-pi-model-')),
    cwd = realpathSync(dir),
    sessionDir = join(cwd, 'sessions')
  mkdirSync(sessionDir)
  const { sdk, state } = createSdkDouble({
    defaultProvider: 'example-provider',
    defaultModel: 'example-model',
  })
  const config: HostConfiguration = {
    cwd,
    sessionDir,
    agentDir: cwd,
    provider: '',
    model: '',
    profile: 'isolated',
    maxTokens: 512,
  }
  let host: Awaited<ReturnType<typeof createSdkHost>> | undefined
  try {
    host = await createSdkHost(
      sdk,
      config,
      async () => ({ choice: 'deny', delivered: () => true }),
      new AbortController().signal,
      () => {}
    )
    expect(state.selectedModels).toEqual([{ provider: 'example-provider', id: 'example-model' }])
    expect(state.settingsOptions).toContainEqual({ projectTrusted: false })
    expect(state.reads).toEqual([])
  } finally {
    await host?.dispose()
    rmSync(cwd, { recursive: true, force: true })
  }
})
