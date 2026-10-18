import { afterEach, expect, it, vi } from 'vitest'

const effects = vi.hoisted(() => ({
  lock: vi.fn(),
  recover: vi.fn(() => {
    throw new Error('supported platform reached recovery')
  }),
  exists: vi.fn(),
  workdir: vi.fn(),
  write: vi.fn(),
  spawn: vi.fn(),
}))
vi.mock('@abele/node-core', () => ({ acquireUpdateLock: effects.lock }))
vi.mock('../packages/node-daemon/src/service.js', () => ({
  recoverServiceTransition: effects.recover,
}))
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  existsSync: effects.exists,
  mkdtempSync: effects.workdir,
  writeFileSync: effects.write,
}))
vi.mock('node:child_process', () => ({ spawn: effects.spawn }))
import { update } from '../packages/node-daemon/src/update.js'

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!
const archDescriptor = Object.getOwnPropertyDescriptor(process, 'arch')!
function mockPlatform(platform: string, arch: string) {
  Object.defineProperty(process, 'platform', { value: platform })
  Object.defineProperty(process, 'arch', { value: arch })
}
afterEach(() => {
  Object.defineProperty(process, 'platform', platformDescriptor)
  Object.defineProperty(process, 'arch', archDescriptor)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it.each([[], ['--check'], ['--force'], ['--version', '0.4.31']].map((args) => ({ args })))(
  'rejects Darwin x64 before update side effects: $args',
  async ({ args }) => {
    mockPlatform('darwin', 'x64')
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const report = await update('/invented/runtime', args)
    expect(report).toMatchObject({
      status: 'failed',
      exit_code: 1,
      error: expect.stringContaining('Unsupported platform: macOS x64'),
      agents: { admission_paused: false, admission_resumed: false },
      installer: null,
    })
    for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  }
)

it.each([
  ['darwin', 'arm64'],
  ['linux', 'x64'],
  ['linux', 'arm64'],
] as const)('allows %s %s through the update platform gate', async (platform, arch) => {
  mockPlatform(platform, arch)
  const report = await update('/invented/runtime', [])
  expect(effects.recover).toHaveBeenCalledWith('/invented/runtime')
  expect(report.error).toContain('supported platform reached recovery')
})
