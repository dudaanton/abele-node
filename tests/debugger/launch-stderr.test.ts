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

it('forwards owned program pipes to the program session until detach', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'launch-output-'))
  await writeFile(join(dir, 'main.js'), '')
  const owner = Object.assign(new EventEmitter(), {
    evidence: {},
    waitForText: async () => ['ws://127.0.0.1:1234/id', '1234'],
    terminate: vi.fn(async () => {}),
  })
  const spawn = vi.spyOn(OwnedDebugProcess, 'spawn').mockResolvedValue(owner as any)
  const profile = new JsDebugProfile({ enabled: true, assertEffectsAvailable() {} } as any, {
    stateDirectory: dir,
    enabled: true,
  })
  const closeListeners = new Set<() => void>()
  const session = {
    snapshot: { threads: [{ status: 'stopped' }] },
    markEntryPause: vi.fn(),
    recordOutput: vi.fn(),
    dap: {
      onEvent: () => () => {},
      onClose: (listener: () => void) => {
        closeListeners.add(listener)
        return () => closeListeners.delete(listener)
      },
    },
  }
  vi.spyOn(profile as any, 'open').mockResolvedValue({ program: async () => session })
  try {
    await profile.launch(
      {
        cwd: dir,
        executable: process.execPath,
        program: join(dir, 'main.js'),
        argv: [],
        env: {},
        stop_on_entry: true,
      },
      target
    )
    owner.emit('output', 'hello\n', 'stdout')
    owner.emit('output', 'warning\n', 'stderr')
    expect(session.recordOutput.mock.calls).toEqual([
      ['hello\n', 'stdout'],
      ['warning\n', 'stderr'],
    ])
    for (const listener of closeListeners) listener()
    owner.emit('output', 'detached\n', 'stdout')
    expect(session.recordOutput).toHaveBeenCalledTimes(2)
    expect(owner.listenerCount('output')).toBe(0)
  } finally {
    spawn.mockRestore()
    await rm(dir, { recursive: true, force: true })
  }
})

it.each(['debugger_startup_handoff_lost', 'debugger_program_ended'])(
  'retains owned stderr through cleanup: %s',
  async (reason) => {
    const dir = await mkdtemp(join(tmpdir(), 'launch-stderr-'))
    await writeFile(join(dir, 'main.js'), '')
    const owner = Object.assign(new EventEmitter(), {
      evidence: {},
      diagnostics: { stderr: 'initial stderr', exit_code: 1, signal: null },
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
        details: { stderr: 'initial stderr\nfinal fatal error', exit_code: 1, signal: null },
      })
      expect(close).toHaveBeenCalledOnce()
      expect(owner.terminate).toHaveBeenCalledOnce()
    } finally {
      spawn.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  }
)
