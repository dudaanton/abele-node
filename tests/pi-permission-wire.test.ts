import { expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { PiProviderAdapter } from '@abele/provider-pi'
import { ParentMessageSchema } from '../packages/provider-pi/src/wire.js'

const captured = vi.hoisted(() => ({ start: undefined as any }))
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>()
  const { EventEmitter } = await import('node:events')
  const { writeFileSync } = await import('node:fs')
  const { PiApprovalPolicy } = await import('../packages/provider-pi/src/host.js')
  return {
    ...actual,
    spawn: () => {
      const child: any = new EventEmitter()
      Object.assign(child, { pid: 400000000, connected: true, exitCode: null, signalCode: null })
      let answer: (value: any) => void
      child.send = (message: any, callback: any) => {
        callback?.()
        if (message.kind === 'answer') answer({ choice: message.choice, delivered: () => true })
        if (message.kind !== 'start') return
        captured.start = message
        void (async () => {
          const policy = new PiApprovalPolicy(
            async (action) =>
              new Promise((resolve) => {
                answer = resolve
                child.emit('message', { kind: 'question', id: 'edit', action })
              }),
            new AbortController().signal
          )
          policy.bypass = message.config.permission_mode === 'bypassPermissions'
          const denied = await policy.intercept({
            tool_use_id: 'edit',
            tool_name: 'write',
            input: { path: 'pi-allowed.txt' },
          })
          if (!denied) writeFileSync(join(message.config.cwd, 'pi-allowed.txt'), 'approved')
          child.emit('message', { kind: 'done', result: { subtype: 'success', is_error: false } })
          child.connected = false
          child.exitCode = 0
          child.emit('close', 0, null)
        })()
      }
      queueMicrotask(() =>
        child.emit('message', {
          kind: 'ready',
          evidence: {
            pid: child.pid,
            group: child.pid,
            fingerprint: 'fake-worker',
          },
        })
      )
      return child
    },
  }
})

it.each(['manual', 'bypassPermissions'] as const)(
  'the bounded pi worker receives %s without changing its effort',
  async (permission_mode) => {
    const dir = mkdtempSync(resolve('.scratch/pi-permission-wire-'))
    // No OS process is created: the injected probe describes the fake worker's exit.
    const adapter = new PiProviderAdapter({
      stateDir: dir,
      allowBypass: true,
      deadlineMs: 10000,
      processProbe: { identity: () => undefined, groupMembers: () => [] },
    })
    let asks = 0
    let run: Awaited<ReturnType<typeof adapter.startTurn>> | undefined
    try {
      run = await adapter.startTurn(
        {
          session_id: randomUUID(),
          run_id: randomUUID(),
          cwd: dir,
          text: 'allow',
          permission_mode,
        },
        {
          event: () => {},
          processes: () => {},
          permission: async () => {
            asks++
            return { choice: 'deny', delivered: () => true }
          },
        }
      )
      expect(await run.done).toMatchObject({ result: { is_error: false } })
      const start = ParentMessageSchema.parse(captured.start)
      if (start.kind !== 'start') throw new Error('expected start configuration')
      expect(start.config.permission_mode).toBe(permission_mode)
      expect(captured.start.config.live).toBeUndefined()
      expect(asks).toBe(permission_mode === 'manual' ? 1 : 0)
      if (permission_mode === 'bypassPermissions')
        expect(readFileSync(join(dir, 'pi-allowed.txt'), 'utf8')).toBe('approved')
    } finally {
      await run?.interrupt()
      rmSync(dir, { recursive: true, force: true })
    }
  }
)
