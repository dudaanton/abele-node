import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import {
  FileServeOwnershipStore,
  TailscaleServeManager,
} from '../packages/node-daemon/src/tailscale.js'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
const endpoint = 'wss://node.example.ts.net:8443/channel'
const mapping = {
  TCP: { '8443': { HTTPS: true } },
  Web: { 'node.example.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:47124' } } } },
}
function fixture() {
  const dir = mkdtempSync(resolve('.scratch/serve-ownership-'))
  dirs.push(dir)
  const path = join(dir, 'ownership.json')
  const store = new FileServeOwnershipStore(path)
  let config: object = {},
    failure: 'before_write' | 'lost_response' | 'verification' | 'off' | undefined
  const writes: string[][] = []
  const run = async (args: string[]) => {
    if (args.join(' ') === 'status --json')
      return JSON.stringify({
        BackendState: 'Running',
        CurrentTailnet: { MagicDNSEnabled: true },
        Self: { DNSName: 'node.example.ts.net.' },
        CertDomains: ['node.example.ts.net'],
      })
    if (args.join(' ') === 'serve status --json') {
      if (failure === 'verification' && writes.length) throw new Error('status_unavailable')
      return JSON.stringify(config)
    }
    writes.push(args)
    if (args.includes('off')) {
      if (failure === 'off') throw new Error('off_response_lost')
      config = {}
      return ''
    }
    if (failure === 'before_write') throw new Error('cli_failed')
    config = mapping
    if (failure === 'lost_response') throw new Error('response_lost')
    return ''
  }
  return {
    path,
    store,
    run,
    writes,
    setConfig: (value: object) => {
      config = value
    },
    fail: (value: typeof failure) => {
      failure = value
    },
  }
}
it.each(['before_write', 'lost_response', 'verification'] as const)(
  'uncertain enable (%s) never confers deletion rights, including after restart',
  async (failure) => {
    const f = fixture(),
      manager = new TailscaleServeManager(f.run, f.store)
    f.fail(failure)
    await expect(manager.enable(endpoint, 47124, 7777)).rejects.toThrow()
    expect(JSON.parse(readFileSync(f.path, 'utf8')).state).toBe('pending')
    f.fail(undefined)
    // Sequential external administrator action, not a concurrent writer race.
    f.setConfig(mapping)
    const restarted = new TailscaleServeManager(f.run, new FileServeOwnershipStore(f.path))
    await expect(restarted.disable(endpoint, 47124)).rejects.toThrow('serve_ownership_uncertain')
    await expect(restarted.enable(endpoint, 47124, 7777)).rejects.toThrow()
    expect(f.writes.filter((args) => args.includes('off'))).toHaveLength(0)
  }
)
it('only successful CLI plus verified mapping confirms ownership; a fresh retry on an empty port is allowed', async () => {
  const f = fixture(),
    manager = new TailscaleServeManager(f.run, f.store)
  f.fail('before_write')
  await expect(manager.enable(endpoint, 47124, 7777)).rejects.toThrow()
  f.fail(undefined)
  await manager.enable(endpoint, 47124, 7777)
  expect(JSON.parse(readFileSync(f.path, 'utf8')).state).toBe('confirmed')
  await new TailscaleServeManager(f.run, new FileServeOwnershipStore(f.path)).disable(
    endpoint,
    47124
  )
  expect(f.writes.filter((args) => args.includes('off'))).toHaveLength(1)
})
it('legacy ownership without a confirmation state cannot authorize deletion', async () => {
  const f = fixture()
  writeFileSync(f.path, JSON.stringify({ endpoint, backend_port: 47124 }))
  f.setConfig(mapping)
  await expect(new TailscaleServeManager(f.run, f.store).disable(endpoint, 47124)).rejects.toThrow(
    'serve_ownership_uncertain'
  )
  expect(f.writes).toEqual([])
})
it('uncertain removal does not retain deletion rights over a subsequently recreated mapping', async () => {
  const f = fixture(),
    manager = new TailscaleServeManager(f.run, f.store)
  await manager.enable(endpoint, 47124, 7777)
  f.fail('off')
  await expect(manager.disable(endpoint, 47124)).rejects.toThrow('off_response_lost')
  f.fail(undefined)
  f.setConfig(mapping)
  await expect(new TailscaleServeManager(f.run, f.store).disable(endpoint, 47124)).rejects.toThrow(
    'serve_ownership_uncertain'
  )
  expect(f.writes.filter((args) => args.includes('off'))).toHaveLength(1)
})
