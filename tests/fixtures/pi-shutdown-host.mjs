// The production SDK assembly with a faithful fake SDK; never imports real SDK.
import { createSdkHost } from '../../packages/provider-pi/dist/sdk-runtime.js'
import { createSdkDouble } from './pi-sdk-double.mjs'
export function createHost(config, ask, signal, emit, hooks) {
  const { sdk } = createSdkDouble({ shutdownError: true })
  return createSdkHost(sdk, config, ask, signal, emit, hooks)
}
