import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { NodeCore } from '../../packages/node-core/src/index.js'
import {
  JsDebugProfile,
  validateJsLaunch,
  validateJsAttach,
} from '../../packages/node-core/src/debugger/js-profile.js'
import {
  JS_DEBUG_AUDIT,
  JS_DEBUG_PIN,
  installJsAdapter,
  unpackJsAdapter,
  verifyJsInstallation,
} from '../../packages/node-core/src/debugger/js-install.js'

export function tar(files: Record<string, string>, type = '0') {
  const blocks: Buffer[] = []
  for (const [name, content] of Object.entries(files)) {
    const bytes = Buffer.from(content),
      header = Buffer.alloc(512)
    header.write(name)
    header.write('0000600\0', 100)
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124)
    header.fill(32, 148, 156)
    header.write(type, 156)
    header.write('ustar\0', 257)
    const sum = [...header].reduce((a, b) => a + b, 0)
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148)
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}
const archive = () =>
  tar({
    'js-debug/src/dapDebugServer.js': '/* fake adapter */',
    'js-debug/LICENSE': 'MIT License\nCopyright fixture',
  })
const pin = (bytes: Buffer) => ({
  version: '0.0.0-fixture',
  sha256: createHash('sha256').update(bytes).digest('hex'),
  license: 'MIT' as const,
  url: 'https://example.invalid/adapter.tar.gz',
})

describe('explicit JS adapter installation and gated native profile', () => {
  it('pins the approved 1.140.0, downloads only its URL and keeps nothing that fails the checksum', async () => {
    // The owner accepted this release with its recorded advisories on 2026-10-14.
    expect(JS_DEBUG_PIN).toEqual({
      version: JS_DEBUG_AUDIT.candidate.version,
      sha256: JS_DEBUG_AUDIT.candidate.sha256,
      license: 'MIT',
      url: 'https://github.com/microsoft/vscode-js-debug/releases/download/v1.140.0/js-debug-dap-v1.140.0.tar.gz',
    })
    expect(JS_DEBUG_AUDIT.advisories).toContain('GHSA-pqg4-j6r4-53mv')
    const dir = mkdtempSync(join(tmpdir(), 'adapter-download-'))
    const download = vi.fn(async () => {
      const response = new Response(archive())
      Object.defineProperty(response, 'url', { value: JS_DEBUG_PIN!.url })
      return response
    })
    vi.stubGlobal('fetch', download)
    vi.stubEnv('ABELE_B0_ALLOW_AUDITED_RELEASE', '1')
    try {
      await expect(installJsAdapter(dir)).rejects.toThrow('adapter_checksum')
      expect(download).toHaveBeenCalledTimes(1)
      expect((download.mock.calls[0] as unknown[])[0]).toBe(JS_DEBUG_PIN!.url)
      expect(existsSync(join(dir, 'debugger/adapters/js-debug/1.140.0'))).toBe(false)
    } finally {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('verifies archives before writing and records exact version, checksum, license and file hashes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-install-'))
    try {
      const bytes = archive(),
        release = pin(bytes),
        destination = join(dir, 'adapter')
      await expect(
        unpackJsAdapter(destination, { ...release, sha256: 'a'.repeat(64) }, bytes)
      ).rejects.toThrow('adapter_checksum')
      const installed = await unpackJsAdapter(destination, release, bytes)
      expect(installed.version).toBe(release.version)
      expect(installed.license).toBe('MIT')
      expect(installed.sha256).toBe(release.sha256)
      expect(installed.files['src/dapDebugServer.js']).toMatch(/^[a-f0-9]{64}$/)
      expect(JSON.parse(readFileSync(join(destination, 'installation.json'), 'utf8'))).toEqual(
        installed
      )
      await expect(unpackJsAdapter(destination, release, bytes)).rejects.toThrow(
        'adapter_already_installed'
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('rechecks installed bytes against the pinned archive, not mutable manifest hashes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-install-')),
      destination = join(dir, 'adapter')
    try {
      const bytes = archive(),
        release = pin(bytes)
      const installed = await unpackJsAdapter(destination, release, bytes)
      expect((await verifyJsInstallation(destination, release)).version).toBe(release.version)
      writeFileSync(join(destination, 'src/dapDebugServer.js'), 'tampered')
      installed.files['src/dapDebugServer.js'] = createHash('sha256')
        .update('tampered')
        .digest('hex')
      writeFileSync(join(destination, 'installation.json'), JSON.stringify(installed))
      await expect(verifyJsInstallation(destination, release)).rejects.toThrow(
        'adapter_install_mismatch'
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it.each([
    ['../escape', '0'],
    ['js-debug/../../escape', '0'],
    ['/js-debug/file', '0'],
    ['js-debug/link', '2'],
    ['js-debug/link', '1'],
  ])('rejects archive traversal and links %s', async (name, type) => {
    const dir = mkdtempSync(join(tmpdir(), 'adapter-install-'))
    try {
      const bytes = tar({ [name]: 'unsafe' }, type)
      await expect(unpackJsAdapter(dir, pin(bytes), bytes)).rejects.toThrow('adapter_archive')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('validates exact native argv/env, loopback attachment and source confinement', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'js-config-'))
    const program = join(dir, 'tiny.cjs')
    writeFileSync(program, 'setInterval(()=>{},1000)')
    try {
      expect(
        (
          await validateJsLaunch({
            cwd: dir,
            executable: process.execPath,
            program,
            argv: ['--test'],
            env: { TEST: 'value' },
          })
        ).argv
      ).toEqual(['--test'])
      await expect(
        validateJsLaunch({ cwd: dir, executable: process.execPath, program, argv: ['\0'], env: {} })
      ).rejects.toThrow('invalid_debugger_configuration')
      await expect(
        validateJsLaunch({
          cwd: dir,
          executable: process.execPath,
          program,
          argv: [],
          env: {},
          console: 'integratedTerminal',
        } as any)
      ).rejects.toThrow('invalid_debugger_configuration')
      await expect(
        validateJsLaunch({
          cwd: dir,
          executable: process.execPath,
          program: process.execPath,
          argv: [],
          env: {},
        })
      ).rejects.toThrow('debugger_path_escape')
      expect(validateJsAttach({ port: 12345, address: '127.0.0.1', target_pid: 123 }).port).toBe(
        12345
      )
      expect(() =>
        validateJsAttach({ port: 12345, address: '0.0.0.0', target_pid: 123 } as any)
      ).toThrow('invalid_debugger_configuration')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('requires capability + explicit switch + an installed adapter, never exposes control RPC', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'js-profile-')),
      core = new NodeCore(dir, { debuggerEnabled: true })
    try {
      const profile = new JsDebugProfile(core.debugger, { stateDirectory: dir })
      expect(profile.profiles()).toEqual([])
      await expect(
        profile.attach({ port: 12345, address: '127.0.0.1', target_pid: 123 }, {} as any)
      ).rejects.toThrow('js_debug_disabled')
      const requested = new JsDebugProfile(core.debugger, { stateDirectory: dir, enabled: true })
      expect(requested.profiles()).toEqual([])
      await expect(
        requested.attach({ port: 12345, address: '127.0.0.1', target_pid: process.pid }, {} as any)
      ).rejects.toThrow('js_debug_not_installed')
      for (const method of ['debugger.v1.launch', 'debugger.v1.attach', 'debugger.v1.terminate']) {
        const token = core.createToken('fixture')
        expect(() => core.request(core.authority.authenticate(token.token), method, {})).toThrow(
          'unsupported_method'
        )
      }
    } finally {
      core.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('offers an explicit CLI install command that takes no version or source of its own', () => {
    const dir = mkdtempSync(join(tmpdir(), 'js-cli-'))
    try {
      const result = spawnSync(
        process.execPath,
        [
          'packages/node-daemon/dist/cli.js',
          'debugger',
          'install',
          'js',
          '9.9.9',
          '--state-dir',
          join(dir, 'state'),
          '--json',
        ],
        { encoding: 'utf8' }
      )
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Usage: abele-node debugger install js')
      expect(existsSync(join(dir, 'state'))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
