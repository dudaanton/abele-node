import { expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { discoverCodex } from '../packages/provider-codex/src/discovery.js'
import { RpcPeer } from '../packages/provider-codex/src/rpc.js'

async function fixture(mode: string, test: (peer: RpcPeer, evidence: any[]) => Promise<void>) {
  const dir = mkdtempSync(resolve('.scratch/codex-rpc-'))
  writeFileSync(join(dir, 'fixture.json'), JSON.stringify({ mode }))
  let peer: RpcPeer | undefined
  const evidence: any[] = []
  try {
    peer = await RpcPeer.start({
      executable: discoverCodex({ executable: resolve('tests/fixtures/codex.mjs'), fixture: true }),
      cwd: dir,
      home: dir,
      timeoutMs: 100,
      processes: (p) => evidence.push(...p),
    })
    await test(peer, evidence)
  } finally {
    await peer?.close()
    if (evidence.length) expect(() => process.kill(evidence[0].pid, 0)).toThrow()
    rmSync(dir, { recursive: true, force: true })
  }
}
it('persists process identity before first dispatch and rejects disallowed RPC methods and excessive writes', async () => {
  await fixture('normal', async (peer, evidence) => {
    expect(evidence).toHaveLength(1)
    expect(await peer.request('initialize', {})).toMatchObject({ userAgent: 'codex/0.160.1' })
    await peer.initialized()
    await expect(peer.request('remoteControl/enable', {})).rejects.toThrow('forbidden')
    await expect(peer.request('config/read', { huge: 'x'.repeat(600 * 1024) })).rejects.toThrow(
      'write_limit'
    )
    expect(await peer.lost).toBe('codex_write_limit')
  })
})
it.each(['duplicate-response', 'invalid-utf8', 'truncated', 'duplicate-request'])(
  'stops on protocol loss %s, with confirmed cleanup',
  async (mode) => {
    await fixture(mode, async (peer) => {
      await peer.request('initialize', {})
      await peer.initialized()
      expect(await peer.lost).toMatch(/codex_(invalid|truncated|transport)/)
    })
  }
)
it.each(['timeout', 'crash'])(
  'marks unresolved requests lost on %s without retry',
  async (mode) => {
    await fixture(mode, async (peer) => {
      await peer.request('initialize', {})
      await peer.initialized()
      await expect(peer.request('config/read', {})).rejects.toThrow(/timeout|closed/)
    })
  }
)
