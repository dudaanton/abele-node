import { it, expect } from 'vitest'
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSdkHost, type HostConfiguration } from '../packages/provider-pi/src/sdk-runtime.js'
// @ts-expect-error deterministic JS SDK facade, never the installed SDK
import { createSdkDouble } from './fixtures/pi-sdk-double.mjs'
const ask = async () => ({ choice: 'deny' as const, delivered: () => true })
it.each(['/unauthorized', '/emptycmd', '/new'])(
  'materializes lazy SDK state before publishing a mapping for %s, then reopens the exact context',
  async (text) => {
    const dir = mkdtempSync(join(tmpdir(), 'abele-pi-lazy-')),
      root = realpathSync(dir),
      files = join(root, 'sessions')
    mkdirSync(files)
    const config: HostConfiguration = {
      cwd: root,
      sessionDir: files,
      agentDir: root,
      provider: 'fixture',
      model: 'tiny',
      profile: 'isolated',
      maxTokens: 512,
    }
    const { sdk, state } = createSdkDouble()
    const mappings: any[] = []
    let host: Awaited<ReturnType<typeof createSdkHost>> | undefined
    try {
      host = await createSdkHost(sdk, config, ask, new AbortController().signal, (e) => {
        if (e.type === 'pi.session.bound') {
          mappings.push(e.data)
          // The fake SDK has not generated an assistant response at bind time.
          expect(existsSync(e.data.native_session_file)).toBe(true)
          expect(statSync(e.data.native_session_file).mode & 0o777).toBe(0o600)
        }
      })
      if (text === '/unauthorized') await expect(host.prompt(text)).rejects.toThrow(/authorization/)
      else await host.prompt(text)
      const latest = mappings.at(-1)
      await host.dispose()
      host = undefined
      const content = readFileSync(latest.native_session_file, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
      expect(content[0].id).toBe(latest.native_session_id)
      expect(
        content.slice(1).every((e: any) => e.type !== 'message' || e.message.role !== 'assistant')
      ).toBe(true)
      expect(content.some((e: any) => e.customType === 'sdk-initialization')).toBe(true)
      host = await createSdkHost(
        sdk,
        { ...config, ...latest },
        ask,
        new AbortController().signal,
        () => {}
      )
      expect(state.runtime.session.sessionId).toBe(latest.native_session_id)
      expect(await host.prompt('authorization repaired; fake response')).toMatchObject({
        subtype: 'success',
      })
      expect(readFileSync(latest.native_session_file, 'utf8')).toContain('fake response')
    } finally {
      await host?.dispose()
      rmSync(root, { recursive: true, force: true })
    }
  }
)
