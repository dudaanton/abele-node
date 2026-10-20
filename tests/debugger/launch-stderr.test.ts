import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { JsDebugProfile } from '../../packages/node-core/src/debugger/js-profile.js'
import { OwnedDebugProcess } from '../../packages/node-core/src/debugger/process.js'
import { target } from './helpers.js'

vi.mock('../../packages/node-core/src/debugger/js-install.js', () => ({
  requireJsPin: () => ({}),
  jsAdapterInstalled: () => true,
}))
vi.mock('../../packages/node-core/src/debugger/js-startup.js', () => ({
  holdJsStartup: async () => () => {},
}))

it.each(['debugger_startup_handoff_lost', 'debugger_program_ended'])(
  'retains owned stderr through cleanup: %s',
  async (reason) => {
    const dir = await mkdtemp(join(tmpdir(), 'launch-stderr-'))
    await writeFile(join(dir, 'main.js'), '')
    const owner = Object.assign(new EventEmitter(), {
      evidence: {},
      diagnostics: { stderr: 'initial stderr' },
      waitForText: async () => ['ws://127.0.0.1:1234/id', '1234'],
      terminate: vi.fn(async () => {
        owner.diagnostics.stderr += '\nfinal fatal error'
      }),
    })
    const spawn = vi.spyOn(OwnedDebugProcess, 'spawn').mockResolvedValue(owner as any)
    const profile = new JsDebugProfile({ enabled: true, assertEffectsAvailable() {} } as any, {
      stateDirectory: dir,
      enabled: true,
    })
    const close = vi.fn(async () => {})
    vi.spyOn(profile as any, 'open').mockResolvedValue({
      program: async () => {
        if (reason === 'debugger_program_ended') throw new Error(reason)
        return {
          snapshot: { threads: [] },
          dap: {
            onEvent: () => () => {},
            onClose: (listener: () => void) => {
              queueMicrotask(listener)
              return () => {}
            },
          },
        }
      },
      close,
    })
    try {
      await expect(
        profile.launch(
          {
            cwd: dir,
            executable: process.execPath,
            program: join(dir, 'main.js'),
            argv: [],
            env: {},
          },
          target
        )
      ).rejects.toMatchObject({
        code: reason,
        details: { stderr: 'initial stderr\nfinal fatal error' },
      })
      expect(close).toHaveBeenCalledOnce()
      expect(owner.terminate).toHaveBeenCalledOnce()
    } finally {
      spawn.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  }
)
