import { it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSdkHost, type HostConfiguration } from '../packages/provider-pi/src/sdk-runtime.js'
// @ts-expect-error JS SDK facade; no SDK code or inference is imported
import { createSdkDouble } from './fixtures/pi-sdk-double.mjs'
it.each(['project', 'global', 'symlink'])(
  'isolated never discovers or reads %s SYSTEM/APPEND_SYSTEM sources, including after replacement',
  async (location) => {
    const dir = mkdtempSync(join(tmpdir(), 'abele-pi-isolation-')),
      root = realpathSync(dir),
      cwd = join(root, 'repo'),
      agentDir = join(root, 'agent'),
      sessionDir = join(root, 'sessions')
    for (const d of [cwd, agentDir, sessionDir, join(cwd, '.pi')]) mkdirSync(d, { recursive: true })
    const secret = join(root, 'private-fixture.txt')
    writeFileSync(secret, 'DO_NOT_INHERIT_FIXTURE')
    const resourceRoot = location === 'global' ? agentDir : join(cwd, '.pi')
    for (const name of ['SYSTEM.md', 'APPEND_SYSTEM.md']) {
      if (location === 'symlink') symlinkSync(secret, join(resourceRoot, name))
      else writeFileSync(join(resourceRoot, name), 'DO_NOT_INHERIT_FIXTURE')
    }
    const config: HostConfiguration = {
      cwd,
      agentDir,
      sessionDir,
      provider: 'fixture',
      model: 'tiny',
      profile: 'isolated',
      maxTokens: 512,
    }
    const { sdk, state } = createSdkDouble()
    let host: Awaited<ReturnType<typeof createSdkHost>> | undefined
    try {
      host = await createSdkHost(
        sdk,
        config,
        async () => ({ choice: 'deny', delivered: () => true }),
        new AbortController().signal,
        () => {}
      )
      await host.prompt('/new')
      expect(state.reads).toEqual([])
      expect(state.tools.every((tool: any) => tool.name === 'bash')).toBe(true)
      // An embedding without the worker hooks must deny execution rather than
      // silently retaining the SDK's unsupervised detached-shell backend.
      await expect(
        state.tools[0].options.operations.exec('forbidden', cwd, { onData: () => {} })
      ).rejects.toThrow(/supervisor_required/)
      for (const options of state.serviceOptions) {
        expect(options.resourceLoaderOptions.systemPrompt).toBe('')
        expect(options.resourceLoaderOptions.appendSystemPrompt).toEqual([])
      }
      await host.dispose()
      host = undefined
      const inherited = createSdkDouble()
      host = await createSdkHost(
        inherited.sdk,
        { ...config, profile: 'inherited' },
        async () => ({ choice: 'deny', delivered: () => true }),
        new AbortController().signal,
        () => {}
      )
      expect(inherited.state.reads).toHaveLength(2)
    } finally {
      await host?.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  }
)
