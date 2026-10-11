import { expect, it } from 'vitest'
import {
  NodeClient,
  NodePathClient,
  MemoryClientStore,
  PairingSession,
  LocalDiscovery,
} from '@abele/node-client'
it('exports node-path and pairing/discovery helpers together from the public client package', () => {
  expect(PairingSession).toBeTypeOf('function')
  expect(LocalDiscovery).toBeTypeOf('function')
  expect(NodePathClient).toBeTypeOf('function')
  const client = new NodeClient(
    { url: 'ws://127.0.0.1:7777/channel', profile: 'local-token-v1', token: 'a'.repeat(64) },
    new MemoryClientStore()
  )
  expect(client.nodePath).toBeInstanceOf(NodePathClient)
})
