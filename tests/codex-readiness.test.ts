import { it, expect } from 'vitest'
import { CodexProviderAdapter } from '../packages/provider-codex/src/adapter.js'
import { codexExecutionGates } from '../packages/provider-codex/src/gates.js'

class Adapter extends CodexProviderAdapter {
  report: any = {
    available: true,
    diagnostic: 'ready',
    checks: { authenticated: true, model_available: true },
  }
  constructor() {
    super({ stateDir: '/fixture/state', model: 'fixture-small' })
  }
  protected async inspect() {
    return this.report
  }
}
it('enables only after successful doctor preflight and withdraws readiness on recheck failure', async () => {
  const adapter = new Adapter()
  expect(adapter.available).toBe(false)
  await adapter.prepare()
  expect(adapter.available).toBe(true)
  adapter.report = { available: false, diagnostic: 'managed_remote_control_ban_missing' }
  await adapter.prepare()
  expect(adapter.available).toBe(false)
  expect(adapter.capabilities().diagnostic).toBe('managed_remote_control_ban_missing')
})
it.each([
  'codex_chatgpt_authentication_required',
  'codex_selected_model_required',
  'codex_selected_model_unavailable',
  'codex_schema_fingerprint_mismatch',
])('keeps the doctor error %s without execution', async (diagnostic) => {
  const adapter = new Adapter()
  adapter.report = { available: false, diagnostic }
  await adapter.prepare()
  expect(adapter.available).toBe(false)
  expect(adapter.capabilities().diagnostic).toBe(diagnostic)
})
it('leaves model selection to Codex unless explicitly overridden', () => {
  const automatic = new CodexProviderAdapter({ stateDir: '/fixture/state', enabled: false })
  expect(automatic.configuration.model).toBeNull()
  expect(automatic.capabilities()).toMatchObject({ model: 'Codex default' })
  expect(new Adapter().configuration.model).toBe('fixture-small')
})
it('honours explicit opt-out even with an executable and never runs preflight', async () => {
  const adapter = new Adapter()
  const disabled = new (class extends CodexProviderAdapter {
    protected async inspect(): Promise<never> {
      throw new Error('must_not_inspect')
    }
  })({ stateDir: '/fixture/state', enabled: false, executable: '/fixture/codex' })
  expect(await disabled.prepare()).toBe(false)
  expect(disabled.capabilities().diagnostic).toBe('codex_disabled')
  expect(adapter.available).toBe(false)
})
it('retains the doctor login command and checks in daemon status capabilities', async () => {
  const adapter = new Adapter()
  adapter.report = {
    available: false,
    diagnostic: 'codex_authentication_required',
    checks: { authenticated: false },
    login_command: 'codex login',
  }
  await adapter.prepare()
  expect(adapter.capabilities()).toMatchObject({
    checks: { authenticated: false },
    login_command: 'codex login',
  })
})
it('uses accepted sampled-inventory/marker parity, without treating live acceptance as a prerequisite', () => {
  const gates = codexExecutionGates('darwin')
  expect(gates.find((g) => g.name === 'detached_descendants')).toMatchObject({ status: 'verified' })
  expect(gates.filter((g) => g.error)).toEqual([])
  expect(gates.find((g) => g.name === 'live_acceptance')?.status).toBe('unverified')
})
