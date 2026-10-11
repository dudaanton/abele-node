import { expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  PairingSession,
  LocalDiscovery,
  type PairingAdapters,
  type PairingDetails,
  type PairingState,
  type DesktopRuntime,
  type LocalNode,
  type LocalRegistration,
} from '@abele/node-client'

it('exports pairing lifecycle and its adapter/state types through the SDK package name', () => {
  const adapters: PairingAdapters = {
    connector: {
      claim: async () => ({
        installation_id: 'installation-id',
        device_fingerprint: 'a'.repeat(64),
        state: 'pending',
      }),
      target: async () => ({
        profile: 'paired-wss-v1',
        url: 'wss://node.example.ts.net:8443/channel',
        expected_node_id: 'node-id',
        installation_id: 'installation-id',
        node_fingerprint: 'b'.repeat(64),
        public_key: { kty: 'EC', crv: 'P-256', x: 'a'.repeat(43), y: 'b'.repeat(43) },
      }),
    },
    createClient: () => ({ connected: false, connect: async () => {}, disconnect: async () => {} }),
  }
  const session = new PairingSession(adapters)
  const state: PairingState = session.state
  const details: PairingDetails | undefined = state.details
  expect(state.phase).toBe('paste')
  expect(details).toBeUndefined()
})
it('exports protected discovery and its native/registration adapters through the SDK package name', async () => {
  const runtime: DesktopRuntime = { fs, net, os, path, process }
  const discovery = new LocalDiscovery(false, () => runtime)
  expect(discovery.discover()).toBeUndefined()
  const node: LocalNode = {
    nodeName: 'Test node',
    nodeId: 'node-id',
    endpoint: 'ws://127.0.0.1:7777/channel',
  }
  const registration: LocalRegistration<{ expectedNodeId: string }> = {
    add: async (_label, _endpoint, _token, expectedNodeId) => ({ expectedNodeId }),
  }
  expect(await registration.add(node.nodeName, node.endpoint, 'test-token', node.nodeId)).toEqual({
    expectedNodeId: node.nodeId,
  })
})
