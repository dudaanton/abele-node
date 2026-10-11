import { expect, it } from 'vitest'
import { pairedRouteFailure } from '../packages/node-client/src/paired.js'

const address = 'wss://alternate.example:9443/channel'
it('classifies native causes without retaining raw transport exception text', () => {
  const error = Object.assign(new Error('sensitive transport diagnostics'), {
    cause: { code: 'ERR_TLS_CERT_ALTNAME_INVALID' },
  })
  const failure = pairedRouteFailure(error, address)
  expect(failure.details).toEqual({ reason: 'tls', address })
  expect(failure.message).toBe('paired_route_tls')
  expect(JSON.stringify(failure)).not.toContain('sensitive transport diagnostics')
  expect(pairedRouteFailure({ code: 'PAIRED_HOST_NOT_ACCEPTED' }, address).reason).toBe(
    'host_not_accepted'
  )
  expect(pairedRouteFailure({ code: 'ECONNREFUSED' }, address).reason).toBe('unreachable')
})
it('reports opaque browser failures honestly instead of guessing or weakening TLS', () => {
  expect(pairedRouteFailure(new Event('error'), address).details).toEqual({
    reason: 'tls_or_unreachable',
    address,
  })
})
it.fails(
  'BUG: exact TLS classification needs a browser diagnostic bridge when WebSocket exposes only an opaque event',
  () => {
    // The underlying failure can be TLS, but the browser omits its cause. A native
    // diagnostic opener can satisfy this guarantee; browser WebSocket alone cannot.
    expect(pairedRouteFailure(new Event('error'), address).reason).toBe('tls')
  }
)
