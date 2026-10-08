// Only the production supervised worker imports the pinned SDK/auth runtime.
import * as sdk from '@earendil-works/pi-coding-agent'
import { createSdkHost, type HostConfiguration } from './sdk-runtime.js'
import type { Ask, PiEvent } from './host.js'
import type { HostProcessHooks } from './processes.js'
export type { HostConfiguration } from './sdk-runtime.js'
export function createHost(
  config: HostConfiguration,
  ask: Ask,
  signal: AbortSignal,
  emit: (event: PiEvent) => void,
  hooks?: HostProcessHooks
) {
  return createSdkHost(sdk, config, ask, signal, emit, hooks)
}
