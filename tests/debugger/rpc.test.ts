import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NodeCore } from '@abele/node-core'
import { startDaemon } from '@abele/node-daemon'
import { NodeClient, MemoryClientStore } from '@abele/node-client'

// Synthetic hosts, no profiles/adapter downloads or model execution.
describe('gated debugger daemon RPC', () => {
  it.each([false, true])(
    'advertises only with explicit enablement (%s), through authenticated channels',
    async (enabled) => {
      const dir = mkdtempSync(join(tmpdir(), 'debug-rpc-'))
      const core = new NodeCore(dir)
      const token = core.createToken('fixture')
      core.close()
      const daemon = await startDaemon(
        dir,
        0,
        undefined,
        {},
        undefined,
        undefined,
        {},
        { enabled: false },
        { enabled }
      )
      const client = new NodeClient(
        {
          url: `ws://127.0.0.1:${daemon.port}/channel`,
          token: token.token,
          profile: 'local-token-v1',
        },
        new MemoryClientStore()
      )
      try {
        await client.connect()
        const report: any = await client.describe()
        if (enabled) {
          expect(report.capabilities.capabilities.debugger_v1.status).toBe('supported')
          expect(await client.request('debugger.v1.profiles', {})).toEqual([])
          expect(await client.request('debugger.v1.policy.get', {})).toMatchObject({
            mode: 'ask',
          })
          await expect(client.request('debugger.v1.launch', {})).rejects.toThrow(
            'unsupported_method'
          )
        } else {
          expect(report.capabilities.capabilities).not.toHaveProperty('debugger_v1')
          await expect(client.request('debugger.v1.profiles', {})).rejects.toThrow(
            'unsupported_method'
          )
        }
      } finally {
        await client.disconnect()
        await daemon.stop()
        rmSync(dir, { recursive: true, force: true })
      }
    }
  )
  it('never dispatches a debugger effect from a retained ordinary offline outbox', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'debug-outbox-'))
    const core = new NodeCore(dir)
    const token = core.createToken('fixture')
    core.close()
    const daemon = await startDaemon(
      dir,
      0,
      undefined,
      {},
      undefined,
      undefined,
      {},
      { enabled: false }
    )
    const store = new MemoryClientStore()
    await store.transaction((s) => {
      s.outbox.push({ operation_id: 'offline', method: 'debugger.v1.step', params: {} })
    })
    const client = new NodeClient(
      {
        url: `ws://127.0.0.1:${daemon.port}/channel`,
        token: token.token,
        profile: 'local-token-v1',
      },
      store
    )
    try {
      await client.connect()
      expect(await client.operationResult('offline')).toEqual({ error: 'debugger_online_only' })
    } finally {
      await client.disconnect()
      await daemon.stop()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
