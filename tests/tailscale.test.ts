import { expect, it } from 'vitest'
import { TailscaleServeManager } from '../packages/node-daemon/src/tailscale.js'

it('refuses residual Funnel permission, foreground mappings and local-token proxies before any write', async () => {
  for (const config of [
    { AllowFunnel: { 'node.example.ts.net:8443': true } },
    { Foreground: { owner: { TCP: { '8443': { TCPForward: '127.0.0.1:9000' } } } } },
    {
      Web: {
        'other.example.ts.net:9999': {
          Handlers: { '/secret': { Proxy: 'http://127.0.0.1:7777' } },
        },
      },
    },
  ]) {
    const writes: string[][] = []
    const manager = new TailscaleServeManager(async (args) => {
      if (args.join(' ') === 'serve status --json') return JSON.stringify(config)
      if (args.join(' ') === 'status --json')
        return JSON.stringify({
          BackendState: 'Running',
          CurrentTailnet: { MagicDNSEnabled: true },
          Self: { DNSName: 'node.example.ts.net.' },
          CertDomains: ['node.example.ts.net'],
        })
      writes.push(args)
      return ''
    })
    await expect(
      manager.enable('wss://node.example.ts.net:8443/channel', 47124, 7777)
    ).rejects.toThrow()
    expect(writes).toEqual([])
  }
})

it('preserves foreign 443/80 and refuses occupied ports; removes only its owned exact mapping', async () => {
  let config: any = {
    TCP: { '443': { TCPForward: '127.0.0.1:9001' }, '80': { TCPForward: '127.0.0.1:9002' } },
  }
  const calls: string[][] = []
  const run = async (args: string[]) => {
    calls.push(args)
    if (args.join(' ') === 'serve status --json') return JSON.stringify(config)
    if (args.join(' ') === 'status --json')
      return JSON.stringify({
        BackendState: 'Running',
        CurrentTailnet: { MagicDNSEnabled: true },
        Self: { DNSName: 'node.example.ts.net.' },
        CertDomains: ['node.example.ts.net'],
      })
    if (args.includes('off')) {
      delete config.TCP['8443']
      delete config.Web['node.example.ts.net:8443']
      return ''
    }
    config.TCP['8443'] = { HTTPS: true }
    config.Web = {
      'node.example.ts.net:8443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:47124' } } },
    }
    return ''
  }
  const manager = new TailscaleServeManager(run)
  await expect(manager.enable('wss://node.example.ts.net/channel', 47124, 7777)).rejects.toThrow(
    'serve_port_occupied'
  )
  expect(calls.filter((c) => c[0] === 'serve' && c[1] !== 'status')).toHaveLength(0)
  await manager.enable('wss://node.example.ts.net:8443/channel', 47124, 7777)
  const status = await manager.doctor('wss://node.example.ts.net:8443/channel', 47124, 7777)
  expect(status.local_token_unmapped).toBe(true)
  expect(status.node_mapping).toBe(true)
  config.Web['node.example.ts.net:8443'].Handlers['/'].Proxy = 'http://127.0.0.1:8888'
  await expect(manager.disable('wss://node.example.ts.net:8443/channel', 47124)).rejects.toThrow(
    'serve_mapping_changed'
  )
  config.Web['node.example.ts.net:8443'].Handlers['/'].Proxy = 'http://127.0.0.1:47124'
  await manager.disable('wss://node.example.ts.net:8443/channel', 47124)
  expect(config.TCP['443']).toEqual({ TCPForward: '127.0.0.1:9001' })
  expect(config.TCP['80']).toEqual({ TCPForward: '127.0.0.1:9002' })
  expect(calls.flat()).not.toContain('reset')
})
