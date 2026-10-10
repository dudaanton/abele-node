import { expect, it } from 'vitest'
import {
  processScenarioDeadline,
  waitForProcessCondition,
} from '../scripts/process-test-budget.mjs'
import { VirtualDeadlineTimers } from './deadline-timers.js'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { discoverCodex } from '../packages/provider-codex/src/discovery.js'
import { RpcPeer } from '../packages/provider-codex/src/rpc.js'

async function fixture(
  mode: string,
  test: (
    peer: RpcPeer,
    evidence: any[],
    timers: VirtualDeadlineTimers,
    requests: () => any[]
  ) => Promise<void>
) {
  const dir = mkdtempSync(resolve('.scratch/codex-rpc-'))
  writeFileSync(
    join(dir, 'fixture.json'),
    JSON.stringify({ mode, initialize_delay_ms: 200, track_requests: true })
  )
  const timers = new VirtualDeadlineTimers()
  const requests = () =>
    readFileSync(join(dir, 'request-log.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
  let peer: RpcPeer | undefined
  const evidence: any[] = []
  try {
    peer = await RpcPeer.start({
      executable: discoverCodex({ executable: resolve('tests/fixtures/codex.mjs'), fixture: true }),
      cwd: dir,
      home: dir,
      timeoutMs: 100,
      timers,
      processes: (p) => evidence.push(...p),
    })
    await test(peer, evidence, timers, requests)
  } finally {
    await peer?.close()
    if (evidence.length) expect(() => process.kill(evidence[0].pid, 0)).toThrow()
    expect(timers.pending).toBe(0)
    rmSync(dir, { recursive: true, force: true })
  }
}
it(
  'persists process identity before first dispatch and rejects disallowed RPC methods and excessive writes',
  async () => {
    await fixture('normal', async (peer, evidence, timers) => {
      expect(evidence).toHaveLength(1)
      expect(await peer.request('initialize', {})).toMatchObject({ userAgent: 'codex/0.160.1' })
      expect(timers.pending).toBe(0)
      await peer.initialized()
      await expect(peer.request('remoteControl/enable', {})).rejects.toThrow('forbidden')
      await expect(peer.request('config/read', { huge: 'x'.repeat(600 * 1024) })).rejects.toThrow(
        'write_limit'
      )
      expect(await peer.lost).toBe('codex_write_limit')
    })
  },
  processScenarioDeadline(4)
)
it.each(['duplicate-response', 'invalid-utf8', 'truncated', 'duplicate-request'])(
  'stops on protocol loss %s, with confirmed cleanup',
  async (mode) => {
    await fixture(mode, async (peer) => {
      await peer.request('initialize', {})
      await peer.initialized()
      expect(await peer.lost).toBe(
        mode === 'truncated' ? 'codex_truncated_stream' : 'codex_invalid_or_unbounded_stream'
      )
    })
  },
  processScenarioDeadline(4)
)
it.each(['timeout', 'crash'])(
  'marks unresolved requests lost on %s without retry',
  async (mode) => {
    await fixture(mode, async (peer, _evidence, timers, requests) => {
      await peer.request('initialize', {})
      await peer.initialized()
      let settled = false
      const pending = peer.request('config/read', {})
      void pending.then(
        () => {
          settled = true
        },
        () => {
          settled = true
        }
      )
      const code = mode === 'timeout' ? 'codex_rpc_timeout' : 'codex_transport_closed'
      const rejected = expect(pending).rejects.toThrow(code)
      if (mode === 'timeout') {
        // Observe fixture receipt before advancing the request budget. Cold startup,
        // scheduling and transport throughput are not what this assertion measures.
        await waitForProcessCondition(
          () => requests().some((r) => r.method === 'config/read'),
          'unanswered RPC received'
        )
        timers.advance(99)
        expect(settled).toBe(false)
        timers.advance(1)
      }
      await rejected
      expect(await peer.lost).toBe(code)
      expect(requests().filter((r) => r.method === 'config/read')).toHaveLength(1)
    })
  },
  processScenarioDeadline(4)
)
